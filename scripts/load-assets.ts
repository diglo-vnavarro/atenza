// Carga importer/imported-assets.json en tenants/{TENANT}/assets. Resuelve el
// email del usuario asignado (campo _email) a uid contra los miembros del tenant
// (con alias para identidades reconciliadas). DRY por defecto; escribe con WRITE=1.
//   GOOGLE_CLOUD_PROJECT=diglo-desk-pd TENANT=diglo-it npx tsx scripts/load-assets.ts        (dry)
//   GOOGLE_CLOUD_PROJECT=diglo-desk-pd TENANT=diglo-it WRITE=1 npx tsx scripts/load-assets.ts (escribe)
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT ?? 'diglo-desk-pd';
const TENANT = process.env.TENANT ?? 'diglo-it';
const WRITE = process.env.WRITE === '1';
// Alias de correos (identidades reconciliadas): SDP conserva el antiguo.
const EMAIL_ALIAS: Record<string, string> = { 'vjnavarroh@digloservicer.com': 'vnavarro@digloservicer.com' };

initializeApp({ projectId: PROJECT });
const db = getFirestore();
const here = dirname(fileURLToPath(import.meta.url));

async function main() {
  const rows = JSON.parse(readFileSync(join(here, '..', 'importer', 'imported-assets.json'), 'utf8')) as Record<string, unknown>[];
  const members = (await db.collection(`tenants/${TENANT}/members`).get()).docs.map((d) => ({ uid: d.id, ...(d.data() as { email?: string }) }));
  const byEmail = new Map<string, string>();
  for (const m of members) if (m.email) byEmail.set(m.email.toLowerCase(), m.uid);
  const resolve = (email?: string | null): string | null => {
    if (!email) return null;
    const e = EMAIL_ALIAS[email] ?? email;
    return byEmail.get(e) ?? null;
  };

  let matched = 0, unmatchedWithEmail = 0;
  const docs = rows.map((r) => {
    const email = (r._email as string) ?? null;
    const uid = resolve(email);
    if (email) { if (uid) matched++; else unmatchedWithEmail++; }
    const { _email, ...rest } = r;
    void _email;
    // Firestore no admite undefined: filtra; assignedTo explícito.
    const doc = Object.fromEntries(Object.entries({ ...rest, assignedTo: uid }).filter(([, v]) => v !== undefined && v !== null || false)) as Record<string, unknown>;
    doc.assignedTo = uid; // conserva null explícito (el modelo lo admite)
    return doc;
  });

  console.log(`Activos a cargar: ${docs.length}`);
  console.log(`Usuario asignado resuelto a miembro: ${matched} | con email sin miembro (→ sin asignar): ${unmatchedWithEmail}`);
  console.log('Miembros del tenant:', members.length);
  console.log('\nMUESTRA (2):', JSON.stringify(docs.slice(0, 2), null, 1));

  if (!WRITE) { console.log('\n[DRY] No se ha escrito nada. Relanza con WRITE=1 para cargar.'); return; }

  let n = 0;
  for (let i = 0; i < docs.length; i += 400) {
    const batch = db.batch();
    for (const d of docs.slice(i, i + 400)) batch.set(db.doc(`tenants/${TENANT}/assets/${d.id as string}`), d, { merge: true });
    await batch.commit(); n += Math.min(400, docs.length - i);
    console.log(`  escritos ${n}/${docs.length}`);
  }
  console.log(`\n✓ ${docs.length} activos cargados en tenants/${TENANT}/assets`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
