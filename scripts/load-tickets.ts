// Carga imported-tickets.json (tickets activos + personas referenciadas) al
// tenant en Firestore. Admin SDK + ADC de owner. Aditivo: los miembros llevan
// id de SDP (no colisionan con el superadmin ni con el seed); son registros de
// referencia (sin auth) para que los tickets muestren solicitante/técnico.
//
//   GOOGLE_APPLICATION_CREDENTIALS=<adc> GOOGLE_CLOUD_PROJECT=diglo-desk-pd \
//   TENANT=diglo-it npx tsx scripts/load-tickets.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const here = dirname(fileURLToPath(import.meta.url));
const { tickets, members } = JSON.parse(readFileSync(join(here, '..', 'importer', 'imported-tickets.json'), 'utf8'));
const TENANT = process.env.TENANT ?? 'diglo-it';

initializeApp({ projectId: process.env.GOOGLE_CLOUD_PROJECT ?? 'diglo-desk-pd' });
const db = getFirestore();

async function writeAll(col: string, items: { id?: string; uid?: string }[], idKey: 'id' | 'uid') {
  let n = 0;
  for (let i = 0; i < items.length; i += 300) {
    const batch = db.batch();
    for (const it of items.slice(i, i + 300)) { batch.set(db.doc(`tenants/${TENANT}/${col}/${it[idKey]}`), it); n++; }
    await batch.commit();
  }
  console.log(`${col}: ${n}`);
}

async function main() {
  await writeAll('members', members, 'uid');
  await writeAll('tickets', tickets, 'id');
  console.log('Cargado en tenant', TENANT);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
