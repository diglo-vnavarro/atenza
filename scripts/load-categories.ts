// Escribe la jerarquía importada (importer/imported-categories.json) al doc del
// tenant: categoryTree + categories (lista plana derivada). Admin SDK + ADC.
//   GOOGLE_APPLICATION_CREDENTIALS=<adc> GOOGLE_CLOUD_PROJECT=diglo-desk-pd \
//   TENANT=diglo-it npx tsx scripts/load-categories.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const here = dirname(fileURLToPath(import.meta.url));
const tree = JSON.parse(readFileSync(join(here, '..', 'importer', 'imported-categories.json'), 'utf8'));
const TENANT = process.env.TENANT ?? 'diglo-it';

initializeApp({ projectId: process.env.GOOGLE_CLOUD_PROJECT ?? 'diglo-desk-pd' });
const db = getFirestore();

async function main() {
  const categories = tree.map((c: { name: string }) => c.name);
  await db.doc(`tenants/${TENANT}`).set({ categoryTree: tree, categories }, { merge: true });
  console.log(`Escrito en ${TENANT}: ${tree.length} categorías (árbol + lista plana).`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
