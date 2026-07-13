// Escribe el catálogo de estados reales (los 15 de SDP, en src/data/seed.ts) al
// doc del tenant. Admin SDK + ADC.
//   GOOGLE_APPLICATION_CREDENTIALS=<adc> GOOGLE_CLOUD_PROJECT=diglo-desk-pd \
//   TENANT=diglo-it npx tsx scripts/load-statuses.ts
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { SDP_STATUSES } from '../src/data/seed.js';

const TENANT = process.env.TENANT ?? 'diglo-it';
initializeApp({ projectId: process.env.GOOGLE_CLOUD_PROJECT ?? 'diglo-desk-pd' });
const db = getFirestore();

async function main() {
  await db.doc(`tenants/${TENANT}`).set({ statuses: SDP_STATUSES }, { merge: true });
  console.log(`Estados escritos en ${TENANT}: ${SDP_STATUSES.length}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
