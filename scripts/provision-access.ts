// Provisiona el ACCESO de los usuarios que ya han iniciado sesión (Google/email)
// pero cuya ficha de miembro está keyed por el id de SDP, no por su uid de Firebase.
//
// Para cada usuario de Firebase Auth cuyo email coincide con un miembro del tenant:
//   1. UNIFICA su ficha bajo el uid REAL de Firebase (fusiona groupIds de duplicados).
//   2. REASIGNA sus tickets (technicianId/requesterId) del id viejo → uid real.
//   3. Borra las fichas duplicadas (ids viejos), guardando el mapa id-viejo → uid en
//      `tenants/{tid}/idmap/{oldId}` para que la IMPORTACIÓN futura del histórico de
//      SDP atribuya esos tickets al uid unificado (ver scripts/load-tickets.ts).
//   4. Escribe userTenants/{uid} y mueve la capacidad.
//
// Idempotente: a quien ya está unificado + con userTenants lo salta.
// Dry-run por defecto; escribe solo con APPLY=1.
//
//   GOOGLE_APPLICATION_CREDENTIALS=<adc> GOOGLE_CLOUD_PROJECT=diglo-desk-pd \
//   TENANT=diglo-it [APPLY=1] npx tsx scripts/provision-access.ts
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT ?? 'diglo-desk-pd';
const TENANT = process.env.TENANT ?? 'diglo-it';
const APPLY = process.env.APPLY === '1';
const app = initializeApp({ projectId: PROJECT, credential: applicationDefault() });
const db = getFirestore();

type Member = { docId: string; uid?: string; email?: string; name?: string; role?: string; status?: string; groupIds?: string[]; external?: boolean; [k: string]: unknown };

// Lista usuarios de Firebase Auth vía REST (identitytoolkit accounts:query) con el
// proyecto y quota-project EXPLÍCITOS: el Admin SDK resuelve el proyecto por la
// credencial ADC (que apunta a otro proyecto) y da 403; el REST no.
async function allAuthUsers() {
  const tok = await (app.options.credential as { getAccessToken(): Promise<{ access_token: string }> }).getAccessToken();
  const out: { uid: string; email: string }[] = [];
  let offset = 0; const limit = 500;
  for (;;) {
    const r = await fetch(`https://identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok.access_token}`, 'x-goog-user-project': PROJECT, 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: String(limit), offset: String(offset), returnUserInfo: true }),
    });
    if (!r.ok) throw new Error(`accounts:query ${r.status}: ${await r.text()}`);
    const j = await r.json() as { userInfo?: { localId: string; email?: string }[] };
    const batch = j.userInfo ?? [];
    for (const u of batch) if (u.email) out.push({ uid: u.localId, email: u.email.toLowerCase() });
    if (batch.length < limit) break;
    offset += limit;
  }
  return out;
}

