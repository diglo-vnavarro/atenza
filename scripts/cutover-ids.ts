// N3 — CORTE de numeración: al pasar Atenza a ser la fuente de verdad, siembra el `counter`
// del tenant en el MÁXIMO id de SDP + margen y activa `idContinuity`, para que los tickets
// nativos continúen la numeración con «#NNNN» sin reinicio ni colisión.
//
// EJECUTAR SOLO EN EL CORTE (cuando SDP deje de crear tickets). En convivencia NO tocar:
// SDP sigue generando «#», y Atenza usa el prefijo INC-/SR- (no colisiona).
//
//   dry-run (por defecto): calcula y muestra el máx + counter propuesto; NO escribe.
//   --apply: escribe counter + idContinuity=true.
//   GOOGLE_CLOUD_PROJECT=diglo-desk-pd TENANT=diglo-it npx tsx scripts/cutover-ids.ts [--apply]
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const APPLY = process.argv.includes('--apply');
const PROJECT = process.env.GOOGLE_CLOUD_PROJECT ?? 'diglo-desk-pd';
const TENANT = process.env.TENANT ?? 'diglo-it';
const MARGIN = Number(process.env.MARGIN ?? 100);

initializeApp({ projectId: PROJECT });
const db = getFirestore();

async function main(): Promise<void> {
  // listDocuments() lista TODOS los ids sin leer el contenido (barato para ~24k tickets).
  const refs = await db.collection(`tenants/${TENANT}/tickets`).listDocuments();
  let max = 0, withNum = 0;
  for (const r of refs) { const n = Number(r.id.replace(/\D/g, '')); if (!Number.isNaN(n) && n > 0) { withNum++; if (n > max) max = n; } }
  const counter = Math.ceil((max + MARGIN) / 100) * 100; // redondea a la centena superior
  const root = (await db.doc(`tenants/${TENANT}`).get()).data() ?? {};

  console.log(`Tickets: ${refs.length} · con id numérico: ${withNum}`);
  console.log(`Máx id de SDP: ${max}  → counter propuesto (máx + ${MARGIN}, redondeado): ${counter}`);
  console.log(`Estado actual: counter=${root.counter ?? 'undefined'} · idContinuity=${root.idContinuity ?? false}`);
  console.log(`Primer ticket nativo tras el corte sería: #${String(counter).padStart(4, '0')}`);

  if (APPLY) {
    await db.doc(`tenants/${TENANT}`).set({ counter, idContinuity: true }, { merge: true });
    console.log(`\n✓ APLICADO: counter=${counter} · idContinuity=true. Los tickets nativos continúan con «#».`);
    console.log(`  Rollback: idContinuity=false (vuelve a INC-/SR-).`);
  } else {
    console.log(`\n(dry-run: NO se ha escrito nada. Ejecuta con --apply SOLO en el corte.)`);
  }
}
main().catch((e) => { console.error('ERROR:', (e as Error).message); process.exit(1); });
