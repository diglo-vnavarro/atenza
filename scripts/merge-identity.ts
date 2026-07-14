// Fusiona un miembro ANTIGUO (importado de SDP, uid=id SDP) en el miembro FINAL
// (cuenta Google, uid=Firebase): reasigna sus tickets (technicianId/requesterId),
// une sus groupIds al final y ELIMINA el duplicado. Deja una sola identidad.
// Admin SDK + ADC de owner.
//
//   GOOGLE_APPLICATION_CREDENTIALS=<adc> GOOGLE_CLOUD_PROJECT=diglo-desk-pd \
//   TENANT=diglo-it OLD_EMAIL=vjnavarroh@digloservicer.com \
//   NEW_EMAIL=vnavarro@digloservicer.com npx tsx scripts/merge-identity.ts
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const TENANT = process.env.TENANT ?? 'diglo-it';
const OLD_EMAIL = (process.env.OLD_EMAIL ?? '').toLowerCase();
const NEW_EMAIL = (process.env.NEW_EMAIL ?? '').toLowerCase();
if (!OLD_EMAIL || !NEW_EMAIL) throw new Error('Faltan OLD_EMAIL / NEW_EMAIL');

initializeApp({ projectId: process.env.GOOGLE_CLOUD_PROJECT ?? 'diglo-desk-pd' });
const db = getFirestore();
const T = `tenants/${TENANT}`;

async function main() {
  const mem = await db.collection(`${T}/members`).get();
  const find = (e: string) => mem.docs.map((d) => d.data() as any).find((m) => (m.email || '').toLowerCase() === e);
  const oldM = find(OLD_EMAIL); const newM = find(NEW_EMAIL);
  if (!oldM) throw new Error(`No existe miembro ${OLD_EMAIL}`);
  if (!newM) throw new Error(`No existe miembro ${NEW_EMAIL}`);
  if (oldM.uid === newM.uid) { console.log('Ya son el mismo uid; nada que fusionar.'); return; }
  console.log(`OLD ${OLD_EMAIL} uid=${oldM.uid} → NEW ${NEW_EMAIL} uid=${newM.uid}`);

  // 1) reasignar tickets
  const tks = await db.collection(`${T}/tickets`).get();
  let tech = 0, req = 0;
  for (let i = 0; i < tks.docs.length; i += 300) {
    const batch = db.batch(); let touched = 0;
    for (const d of tks.docs.slice(i, i + 300)) {
      const t = d.data() as any; const patch: Record<string, unknown> = {};
      if (t.technicianId === oldM.uid) { patch.technicianId = newM.uid; tech++; }
      if (t.requesterId === oldM.uid) { patch.requesterId = newM.uid; req++; }
      if (Object.keys(patch).length) { batch.update(d.ref, patch); touched++; }
    }
    if (touched) await batch.commit();
  }
  console.log(`tickets reasignados: technicianId ${tech} · requesterId ${req}`);

  // 2) unir groupIds en el miembro final (y conservar rol/estado del final)
  const groups = [...new Set([...(newM.groupIds ?? []), ...(oldM.groupIds ?? [])])];
  await db.doc(`${T}/members/${newM.uid}`).set({ groupIds: groups }, { merge: true });
  console.log(`groupIds del miembro final: ${groups.length}`);

  // 3) eliminar el duplicado
  await db.doc(`${T}/members/${oldM.uid}`).delete();
  console.log(`miembro duplicado eliminado: ${oldM.uid} (${OLD_EMAIL})`);
  console.log('Fusión completa.');
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
