// Escribe la matriz de prioridades por defecto (DEFAULT_PRIORITY_MATRIX) al doc
// del tenant. Admin SDK + ADC.
//   GOOGLE_APPLICATION_CREDENTIALS=<adc> GOOGLE_CLOUD_PROJECT=diglo-desk-pd \
//   TENANT=diglo-it npx tsx scripts/load-matrix.ts
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { DEFAULT_PRIORITY_MATRIX } from '../src/data/seed.js';

const TENANT = process.env.TENANT ?? 'diglo-it';
initializeApp({ projectId: process.env.GOOGLE_CLOUD_PROJECT ?? 'diglo-desk-pd' });
const db = getFirestore();

async function main() {
  await db.doc(`tenants/${TENANT}`).set({ priorityMatrix: DEFAULT_PRIORITY_MATRIX }, { merge: true });
  console.log(`Matriz de prioridades escrita en ${TENANT}: ${Object.keys(DEFAULT_PRIORITY_MATRIX).length} impactos.`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
