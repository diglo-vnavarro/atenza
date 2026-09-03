// Limpieza de tickets NATIVOS de prueba (prefijos INC-/SR-/PRUEBA-). NUNCA toca los tickets
// sincronizados de SDP (que empiezan por «#»). Borra el doc del ticket + sus subcolecciones
// (worklog, comentarios, adjuntos, tareas…) con recursiveDelete.
//
//   GOOGLE_CLOUD_PROJECT=diglo-desk-pd TENANT=diglo-it npx tsx scripts/clean-pruebas.ts          (DRY-RUN: solo lista)
//   ...                                                    npx tsx scripts/clean-pruebas.ts --apply  (BORRA de verdad)
//   PREFIXES="INC-,SR-,PRUEBA-"   → prefijos a limpiar (por defecto estos).
//   RESET_COUNTER=1              → además, pone el contador del tenant a 1 (numeración limpia al reanudar).
//
// Nota: los adjuntos subidos al bucket (si los hubiera) no se borran aquí; los tickets de
// prueba normalmente no tienen. La numeración definitiva se siembra en el corte (cutover-ids.ts).
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const TENANT = process.env.TENANT ?? 'diglo-it';
const APPLY = process.argv.includes('--apply');
const PREFIXES = (process.env.PREFIXES ?? 'INC-,SR-,PRUEBA-').split(',').map((s) => s.trim()).filter(Boolean);
const RESET_COUNTER = process.env.RESET_COUNTER === '1';

initializeApp({ projectId: process.env.GOOGLE_CLOUD_PROJECT ?? 'diglo-desk-pd' });
const db = getFirestore();

async function main() {
  const snap = await db.collection(`tenants/${TENANT}/tickets`).get();
  const hits = snap.docs.filter((d) => PREFIXES.some((p) => d.id.startsWith(p)));
  console.log(`${APPLY ? '' : '[DRY-RUN] '}Tickets nativos de prueba (${PREFIXES.join(' / ')}): ${hits.length} de ${snap.size} totales.`);
  for (const d of hits.slice(0, 60)) {
    const t = d.data() as { subject?: string; requesterId?: string; status?: string };
    console.log(`   ${d.id.padEnd(11)} · ${t.status ?? ''} · req=${t.requesterId ?? ''} · ${(t.subject ?? '').slice(0, 44)}`);
  }
  if (hits.length > 60) console.log(`   … y ${hits.length - 60} más`);

  if (!APPLY) {
    console.log(`\n(DRY-RUN: no se ha borrado nada. Añade --apply para borrar${RESET_COUNTER ? ' y resetear el contador' : ''}.)`);
    return;
  }

  let n = 0;
  for (const d of hits) { await db.recursiveDelete(d.ref); n++; if (n % 20 === 0) console.log(`   borrados ${n}/${hits.length}…`); }
  if (RESET_COUNTER) { await db.doc(`tenants/${TENANT}`).set({ counter: 1 }, { merge: true }); console.log('   contador del tenant → 1'); }
  console.log(`\n✓ Borrados ${n} tickets de prueba (doc + subcolecciones)${RESET_COUNTER ? ' · contador reseteado' : ''}.`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e.message ?? e); process.exit(1); });
