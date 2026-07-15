// PUNTO DE RETORNO (F4c): vuelca un SNAPSHOT completo del tenant a un JSON en
// scripts/backups/, para poder restaurar el entorno clásico si hiciera falta.
// Incluye el doc raíz del tenant (con serviceCategories/operationMode/formRules…) y
// las subcolecciones templates, lifecycles, slas, groups, tickets, members, idmap.
// Solo lectura. Restaurar = scripts/restore-config.ts.
//
//   GOOGLE_CLOUD_PROJECT=diglo-desk-pd TENANT=diglo-it \
//   STAMP=2026-07-15 npx tsx scripts/backup-config.ts
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT ?? 'diglo-desk-pd';
const TENANT = process.env.TENANT ?? 'diglo-it';
const STAMP = process.env.STAMP ?? 'snapshot'; // pasa la fecha por env (Date no disponible en algunos entornos)
const SUBCOLS = ['templates', 'lifecycles', 'slas', 'groups', 'tickets', 'members', 'idmap'];

initializeApp({ projectId: PROJECT });
const db = getFirestore();

async function main() {
  const root = (await db.doc(`tenants/${TENANT}`).get()).data() ?? {};
  const out: Record<string, unknown> = { _meta: { tenant: TENANT, stamp: STAMP, project: PROJECT }, root };
  for (const c of SUBCOLS) {
    const snap = await db.collection(`tenants/${TENANT}/${c}`).get();
    out[c] = snap.docs.map((d) => ({ _id: d.id, ...d.data() }));
    console.log(`  ${c}: ${snap.size}`);
  }
  const dir = join(dirname(fileURLToPath(import.meta.url)), 'backups');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `classic-${TENANT}-${STAMP}.json`);
  writeFileSync(file, JSON.stringify(out, null, 1));
  console.log(`\n✓ Snapshot escrito: ${file}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
