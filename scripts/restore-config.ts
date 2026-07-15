// RESTAURA un snapshot creado por scripts/backup-config.ts (punto de retorno F4c).
// Reescribe el doc raíz del tenant y las subcolecciones del snapshot. Dry-run por
// defecto; APPLY=1 para escribir. Aditivo (merge): repone lo borrado; no elimina
// lo que se haya creado después.
//
//   GOOGLE_CLOUD_PROJECT=diglo-desk-pd FILE=scripts/backups/classic-diglo-it-2026-07-15.json \
//   [APPLY=1] npx tsx scripts/restore-config.ts
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'node:fs';

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT ?? 'diglo-desk-pd';
const FILE = process.env.FILE;
const APPLY = process.env.APPLY === '1';
if (!FILE) throw new Error('Falta FILE=ruta/al/snapshot.json');

initializeApp({ projectId: PROJECT });
const db = getFirestore();

async function main() {
  const snap = JSON.parse(readFileSync(FILE!, 'utf8')) as Record<string, unknown> & { _meta: { tenant: string }; root: Record<string, unknown> };
  const TENANT = snap._meta.tenant;
  console.log(`${APPLY ? '' : '=== DRY-RUN === '}Restaurar snapshot en tenant ${TENANT} (${FILE})`);
  const subcols = Object.keys(snap).filter((k) => k !== '_meta' && k !== 'root');
  for (const c of subcols) console.log(`  ${c}: ${(snap[c] as unknown[]).length}`);
  console.log(`  root: ${Object.keys(snap.root).length} campos`);
  if (!APPLY) { console.log('DRY-RUN: nada escrito. Repite con APPLY=1.'); return; }

  await db.doc(`tenants/${TENANT}`).set(snap.root, { merge: true });
  for (const c of subcols) {
    const items = snap[c] as ({ _id: string } & Record<string, unknown>)[];
    for (let i = 0; i < items.length; i += 400) {
      const batch = db.batch();
      for (const it of items.slice(i, i + 400)) { const { _id, ...data } = it; batch.set(db.doc(`tenants/${TENANT}/${c}/${_id}`), data, { merge: true }); }
      await batch.commit();
    }
    console.log(`  ✓ ${c}: ${items.length}`);
  }
  console.log('Restauración completa.');
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
