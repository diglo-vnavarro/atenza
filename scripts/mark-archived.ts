// Marca `archived` (+ createdAt) en los tickets EXISTENTES según su estado, para que
// la nueva suscripción en vivo (que filtra archived==false) los siga viendo. Debe
// correr ANTES de desplegar el código nuevo. Idempotente (solo toca los que no lo
// tienen). Dry-run por defecto; APPLY=1 escribe.
//
//   GOOGLE_CLOUD_PROJECT=diglo-desk-pd TENANT=diglo-it [APPLY=1] npx tsx scripts/mark-archived.ts
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { isArchivedStatus } from '../src/model.js';

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT ?? 'diglo-desk-pd';
const TENANT = process.env.TENANT ?? 'diglo-it';
const APPLY = process.env.APPLY === '1';

initializeApp({ projectId: PROJECT });
const db = getFirestore();

async function main() {
  const snap = await db.collection(`tenants/${TENANT}/tickets`).get();
  const pending = snap.docs.filter((d) => d.data().archived === undefined);
  const arch = pending.filter((d) => isArchivedStatus(d.data().status as string)).length;
  console.log(`${APPLY ? '' : 'DRY-RUN · '}tickets totales: ${snap.size} · sin campo archived: ${pending.length} (→ archived:true ${arch}, false ${pending.length - arch})`);
  if (!APPLY) { console.log('Repite con APPLY=1.'); return; }
  let n = 0;
  for (let i = 0; i < pending.length; i += 400) {
    const batch = db.batch();
    for (const d of pending.slice(i, i + 400)) {
      const t = d.data() as { status?: string; createdAt?: number; statusHistory?: { from?: number }[] };
      batch.set(d.ref, { archived: isArchivedStatus(t.status), createdAt: t.createdAt ?? t.statusHistory?.[0]?.from ?? Date.now() }, { merge: true });
      n++;
    }
    await batch.commit();
  }
  console.log(`✓ ${n} tickets marcados.`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
