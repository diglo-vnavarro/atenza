// Sincronización INCREMENTAL e IDEMPOTENTE de tickets SDP → Atenza (Firestore),
// para la fase de CONVIVENCIA (los técnicos siguen trabajando en SDP; Atenza
// refleja el estado). Reejecutable sin efectos colaterales:
//
//   - upsert por id de SDP (doc id estable) → no duplica.
//   - SDP es la fuente de verdad de los campos del ticket (asunto, estado,
//     prioridad, solicitante/técnico, grupo, categoría…): se sobrescriben.
//   - los campos que SOLO existen en Atenza (colaboración añadida en el portal)
//     se PRESERVAN: worklog, tasks, approvals, attachments, comments, resolution.
//   - reconcilia identidades con importer/identity-map.json (uid SDP → uid Firebase)
//     y NO recrea el miembro de referencia de SDP cuando ya está mapeado
//     (evita el gotcha de deshacer la fusión de identidad al re-sincronizar).
//
//   GOOGLE_APPLICATION_CREDENTIALS=<adc> GOOGLE_CLOUD_PROJECT=diglo-desk-pd \
//   TENANT=diglo-it npx tsx scripts/sync-tickets.ts
//
// Modo previsualización (NO escribe nada; solo lee y reporta qué cambiaría):
//   ...  DRY_RUN=1 npx tsx scripts/sync-tickets.ts     (o pasar --dry-run)
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { isArchivedStatus } from '../src/model.js';
import type { OwnerSegment } from '../src/model.js';
import { reconcileOwner } from '../src/owner.js';
import { planRoster, type RosterRow } from './lib/roster-resolve.js';
import { getStorage } from 'firebase-admin/storage';
import { loadZoho, zohoRefresh, sdpGet, attachmentsOf, fetchAndUpload, type AttRec } from './lib/sdp-attachments.js';

const here = dirname(fileURLToPath(import.meta.url));
const importer = join(here, '..', 'importer');
const { tickets, members } = JSON.parse(readFileSync(join(importer, 'imported-tickets.json'), 'utf8')) as {
  tickets: Record<string, unknown>[]; members: Record<string, unknown>[];
};
// Mapa de identidad: de env IDENTITY_MAP_JSON (Cloud Run) si está, si no del
// fichero importer/identity-map.json (uso local). Se ignoran claves con "_".
const rawMap: Record<string, string> = process.env.IDENTITY_MAP_JSON
  ? JSON.parse(process.env.IDENTITY_MAP_JSON)
  : (() => { const p = join(importer, 'identity-map.json'); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {}; })();
const idMap: Record<string, string> = Object.fromEntries(Object.entries(rawMap).filter(([k]) => !k.startsWith('_')));
const TENANT = process.env.TENANT ?? 'diglo-it';
const DRY = process.env.DRY_RUN === '1' || process.argv.includes('--dry-run');
// Plantilla forzada por tipo (instancias cuyos tickets no traen la plantilla de
// Atenza; p. ej. Leasys → tpl-leasys-inc/sr para que resuelvan su ciclo de vida).
const FT_INC = process.env.TEMPLATE_INC, FT_SR = process.env.TEMPLATE_SR;

initializeApp({ projectId: process.env.GOOGLE_CLOUD_PROJECT ?? 'diglo-desk-pd' });
const db = getFirestore();

// Campos propiedad de Atenza que NUNCA se pisan al re-sincronizar desde SDP.
// Incluye lo de la migración al modo simplificado (serviceCategoryId/serviceCategory/
// type) para NO deshacer F4c. `archived`/`createdAt` se recalculan aparte (abajo).
const ATENZA_OWNED = ['worklog', 'tasks', 'approvals', 'attachments', 'comments', 'resolution', 'serviceCategoryId', 'serviceCategory', 'type'] as const;
const remap = (uid: unknown) => (typeof uid === 'string' && idMap[uid]) ? idMap[uid] : uid;
// AUTO-CATEGORIZADO: mapa plantilla SDP → nombre de categoría de servicio
// (generado por scripts/gen-template-cat-map.ts desde el snapshot). Los tickets
// que llegan de SDP SIN categoría se asignan por su templateId; el resto → default.
const tplCatMap: Record<string, string> = (() => { const p = join(importer, 'template-category-map.json'); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {}; })();
const DEFAULT_CAT = 'Incidencias generales';
// ROSTER destino (hoja «Grupos» del Excel) → «traducción» de membresías a la verdad Atenza.
const ROSTER: RosterRow[] = (() => { const p = join(importer, 'roster-v2.json'); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : []; })();
const GROUP_ALIAS: Record<string, string> = { 'Técnicos IT': 'IT' };
type Cat = { id: string; name: string; incident?: unknown; service_request?: unknown };

