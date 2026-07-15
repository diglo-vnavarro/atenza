// Reconcilia una identidad de SDP (id viejo) con un uid real de Firebase: fusiona la
// ficha (groupIds), reasigna sus tickets (technicianId/requesterId) en TODO el tenant,
// escribe el idmap y borra la ficha vieja. Para casos que provision-access no cubre
// (email distinto: SDP vjnavarroh@ vs login vnavarro@). Dry-run por defecto; APPLY=1.
//
//   GOOGLE_CLOUD_PROJECT=diglo-desk-pd TENANT=diglo-it \
//   OLD_ID=9207000000198722 TARGET_UID=QzdANMSSOuTQJWF9h18gaV0TRwo2 [APPLY=1] npx tsx scripts/reconcile-user.ts
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT ?? 'diglo-desk-pd';
const TENANT = process.env.TENANT ?? 'diglo-it';
const OLD_ID = process.env.OLD_ID;
const TARGET_UID = process.env.TARGET_UID;
const APPLY = process.env.APPLY === '1';
if (!OLD_ID || !TARGET_UID) throw new Error('Faltan OLD_ID y/o TARGET_UID');

initializeApp({ projectId: PROJECT });
const db = getFirestore();

async function main() {
  const oldRef = db.doc(`tenants/${TENANT}/members/${OLD_ID}`);
  const tgtRef = db.doc(`tenants/${TENANT}/members/${TARGET_UID}`);
  const [oldSnap, tgtSnap] = await Promise.all([oldRef.get(), tgtRef.get()]);
  const oldM = oldSnap.data() as { groupIds?: string[]; name?: string; email?: string } | undefined;
  const tgtM = tgtSnap.data() as { groupIds?: string[]; name?: string } | undefined;
  const mergedGroups = [...new Set([...(tgtM?.groupIds ?? []), ...(oldM?.groupIds ?? [])])];

  // Tickets a reasignar (scan completo).
  const all = await db.collection(`tenants/${TENANT}/tickets`).get();
  const upd = all.docs.filter((d) => d.data().technicianId === OLD_ID || d.data().requesterId === OLD_ID);
  const asTech = upd.filter((d) => d.data().technicianId === OLD_ID).length;
  console.log(`${APPLY ? '' : 'DRY-RUN · '}OLD ${OLD_ID} (${oldM?.name ?? '¿sin ficha?'}) → ${TARGET_UID} (${tgtM?.name ?? '?'})`);
  console.log(`  grupos fusionados: [${mergedGroups.join(', ') || '—'}] · tickets a reasignar: ${upd.length} (técnico ${asTech}, solicitante ${upd.length - asTech})`);
  if (!APPLY) { console.log('Repite con APPLY=1.'); return; }

  if (mergedGroups.length) await tgtRef.set({ groupIds: mergedGroups }, { merge: true });
  let n = 0;
  for (let i = 0; i < upd.length; i += 400) {
    const batch = db.batch();
    for (const d of upd.slice(i, i + 400)) {
      const patch: Record<string, string> = {};
      if (d.data().technicianId === OLD_ID) patch.technicianId = TARGET_UID;
      if (d.data().requesterId === OLD_ID) patch.requesterId = TARGET_UID;
      batch.set(d.ref, patch, { merge: true }); n++;
    }
    await batch.commit();
  }
  await db.doc(`tenants/${TENANT}/idmap/${OLD_ID}`).set({ uid: TARGET_UID, email: oldM?.email ?? '' });
  if (oldSnap.exists) await oldRef.delete();
  console.log(`  ✓ ${n} tickets reasignados · idmap escrito · ficha vieja borrada.`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
