// Limpieza de tickets NATIVOS de prueba (prefijos INC-/SR-/PRUEBA-) del ITSM Atenza/ticketIN.
// NUNCA toca los tickets sincronizados de SDP (que empiezan por «#»). Borra el doc del ticket
// + sus subcolecciones (worklog, comentarios, adjuntos, tareas…) con recursiveDelete.
//
// Uso (ver INSTRUCCIONES.txt en esta misma carpeta):
//   node herramientas/limpieza-pruebas/limpiar-pruebas.mjs            → DRY-RUN (solo lista)
//   node herramientas/limpieza-pruebas/limpiar-pruebas.mjs --apply    → BORRA de verdad
// Variables opcionales:
//   TENANT=diglo-it            (por defecto)     · instancia
//   PREFIXES="INC-,SR-,PRUEBA-" (por defecto)    · prefijos a limpiar
//   RESET_COUNTER=1                              · además pone el contador del tenant a 1
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT ?? 'diglo-desk-pd';
const TENANT = process.env.TENANT ?? 'diglo-it';
const APPLY = process.argv.includes('--apply');
const PREFIXES = (process.env.PREFIXES ?? 'INC-,SR-,PRUEBA-').split(',').map((s) => s.trim()).filter(Boolean);
const RESET_COUNTER = process.env.RESET_COUNTER === '1';

initializeApp({ projectId: PROJECT });
const db = getFirestore();

async function main() {
  const snap = await db.collection(`tenants/${TENANT}/tickets`).get();
  const hits = snap.docs.filter((d) => PREFIXES.some((p) => d.id.startsWith(p)));
  console.log(`${APPLY ? '' : '[DRY-RUN] '}Instancia «${TENANT}» · tickets de prueba (${PREFIXES.join(' / ')}): ${hits.length} de ${snap.size} totales.`);
  for (const d of hits.slice(0, 60)) {
    const t = d.data();
    console.log(`   ${String(d.id).padEnd(11)} · ${t.status ?? ''} · req=${t.requesterId ?? ''} · ${String(t.subject ?? '').slice(0, 44)}`);
  }
  if (hits.length > 60) console.log(`   … y ${hits.length - 60} más`);

  if (!APPLY) {
    console.log(`\n(DRY-RUN: no se ha borrado NADA. Añade  --apply  para borrar de verdad.)`);
    return;
  }
  let n = 0;
  for (const d of hits) { await db.recursiveDelete(d.ref); n++; if (n % 20 === 0) console.log(`   borrados ${n}/${hits.length}…`); }
  if (RESET_COUNTER) { await db.doc(`tenants/${TENANT}`).set({ counter: 1 }, { merge: true }); console.log('   contador del tenant → 1'); }
  console.log(`\n✓ Borrados ${n} tickets de prueba (doc + subcolecciones)${RESET_COUNTER ? ' · contador reseteado' : ''}.`);
}
main().then(() => process.exit(0)).catch((e) => { console.error('ERROR:', e.message ?? e); process.exit(1); });