async function syncTickets() {
  let created = 0, updated = 0, preserved = 0, remapped = 0, autoCat = 0;
  // catálogo de categorías de servicio del tenant (para resolver nombre → id + tipo)
  const cats = (((await db.doc(`tenants/${TENANT}`).get()).data()?.serviceCategories) ?? []) as Cat[];
  const catByName = new Map(cats.map((c) => [c.name, c]));
  const catOf = (tplId: string): Cat | undefined => catByName.get(tplCatMap[tplId] ?? DEFAULT_CAT) ?? catByName.get(DEFAULT_CAT);
  const typeOf = (cat: Cat, cur?: string): 'incident' | 'service_request' => { const ty = (cur ?? 'incident') as 'incident' | 'service_request'; if (cat[ty]) return ty; return cat.incident ? 'incident' : 'service_request'; };
  for (let i = 0; i < tickets.length; i += 200) {
    const slice = tickets.slice(i, i + 200);
    const refs = slice.map((t) => db.doc(`tenants/${TENANT}/tickets/${t.id}`));
    const snaps = await db.getAll(...refs);
    const batch = db.batch();
    slice.forEach((t, j) => {
      const snap = snaps[j]!;
      const prev = (snap.exists ? snap.data() : {}) as Record<string, unknown>;
      const tech = remap(t.technicianId), reqr = remap(t.requesterId);
      if (tech !== t.technicianId || reqr !== t.requesterId) remapped++;
      const next: Record<string, unknown> = { ...t, requesterId: reqr, technicianId: tech, sdpId: t.id, syncedAt: Date.now() };
      if (FT_INC || FT_SR) next.templateId = (next.type === 'service_request' ? FT_SR : FT_INC) ?? next.templateId;
      for (const f of ATENZA_OWNED) if (prev[f] !== undefined) { next[f] = prev[f]; preserved++; } // preserva lo añadido en Atenza
      // AUTO-CATEGORIZADO: si sigue sin categoría (ticket nuevo de SDP), se asigna
      // por su plantilla; NO pisa la de los tickets ya categorizados (arriba se preserva).
      if (!next.serviceCategoryId) { const cat = catOf(String(t.templateId ?? '')); if (cat) { next.serviceCategoryId = cat.id; next.serviceCategory = cat.name; next.type = typeOf(cat, next.type as string); autoCat++; } }
      // archived se DERIVA del estado (SDP es fuente de verdad); createdAt se conserva.
      next.archived = isArchivedStatus(next.status as string);
      next.createdAt = (prev.createdAt as number | undefined) ?? (t.statusHistory as { from?: number }[] | undefined)?.[0]?.from ?? Date.now();
      // Histórico de PROPIEDAD: siembra en la 1ª sync y añade segmento si SDP reasignó
      // (cambio de grupo/técnico). Así se construye el histórico durante la convivencia.
      next.ownerHistory = reconcileOwner(prev.ownerHistory as OwnerSegment[] | undefined,
        { group: (next.groupId as string | null) ?? null, tech: (next.technicianId as string | null) ?? null },
        Date.now(), next.createdAt as number);
      if (!DRY) batch.set(refs[j]!, next); // set completo pero con los campos Atenza reinyectados
      if (snap.exists) updated++; else created++;
    });
    if (!DRY) await batch.commit();
  }
  console.log(`${DRY ? '[DRY] ' : ''}tickets: ${created} nuevos, ${updated} actualizados · ${preserved} campos Atenza preservados · ${autoCat} auto-categorizados · ${remapped} identidades remapeadas.`);
}

