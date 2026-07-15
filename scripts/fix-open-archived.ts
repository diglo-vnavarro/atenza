// Corrige la invariante: NINGÚN ticket ABIERTO puede estar archivado. archived debe
// derivar SOLO del estado (Cerrada/Cancelada/Resuelta). Desarchiva los que están
// archived=true pero con estado NO terminal (p. ej. los que archivó por error la
// regla de antigüedad). Dry-run por defecto; APPLY=1.
//
//   GOOGLE_CLOUD_PROJECT=diglo-desk-pd TENANT=diglo-it [APPLY=1] npx tsx scripts/fix-open-archived.ts
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { isArchivedStatus } from '../src/model.js';

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT ?? 'diglo-desk-pd';
const TENANT = process.env.TENANT ?? 'diglo-it';
const APPLY = process.env.APPLY === '1';

initializeApp({ projectId: PROJECT });
const db = getFirestore();

async function main() {
  // Escaneo completo: archived DEBE = isArchivedStatus(status). Corrige cualquier
  // desajuste (p. ej. abiertos archivados por la regla de antigüedad, ya retirada).
  const all = await db.collection(`tenants/${TENANT}/tickets`).get();
  const wrong = all.docs.filter((d) => !!d.data().archived !== isArchivedStatus(d.data().status as string));
  const toOpen = wrong.filter((d) => !isArchivedStatus(d.data().status as string)).length;
  console.log(`${APPLY ? '' : 'DRY-RUN · '}total ${all.size} · desajustados ${wrong.length} (→ desarchivar ${toOpen}, → archivar ${wrong.length - toOpen})`);
  if (!APPLY) { wrong.slice(0, 8).forEach((d) => console.log(`  ${d.id} · ${d.data().status} · archived=${d.data().archived}`)); console.log('Repite con APPLY=1.'); return; }
  let n = 0;
  for (let i = 0; i < wrong.length; i += 400) {
    const batch = db.batch();
    for (const d of wrong.slice(i, i + 400)) { batch.set(d.ref, { archived: isArchivedStatus(d.data().status as string) }, { merge: true }); n++; }
    await batch.commit();
  }
  console.log(`✓ ${n} tickets corregidos (archived = estado).`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
