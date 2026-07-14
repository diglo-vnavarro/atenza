// Escribe el catálogo de roles (SDP_ROLES: los 17 reales con su nivel base) al doc
// del tenant. Admin SDK + ADC.
//   GOOGLE_APPLICATION_CREDENTIALS=<adc> GOOGLE_CLOUD_PROJECT=diglo-desk-pd \
//   TENANT=diglo-it npx tsx scripts/load-roles.ts
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { SDP_ROLES } from '../src/data/seed.js';

const TENANT = process.env.TENANT ?? 'diglo-it';
initializeApp({ projectId: process.env.GOOGLE_CLOUD_PROJECT ?? 'diglo-desk-pd' });
const db = getFirestore();

async function main() {
  await db.doc(`tenants/${TENANT}`).set({ roles: SDP_ROLES }, { merge: true });
  console.log(`Roles escritos en ${TENANT}: ${SDP_ROLES.length}.`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