// Campos de miembro que SON DECISIÓN DE ATENZA (rol/permisos/alta), no de SDP:
// si el doc ya existe con estos valores, NO se pisan al re-sincronizar (si no,
// el sync degradaría a «technician» a quien un admin hubiera ascendido, p. ej.).
const MEMBER_OWNED = ['role', 'roleName', 'enabled', 'caps'] as const;

async function syncMembers() {
  // Solo miembros de referencia que NO estén mapeados a una cuenta real.
  const ref = members.filter((m) => !idMap[m.uid as string]);
  let n = 0, preserved = 0; const skipped = members.length - ref.length;
  for (let i = 0; i < ref.length; i += 300) {
    const slice = ref.slice(i, i + 300);
    const refs = slice.map((m) => db.doc(`tenants/${TENANT}/members/${m.uid}`));
    const snaps = await db.getAll(...refs);
    const batch = db.batch();
    slice.forEach((m, j) => {
      const prev = (snaps[j]!.exists ? snaps[j]!.data() : {}) as Record<string, unknown>;
      const next = { ...m } as Record<string, unknown>;
      for (const f of MEMBER_OWNED) if (prev[f] !== undefined) { next[f] = prev[f]; preserved++; } // no degradar rol/permisos fijados en Atenza
      if (!DRY) batch.set(refs[j]!, next, { merge: true }); n++;
    });
    if (!DRY) await batch.commit();
  }
  console.log(`${DRY ? '[DRY] ' : ''}members: ${n} de referencia (merge) · ${preserved} campos de rol/permiso preservados · ${skipped} omitidos por estar en el mapa de identidad.`);
}

// Cifras de cabecera para el PANEL DE PLATAFORMA (Fase 1.4): se estampan en el
// doc del tenant al terminar el sync, por conteo de agregación (barato, no lee
// los ~23k del archivo). Mejor esfuerzo: si falla, no rompe el sync.
async function stampSummary() {
  try {
    const tk = db.collection(`tenants/${TENANT}/tickets`);
    const [act, arch, mem] = await Promise.all([
      tk.where('archived', '==', false).count().get(),
      tk.where('archived', '==', true).count().get(),
      db.collection(`tenants/${TENANT}/members`).count().get(),
    ]);
    const summary = {
      ticketsActive: act.data().count,
      ticketsArchived: arch.data().count,
      members: mem.data().count,
      lastSyncAt: Date.now(),
      lastSyncStatus: 'ok' as const,
    };
    if (!DRY) await db.doc(`tenants/${TENANT}`).set({ summary }, { merge: true });
    console.log(`${DRY ? '[DRY] ' : ''}summary: ${summary.ticketsActive} activos · ${summary.ticketsArchived} archivo · ${summary.members} personas · lastSyncAt=${summary.lastSyncAt}`);
  } catch (e) {
    console.error('summary: no se pudo estampar (no crítico):', (e as Error).message);
  }
}

// Completa el idMap con la subcolección Firestore tenants/{tid}/idmap (fuente de verdad
// editable sin tocar Cloud Run). Debe correr ANTES de syncMembers (para omitir duplicados).
async function loadIdmapFromFirestore() {
  const s = await db.collection(`tenants/${TENANT}/idmap`).get();
  let added = 0;
  s.forEach((d) => { const uid = d.data().uid as string | undefined; if (uid && !idMap[d.id]) { idMap[d.id] = uid; added++; } });
  if (added) console.log(`idmap: +${added} de Firestore (total ${Object.keys(idMap).length}).`);
}

