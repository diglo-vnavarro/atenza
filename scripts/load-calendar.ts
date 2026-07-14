// Escribe el calendario laboral por defecto (horas operativas + festivos) al doc
// del tenant. Admin SDK + ADC. Los festivos son editables luego en Admin.
//   GOOGLE_APPLICATION_CREDENTIALS=<adc> GOOGLE_CLOUD_PROJECT=diglo-desk-pd \
//   TENANT=diglo-it npx tsx scripts/load-calendar.ts
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { DEFAULT_BUSINESS_HOURS, DEFAULT_HOLIDAYS } from '../src/data/seed.js';

const TENANT = process.env.TENANT ?? 'diglo-it';
initializeApp({ projectId: process.env.GOOGLE_CLOUD_PROJECT ?? 'diglo-desk-pd' });
const db = getFirestore();

async function main() {
  await db.doc(`tenants/${TENANT}`).set({ businessHours: DEFAULT_BUSINESS_HOURS, holidays: DEFAULT_HOLIDAYS }, { merge: true });
  console.log(`Calendario escrito en ${TENANT}: ${DEFAULT_BUSINESS_HOURS.days.length} días laborables, ${DEFAULT_HOLIDAYS.length} festivos.`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
