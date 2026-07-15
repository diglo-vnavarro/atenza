// Carga imported-tickets.json (tickets activos + personas referenciadas) al
// tenant en Firestore. Admin SDK + ADC de owner. Aditivo: los miembros llevan
// id de SDP (no colisionan con el superadmin ni con el seed); son registros de
// referencia (sin auth) para que los tickets muestren solicitante/técnico.
//
// UNIFICACIÓN: consulta el idmap del tenant (tenants/{tid}/idmap/{sdpId} = {uid},
// escrito por scripts/provision-access.ts). Los tickets se atribuyen al uid REAL
// de Firebase (technicianId/requesterId traducidos) y NO se recrean fichas de
// referencia para los ids ya unificados. Así la importación del histórico completo
// es coherente con los usuarios ya provisionados.
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
  // Mapa id-SDP → uid unificado (de los usuarios ya provisionados con acceso).
  const idmapSnap = await db.collection(`tenants/${TENANT}/idmap`).get();
  const idmap = new Map<string, string>(idmapSnap.docs.map((d) => [d.id, (d.data().uid as string)]));
  const tr = (id?: string | null) => (id && idmap.has(id) ? idmap.get(id)! : id);
  if (idmap.size) console.log(`idmap: ${idmap.size} ids unificados → se traducen technicianId/requesterId`);

  // No recrear fichas de referencia para ids ya unificados (su ficha real existe).
  const refMembers = (members as { uid?: string }[]).filter((m) => !(m.uid && idmap.has(m.uid)));
  const mappedTickets = (tickets as { technicianId?: string; requesterId?: string }[]).map((t) => ({
    ...t, technicianId: tr(t.technicianId) ?? null, requesterId: tr(t.requesterId) ?? t.requesterId,
  }));

  await writeAll('members', refMembers, 'uid');
  await writeAll('tickets', mappedTickets as { id?: string }[], 'id');
  console.log(`Cargado en tenant ${TENANT} (fichas de referencia: ${refMembers.length}/${members.length}; ${idmap.size} unificadas omitidas)`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