// TRADUCCIÓN de membresías: tras sincronizar los miembros desde SDP, deja cada grupo con el
// roster destino del Excel (verdad Atenza). Así el reparto no lo revierte la sync.
async function applyRoster() {
  if (!ROSTER.length) return;
  const groups = (await db.collection(`tenants/${TENANT}/groups`).get()).docs.map((d) => ({ id: d.id, name: String(d.data().name ?? '') }));
  const members = (await db.collection(`tenants/${TENANT}/members`).get()).docs
    .map((d) => ({ uid: d.id, name: String(d.data().name ?? ''), email: String(d.data().email ?? ''), status: d.data().status as string, groupIds: (d.data().groupIds ?? []) as string[] }))
    .filter((m) => m.status === 'active');
  const plan = planRoster(ROSTER, groups, members, GROUP_ALIAS);
  if (plan.unmatched.length) { console.log(`${DRY ? '[DRY] ' : ''}roster: ${plan.unmatched.length} nombres SIN RESOLVER → NO se aplica (revisar idmap): ${plan.unmatched.slice(0, 6).map((u) => u.name).join(', ')}…`); return; }
  if (!plan.perMember.size) { console.log(`${DRY ? '[DRY] ' : ''}roster: ya alineado (0 cambios).`); return; }
  let batch = db.batch(), n = 0;
  for (const [uid, e] of plan.perMember) {
    const m = members.find((x) => x.uid === uid)!;
    const next = new Set(m.groupIds); for (const g of e.add) next.add(g); for (const g of e.rem) next.delete(g);
    if (!DRY) { batch.update(db.doc(`tenants/${TENANT}/members/${uid}`), { groupIds: [...next] }); if (++n % 200 === 0) { await batch.commit(); batch = db.batch(); } } else n++;
  }
  if (!DRY) await batch.commit();
  console.log(`${DRY ? '[DRY] ' : ''}roster: ${plan.addN} altas · ${plan.remN} bajas · ${plan.perMember.size} miembros alineados a la verdad Atenza.`);
}

// M1 — ADJUNTOS NUEVOS en la sync: para los tickets del lote con adjuntos (has_attachments) que
// aún no los tengan en Atenza, descarga de SDP y sube a Storage. Idempotente (salta los que ya
// tienen adjuntos «sdp-» → sin llamada a SDP). Desactivable con SYNC_ATTACHMENTS=0.
async function syncAttachments(): Promise<void> {
  if (process.env.SYNC_ATTACHMENTS === '0') return;
  const withA = tickets.filter((t) => (t as { has_attachments?: boolean }).has_attachments && (t as { sdpRid?: string }).sdpRid);
  if (!withA.length) { console.log(`${DRY ? '[DRY] ' : ''}attachments: 0 tickets con adjuntos en el lote.`); return; }
  const z = loadZoho(); await zohoRefresh(z);
  const bucket = getStorage().bucket(process.env.BUCKET ?? 'diglo-desk-pd-atenza-files');
  let done = 0, skipped = 0, errors = 0;
  for (const t of withA) {
    const docId = String((t as { id: string }).id); const rid = String((t as { sdpRid: string }).sdpRid);
    const ref = db.doc(`tenants/${TENANT}/tickets/${docId}`);
    const snap = await ref.get();
    if (!snap.exists) { skipped++; continue; }
    const cur = snap.data() as { attachments?: AttRec[] };
    if ((cur.attachments ?? []).some((a) => String(a.id).startsWith('sdp-'))) { skipped++; continue; } // ya migrado → sin SDP
    try {
      const atts = attachmentsOf((await sdpGet(z, `requests/${rid}`)).request as Record<string, unknown> ?? {});
      if (!atts.length) { skipped++; continue; }
      if (DRY) { done++; continue; }
      const recs = await fetchAndUpload(z, bucket, TENANT, docId, rid, atts, Date.now());
      await ref.set({ attachments: [...(cur.attachments ?? []), ...recs] }, { merge: true });
      done++;
    } catch (e) { errors++; console.error(`  x adj ${docId}: ${(e as Error).message}`); }
  }
  console.log(`${DRY ? '[DRY] ' : ''}attachments: ${done} tickets con adjuntos nuevos · ${skipped} sin cambios · ${errors} err.`);
}

async function main() {
  console.log(`${DRY ? '=== DRY-RUN (no escribe nada) === ' : ''}Sync SDP → Atenza · tenant ${TENANT} · ${tickets.length} tickets · ${Object.keys(idMap).length} identidades mapeadas.`);
  await loadIdmapFromFirestore();
  await syncMembers();
  await applyRoster();
  await syncTickets();
  await syncAttachments();
  await stampSummary();
  if (DRY) console.log('DRY-RUN completado: NADA se escribió. Quita DRY_RUN para aplicar.');
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
