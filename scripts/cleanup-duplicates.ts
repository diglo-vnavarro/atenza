// Limpieza GLOBAL de fichas de miembro duplicadas (convivencia SDP→ticketIN). Por cada entrada del
// idmap {uidSDP → uidFirebase}, consolida en la ficha de LOGIN (Firebase): une los grupos de la
// duplicada y la DESACTIVA (status:inactive). No borra (conserva la resolución de nombres en el
// histórico). Solo actúa si la ficha de login existe y está activa. Idempotente.
//   GOOGLE_CLOUD_PROJECT=diglo-desk-pd TENANT=diglo-it npx tsx scripts/cleanup-duplicates.ts [--dry-run]
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const TENANT = process.env.TENANT ?? 'diglo-it';
const DRY = process.env.DRY_RUN === '1' || process.argv.includes('--dry-run');
initializeApp({ projectId: process.env.GOOGLE_CLOUD_PROJECT ?? 'diglo-desk-pd' });
const db = getFirestore();

async function main() {
  const T = `tenants/${TENANT}`;
  const idmap: Record<string, string> = {};
  (await db.collection(`${T}/idmap`).get()).forEach((d) => { const u = d.data().uid as string | undefined; if (u) idmap[d.id] = u; });
  const entries = Object.entries(idmap).filter(([sdp, fb]) => sdp !== fb);
  console.log(`idmap: ${entries.length} mapeos SDP→login.`);
  let consolidated = 0, skippedNoLogin = 0, alreadyClean = 0;
  for (const [sdpId, fbUid] of entries) {
    const [fbSnap, sdpSnap] = await db.getAll(db.doc(`${T}/members/${fbUid}`), db.doc(`${T}/members/${sdpId}`));
    const fb = fbSnap.exists ? fbSnap.data()! : null;
    const sdp = sdpSnap.exists ? sdpSnap.data()! : null;
    if (!fb || fb.status !== 'active') { skippedNoLogin++; continue; }            // sin ficha de login activa → no tocar
    if (!sdp || sdp.status === 'inactive') { alreadyClean++; continue; }          // ya limpia
    const groups = new Set<string>([...(fb.groupIds ?? []), ...(sdp.groupIds ?? [])]);
    if (!DRY) { await db.doc(`${T}/members/${fbUid}`).update({ groupIds: [...groups] }); await db.doc(`${T}/members/${sdpId}`).update({ status: 'inactive' }); }
    console.log(`  ${sdp.name ?? sdpId}: consolidada en ${fbUid.slice(0, 8)}… (${groups.size} grupos) · duplicada ${sdpId} → inactiva`);
    consolidated++;
  }
  console.log(`\n${DRY ? '[DRY] ' : ''}Consolidadas/desactivadas: ${consolidated} · ya limpias: ${alreadyClean} · sin login activo (omitidas): ${skippedNoLogin}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
