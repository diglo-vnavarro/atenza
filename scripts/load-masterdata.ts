// Escribe sedes y departamentos (imported-masterdata.json) al doc del tenant.
//   GOOGLE_APPLICATION_CREDENTIALS=<adc> GOOGLE_CLOUD_PROJECT=diglo-desk-pd \
//   TENANT=diglo-it npx tsx scripts/load-masterdata.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const here = dirname(fileURLToPath(import.meta.url));
const { sites, departments, userGroups } = JSON.parse(readFileSync(join(here, '..', 'importer', 'imported-masterdata.json'), 'utf8'));
const TENANT = process.env.TENANT ?? 'diglo-it';
initializeApp({ projectId: process.env.GOOGLE_CLOUD_PROJECT ?? 'diglo-desk-pd' });
const db = getFirestore();

async function main() {
  await db.doc(`tenants/${TENANT}`).set({ sites: sites ?? [], departments: departments ?? [], userGroups: userGroups ?? [] }, { merge: true });
  console.log(`Escrito en ${TENANT}: ${(sites ?? []).length} sedes, ${(departments ?? []).length} departamentos, ${(userGroups ?? []).length} grupos de usuarios.`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
