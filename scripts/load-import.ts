// Carga imported-seed.json (config real traída de SDP v3) a un tenant de Firestore.
// Escribe categorías (doc tenant) + templates/slas/groups (colecciones). NO toca
// members (para no pisar el acceso del superadmin ni volcar 900 usuarios; eso va
// con el onboarding). Admin SDK + ADC de owner (salta reglas).
//
//   GOOGLE_APPLICATION_CREDENTIALS=<adc> GOOGLE_CLOUD_PROJECT=diglo-desk-pd \
//   TENANT=diglo-it npx tsx scripts/load-import.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const here = dirname(fileURLToPath(import.meta.url));
const snap = JSON.parse(readFileSync(join(here, '..', 'importer', 'imported-seed.json'), 'utf8'));
const TENANT = process.env.TENANT ?? 'diglo-it';

initializeApp({ projectId: process.env.GOOGLE_CLOUD_PROJECT ?? 'diglo-desk-pd' });
const db = getFirestore();

async function main() {
  await db.doc(`tenants/${TENANT}`).set({ categories: snap.categories ?? [] }, { merge: true });
  console.log(`categorías: ${(snap.categories ?? []).length}`);

  const writeCol = async (col: string, items: { id: string }[]) => {
    let n = 0;
    for (let i = 0; i < items.length; i += 400) {
      const batch = db.batch();
      for (const it of items.slice(i, i + 400)) { batch.set(db.doc(`tenants/${TENANT}/${col}/${it.id}`), it); n++; }
      await batch.commit();
    }
    console.log(`${col}: ${n}`);
  };
  await writeCol('templates', snap.templates ?? []);
  await writeCol('slas', snap.slas ?? []);
  await writeCol('groups', snap.groups ?? []);
  console.log(`(members NO importados: ${snap.members?.length ?? 0} — llegan con onboarding)`);
  console.log('Carga completa en tenant', TENANT);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
