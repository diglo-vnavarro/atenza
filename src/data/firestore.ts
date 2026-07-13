// ============================================================================
// Proveedor de datos Firestore — modelo GRANULAR multi-tenant que respeta
// firestore.rules:
//   tenants/{tid}                      { name, key, active, categories, capacity }
//   tenants/{tid}/members/{uid}        UiMember
//   tenants/{tid}/tickets/{id}         StoredTicket
//   tenants/{tid}/lifecycles/{id}      Lifecycle
//   tenants/{tid}/templates/{id}       Template
//   tenants/{tid}/slas/{id}            Sla
//   tenants/{tid}/groups/{id}          Group
//   userTenants/{uid}                  { tenantIds: string[] }
//   platformAdmins/{uid}               { email }
//
// firebase/firestore se importa de forma perezosa (no engorda el bundle local).
// El store llama a estas funciones solo en modo nube (firebaseEnabled).
// ============================================================================
import { getFirebaseApp } from '../firebase.js';
import type { Lifecycle, Template, Sla } from '../model.js';
import type { TenantData, UiMember, Group, StoredTicket, Capacity } from './seed.js';

let _fs: Awaited<ReturnType<typeof loadFs>> | null = null;
async function loadFs() {
  const app = getFirebaseApp()!;
  const m = await import('firebase/firestore');
  return { m, db: m.getFirestore(app) };
}
async function fs() { return (_fs ??= await loadFs()); }

// ---- config del tenant que vive en el doc raíz ----
interface TenantDoc { name: string; key: string; active: boolean; categories: string[]; capacity: Record<string, Capacity> }

/** Siembra (o sobrescribe) todas las colecciones de un tenant a partir de un
 *  TenantData local. Lo ejecuta el superadmin una sola vez para migrar a la nube. */
export async function seedTenantToFirestore(t: TenantData): Promise<void> {
  const { m, db } = await fs();
  const batch = m.writeBatch(db);
  const tRef = m.doc(db, 'tenants', t.id);
  const tdoc: TenantDoc = { name: t.name, key: t.key, active: t.active, categories: t.categories, capacity: t.capacity };
  batch.set(tRef, tdoc);
  for (const mem of t.members) batch.set(m.doc(db, `tenants/${t.id}/members`, mem.uid), mem);
  for (const tk of t.tickets) batch.set(m.doc(db, `tenants/${t.id}/tickets`, tk.id), tk);
  for (const lc of t.lifecycles) batch.set(m.doc(db, `tenants/${t.id}/lifecycles`, lc.id ?? m.doc(m.collection(db, 'x')).id), lc);
  for (const tp of t.templates) batch.set(m.doc(db, `tenants/${t.id}/templates`, tp.id), tp);
  for (const s of t.slas) batch.set(m.doc(db, `tenants/${t.id}/slas`, s.id), s);
  for (const g of t.groups) batch.set(m.doc(db, `tenants/${t.id}/groups`, g.id), g);
  await batch.commit();
}

/** Marca a un usuario como miembro-índice (userTenants) — solo superadmin. */
export async function addUserTenant(uid: string, tenantId: string): Promise<void> {
  const { m, db } = await fs();
  await m.setDoc(m.doc(db, 'userTenants', uid), { tenantIds: m.arrayUnion(tenantId) }, { merge: true });
}

/** Lee los tenants a los que pertenece el usuario (índice userTenants). */
export async function getUserTenantIds(uid: string): Promise<string[]> {
  const { m, db } = await fs();
  const snap = await m.getDoc(m.doc(db, 'userTenants', uid));
  return (snap.exists() ? (snap.data().tenantIds as string[]) : []) ?? [];
}

/** ¿Es superadmin de plataforma? */
export async function isPlatformAdmin(uid: string): Promise<boolean> {
  const { m, db } = await fs();
  return (await m.getDoc(m.doc(db, 'platformAdmins', uid))).exists();
}

export type Unsub = () => void;