async function main() {
  console.log(`\n== Provisión de acceso · tenant ${TENANT} · ${APPLY ? 'APLICAR' : 'DRY-RUN'} ==\n`);

  const authUsers = await allAuthUsers();
  const memSnap = await db.collection(`tenants/${TENANT}/members`).get();
  const members: Member[] = memSnap.docs.map((d) => ({ docId: d.id, ...(d.data() as object) }));
  const byEmail = new Map<string, Member[]>();
  for (const m of members) {
    const e = (m.email ?? '').toLowerCase();
    if (!e) continue;
    if (!byEmail.has(e)) byEmail.set(e, []);
    byEmail.get(e)!.push(m);
  }

  // uid real ya presente en userTenants (para saltar a quien ya tiene acceso)
  const utSnap = await db.collection('userTenants').get();
  const hasUT = new Set(utSnap.docs.filter((d) => (d.data().tenantIds ?? []).includes(TENANT)).map((d) => d.id));

  // Plan de unificación: oldId → uid (para reasignar tickets en bloque)
  const remap = new Map<string, string>();
  const plans: { uid: string; email: string; source: Member; oldIds: string[] }[] = [];

  for (const { uid, email } of authUsers) {
    const mems = byEmail.get(email);
    if (!mems || mems.length === 0) continue; // sin ficha → requiere invitación (fuera de alcance)
    const oldIds = mems.map((m) => m.docId).filter((id) => id !== uid);
    const alreadyUnified = mems.some((m) => m.docId === uid);
    if (alreadyUnified && oldIds.length === 0 && hasUT.has(uid)) continue; // ya OK
    // Fuente = miembro más rico (prefiere el que tenga groupIds; si no, el primero).
    const source = [...mems].sort((a, b) => (b.groupIds?.length ?? 0) - (a.groupIds?.length ?? 0))[0]!;
    const groupIds = [...new Set(mems.flatMap((m) => m.groupIds ?? []))];
    plans.push({ uid, email, source: { ...source, groupIds }, oldIds });
    for (const oid of oldIds) remap.set(oid, uid);
  }

  if (plans.length === 0) { console.log('Nada que provisionar: todos los que han entrado ya tienen acceso.'); return; }

  console.log(`Usuarios a provisionar: ${plans.length}`);
  for (const p of plans) console.log(`  · ${p.email}  →  uid ${p.uid}  (fusiona ${p.oldIds.length ? p.oldIds.join(', ') : '—'}; grupos: ${(p.source.groupIds ?? []).join(', ') || 'ninguno'})`);

  // Tickets afectados (reasignación technicianId/requesterId)
  const tkSnap = await db.collection(`tenants/${TENANT}/tickets`).get();
  let tkTech = 0, tkReq = 0;
  const tkUpdates: { id: string; patch: Record<string, string> }[] = [];
  for (const d of tkSnap.docs) {
    const t = d.data() as { technicianId?: string; requesterId?: string };
    const patch: Record<string, string> = {};
    if (t.technicianId && remap.has(t.technicianId)) { patch.technicianId = remap.get(t.technicianId)!; tkTech++; }
    if (t.requesterId && remap.has(t.requesterId)) { patch.requesterId = remap.get(t.requesterId)!; tkReq++; }
    if (Object.keys(patch).length) tkUpdates.push({ id: d.id, patch });
  }
  console.log(`Tickets a reasignar: ${tkUpdates.length} (técnico: ${tkTech}, solicitante: ${tkReq})`);

  if (!APPLY) { console.log('\n(DRY-RUN) No se ha escrito nada. Repite con APPLY=1 para aplicar.\n'); return; }

  // --- Escritura ---
  const tenantRef = db.doc(`tenants/${TENANT}`);
  const capSnap = await tenantRef.get();
  const capacity: Record<string, unknown> = (capSnap.data()?.capacity ?? {}) as Record<string, unknown>;

  for (const p of plans) {
    // 1. ficha unificada keyed por uid real
    const doc: Record<string, unknown> = { ...p.source, uid: p.uid, status: 'active' };
    delete (doc as { docId?: string }).docId;
    await db.doc(`tenants/${TENANT}/members/${p.uid}`).set(doc, { merge: true });
    // 2. idmap + borrar duplicados + mover capacidad
    for (const oid of p.oldIds) {
      await db.doc(`tenants/${TENANT}/idmap/${oid}`).set({ uid: p.uid, email: p.email });
      await db.doc(`tenants/${TENANT}/members/${oid}`).delete();
      if (capacity[oid] && !capacity[p.uid]) capacity[p.uid] = capacity[oid];
      delete capacity[oid];
    }
    // 3. acceso
    await db.doc(`userTenants/${p.uid}`).set({ tenantIds: FieldValue.arrayUnion(TENANT) }, { merge: true });
    console.log(`  ✓ ${p.email} provisionado`);
  }

  // 4. reasignar tickets (batches de 400)
  for (let i = 0; i < tkUpdates.length; i += 400) {
    const batch = db.batch();
    for (const u of tkUpdates.slice(i, i + 400)) batch.set(db.doc(`tenants/${TENANT}/tickets/${u.id}`), u.patch, { merge: true });
    await batch.commit();
  }
  console.log(`  ✓ ${tkUpdates.length} tickets reasignados`);

  await tenantRef.set({ capacity }, { merge: true });
  console.log('\nProvisión completada.\n');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
