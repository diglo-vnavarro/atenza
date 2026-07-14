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
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const here = dirname(fileURLToPath(import.meta.url));
const importer = join(here, '..', 'importer');
const { tickets, members } = JSON.parse(readFileSync(join(importer, 'imported-tickets.json'), 'utf8')) as {
  tickets: Record<string, unknown>[]; members: Record<string, unknown>[];
};
const mapPath = join(importer, 'identity-map.json');
const idMap: Record<string, string> = existsSync(mapPath)
  ? Object.fromEntries(Object.entries(JSON.parse(readFileSync(mapPath, 'utf8')) as Record<string, string>).filter(([k]) => !k.startsWith('_')))
  : {};
const TENANT = process.env.TENANT ?? 'diglo-it';

initializeApp({ projectId: process.env.GOOGLE_CLOUD_PROJECT ?? 'diglo-desk-pd' });
const db = getFirestore();

// Campos propiedad de Atenza que NUNCA se pisan al re-sincronizar desde SDP.
const ATENZA_OWNED = ['worklog', 'tasks', 'approvals', 'attachments', 'comments', 'resolution'] as const;
const remap = (uid: unknown) => (typeof uid === 'string' && idMap[uid]) ? idMap[uid] : uid;

async function syncTickets() {
  let created = 0, updated = 0;
  for (let i = 0; i < tickets.length; i += 200) {
    const slice = tickets.slice(i, i + 200);
    const refs = slice.map((t) => db.doc(`tenants/${TENANT}/tickets/${t.id}`));
    const snaps = await db.getAll(...refs);
    const batch = db.batch();
    slice.forEach((t, j) => {
      const snap = snaps[j]!;
      const prev = (snap.exists ? snap.data() : {}) as Record<string, unknown>;
      const next: Record<string, unknown> = { ...t, requesterId: remap(t.requesterId), technicianId: remap(t.technicianId), sdpId: t.id, syncedAt: Date.now() };
      for (const f of ATENZA_OWNED) if (prev[f] !== undefined) next[f] = prev[f]; // preserva lo añadido en Atenza
      batch.set(refs[j]!, next); // set completo pero con los campos Atenza reinyectados
      if (snap.exists) updated++; else created++;
    });
    await batch.commit();
  }
  console.log(`tickets: ${created} nuevos, ${updated} actualizados (Atenza-owned preservado).`);
}

async function syncMembers() {
  // Solo miembros de referencia que NO estén mapeados a una cuenta real (merge
  // para no pisar campos como `enabled`/roleName si el doc ya existía).
  const ref = members.filter((m) => !idMap[m.uid as string]);
  let n = 0, skipped = members.length - ref.length;
  for (let i = 0; i < ref.length; i += 300) {
    const batch = db.batch();
    for (const m of ref.slice(i, i + 300)) { batch.set(db.doc(`tenants/${TENANT}/members/${m.uid}`), m, { merge: true }); n++; }
    await batch.commit();
  }
  console.log(`members: ${n} de referencia (merge), ${skipped} omitidos por estar en el mapa de identidad.`);
}

async function main() {
  console.log(`Sync SDP → Atenza · tenant ${TENANT} · ${Object.keys(idMap).length} identidades mapeadas.`);
  await syncMembers();
  await syncTickets();
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