/** Suscribe en tiempo real a todas las colecciones de un tenant y ensambla un
 *  TenantData; llama a `onData` en cada cambio. Devuelve función de desuscripción.
 *  El técnico/admin ve todos los tickets; el solicitante solo los suyos (las
 *  reglas filtran el `get`; para la lista se pasa `requesterId` y se consulta acotado). */
export async function subscribeTenant(tid: string, requesterFilterUid: string | null, onData: (t: TenantData) => void): Promise<Unsub> {
  const { m, db } = await fs();
  const acc: Partial<TenantData> & { id: string } = {
    id: tid, members: [], tickets: [], lifecycles: [], templates: [], slas: [], groups: [], categories: [], capacity: {},
    name: tid, key: tid, active: true, counter: 1000,
  };
  const emit = () => onData(acc as TenantData);
  const col = (name: string) => m.collection(db, `tenants/${tid}/${name}`);
  const subs: Unsub[] = [];

  subs.push(m.onSnapshot(m.doc(db, 'tenants', tid), (d) => {
    const t = d.data() as TenantDoc | undefined;
    if (t) { acc.name = t.name; acc.key = t.key; acc.active = t.active; acc.categories = t.categories ?? []; acc.capacity = t.capacity ?? {}; }
    emit();
  }));
  subs.push(m.onSnapshot(col('members'), (s) => { acc.members = s.docs.map((d) => d.data() as UiMember); emit(); }));
  subs.push(m.onSnapshot(col('lifecycles'), (s) => { acc.lifecycles = s.docs.map((d) => d.data() as Lifecycle); emit(); }));
  subs.push(m.onSnapshot(col('templates'), (s) => { acc.templates = s.docs.map((d) => d.data() as Template); emit(); }));
  subs.push(m.onSnapshot(col('slas'), (s) => { acc.slas = s.docs.map((d) => d.data() as Sla); emit(); }));
  subs.push(m.onSnapshot(col('groups'), (s) => { acc.groups = s.docs.map((d) => d.data() as Group); emit(); }));

  // tickets: técnico/admin => todos; solicitante => solo los suyos (consulta acotada)
  const tq = requesterFilterUid
    ? m.query(col('tickets'), m.where('requesterId', '==', requesterFilterUid))
    : col('tickets');
  subs.push(m.onSnapshot(tq, (s) => { acc.tickets = s.docs.map((d) => ({ ...(d.data() as StoredTicket), id: d.id })); emit(); }));

  return () => subs.forEach((u) => u());
}

// ---- escrituras por entidad (fluyen de vuelta por las subscripciones) ----
export async function writeTicket(tid: string, t: StoredTicket): Promise<void> {
  const { m, db } = await fs();
  await m.setDoc(m.doc(db, `tenants/${tid}/tickets`, t.id), t);
}
export async function patchTicket(tid: string, id: string, patch: Partial<StoredTicket>): Promise<void> {
  const { m, db } = await fs();
  await m.updateDoc(m.doc(db, `tenants/${tid}/tickets`, id), patch as Record<string, unknown>);
}
export async function writeLifecycle(tid: string, lc: Lifecycle): Promise<void> {
  const { m, db } = await fs();
  await m.setDoc(m.doc(db, `tenants/${tid}/lifecycles`, lc.id!), lc);
}
export async function removeLifecycleDoc(tid: string, lcId: string): Promise<void> {
  const { m, db } = await fs();
  await m.deleteDoc(m.doc(db, `tenants/${tid}/lifecycles`, lcId));
}
export async function writeTemplate(tid: string, tp: Template): Promise<void> {
  const { m, db } = await fs();
  await m.setDoc(m.doc(db, `tenants/${tid}/templates`, tp.id), tp);
}
export async function patchTenantDoc(tid: string, patch: Partial<TenantDoc>): Promise<void> {
  const { m, db } = await fs();
  await m.setDoc(m.doc(db, 'tenants', tid), patch, { merge: true });
}
