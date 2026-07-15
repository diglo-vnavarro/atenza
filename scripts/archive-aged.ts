// Política de ANTIGÜEDAD: la bandeja en vivo solo mantiene los últimos N meses
// (por defecto 12). Archiva los tickets NO terminales cuya ÚLTIMA ACTIVIDAD
// (último statusHistory.from, o createdAt) sea anterior al corte. Idempotente.
// (Los terminales ya están archivados por estado.) Dry-run por defecto; APPLY=1.
//
//   GOOGLE_CLOUD_PROJECT=diglo-desk-pd TENANT=diglo-it NOW_MS=<epoch> [MONTHS=12] [APPLY=1] \
//   npx tsx scripts/archive-aged.ts
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT ?? 'diglo-desk-pd';
const TENANT = process.env.TENANT ?? 'diglo-it';
const MONTHS = Number(process.env.MONTHS ?? '12');
const NOW = Number(process.env.NOW_MS ?? Date.now());
const APPLY = process.env.APPLY === '1';
const CUT = NOW - MONTHS * 30.44 * 24 * 3600 * 1000; // corte aproximado por meses

initializeApp({ projectId: PROJECT });
const db = getFirestore();

const lastActivity = (t: { statusHistory?: { from?: number }[]; createdAt?: number }): number => {
  const hs = (t.statusHistory ?? []).map((h) => h.from ?? 0);
  return hs.length ? Math.max(...hs) : (t.createdAt ?? 0);
};

async function main() {
  const cutDate = new Date(CUT).toISOString().slice(0, 10);
  // Solo activos (archived=false); de esos, los que superan la antigüedad.
  const tks = (await db.collection(`tenants/${TENANT}/tickets`).where('archived', '==', false).get()).docs;
  const aged = tks.filter((d) => lastActivity(d.data() as { statusHistory?: { from?: number }[]; createdAt?: number }) < CUT);
  console.log(`${APPLY ? '' : 'DRY-RUN · '}corte ${MONTHS} meses (${cutDate}) · activos: ${tks.length} · a archivar por antigüedad: ${aged.length} → quedarían ${tks.length - aged.length}`);
  if (!APPLY) { console.log('Repite con APPLY=1.'); return; }
  let n = 0;
  for (let i = 0; i < aged.length; i += 400) {
    const batch = db.batch();
    for (const d of aged.slice(i, i + 400)) { batch.set(d.ref, { archived: true }, { merge: true }); n++; }
    await batch.commit();
  }
  console.log(`✓ ${n} tickets archivados por antigüedad (>${MONTHS} meses).`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
