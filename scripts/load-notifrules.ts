// Escribe las reglas de notificación por defecto (src/data/seed.ts) al doc del
// tenant. Admin SDK + ADC.
//   GOOGLE_APPLICATION_CREDENTIALS=<adc> GOOGLE_CLOUD_PROJECT=diglo-desk-pd \
//   TENANT=diglo-it npx tsx scripts/load-notifrules.ts
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { DEFAULT_NOTIF_RULES } from '../src/data/seed.js';

const TENANT = process.env.TENANT ?? 'diglo-it';
initializeApp({ projectId: process.env.GOOGLE_CLOUD_PROJECT ?? 'diglo-desk-pd' });
const db = getFirestore();

async function main() {
  await db.doc(`tenants/${TENANT}`).set({ notifRules: DEFAULT_NOTIF_RULES }, { merge: true });
  console.log(`Reglas de notificación escritas en ${TENANT}: ${DEFAULT_NOTIF_RULES.length}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
