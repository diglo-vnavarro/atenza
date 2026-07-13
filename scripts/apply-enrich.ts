// Aplica el enriquecimiento (importer/enrich.ts) al tenant en Firestore:
//   - escribe los ciclos de vida (stages/transitions mapeados)
//   - actualiza las plantillas CON tickets (fields + lifecycleId)
//   - ELIMINA las plantillas SIN ningún ticket levantado
// Admin SDK + ADC de owner (salta reglas). NO toca members ni tickets.
//
//   GOOGLE_APPLICATION_CREDENTIALS=<adc> GOOGLE_CLOUD_PROJECT=diglo-desk-pd \
//   TENANT=diglo-it npx tsx scripts/apply-enrich.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const here = dirname(fileURLToPath(import.meta.url));
const seed = JSON.parse(readFileSync(join(here, '..', 'importer', 'imported-seed.json'), 'utf8'));
const TENANT = process.env.TENANT ?? 'diglo-it';

initializeApp({ projectId: process.env.GOOGLE_CLOUD_PROJECT ?? 'diglo-desk-pd' });
const db = getFirestore();

async function main() {
  const lifecycles: { id: string }[] = seed.lifecycles ?? [];
  const tpls: { id: string; ticketCount?: number }[] = seed.templates ?? [];

  // 1) ciclos de vida
  let lc = 0;
  for (let i = 0; i < lifecycles.length; i += 400) {
    const batch = db.batch();
    for (const l of lifecycles.slice(i, i + 400)) { batch.set(db.doc(`tenants/${TENANT}/lifecycles/${l.id}`), l); lc++; }
    await batch.commit();
  }
  console.log(`ciclos de vida escritos: ${lc}`);

  // 2) plantillas: actualizar con tickets, borrar sin tickets
  let updated = 0, deleted = 0;
  for (let i = 0; i < tpls.length; i += 200) {
    const batch = db.batch();
    for (const tp of tpls.slice(i, i + 200)) {
      const ref = db.doc(`tenants/${TENANT}/templates/${tp.id}`);
      if ((tp.ticketCount ?? 0) === 0) { batch.delete(ref); deleted++; }
      else { const { ticketCount, ...clean } = tp as Record<string, unknown>; batch.set(ref, clean); updated++; }
    }
    await batch.commit();
  }
  console.log(`plantillas actualizadas (con tickets): ${updated}`);
  console.log(`plantillas eliminadas (0 tickets): ${deleted}`);
  console.log('Aplicado en tenant', TENANT);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
