// Escribe los catálogos de valores reales (SDP_PICKLISTS de src/data/seed.ts) al
// doc del tenant. Admin SDK + ADC.
//   GOOGLE_APPLICATION_CREDENTIALS=<adc> GOOGLE_CLOUD_PROJECT=diglo-desk-pd \
//   TENANT=diglo-it npx tsx scripts/load-picklists.ts
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { SDP_PICKLISTS } from '../src/data/seed.js';

const TENANT = process.env.TENANT ?? 'diglo-it';
initializeApp({ projectId: process.env.GOOGLE_CLOUD_PROJECT ?? 'diglo-desk-pd' });
const db = getFirestore();

async function main() {
  await db.doc(`tenants/${TENANT}`).set({ picklists: SDP_PICKLISTS }, { merge: true });
  const n = Object.values(SDP_PICKLISTS).reduce((a, l) => a + l.length, 0);
  console.log(`Picklists escritos en ${TENANT}: ${n} valores en ${Object.keys(SDP_PICKLISTS).length} catálogos.`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
