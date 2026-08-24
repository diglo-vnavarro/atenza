// Sprint 2 — activa la clasificación v2 (árbol del Excel: Categoría·Subcategoría·Tipología
// con grupo por nodo) en el tenant real. Reconcilia grupos: renombra los del Excel,
// crea los nuevos, y resuelve el resto por nombre normalizado (sin tildes). Construye el
// classificationTree y pone classificationVersion='v3'. Reversible (volver a 'legacy').
//
//   dry-run (por defecto): NO escribe; muestra renombrados/creados + árbol resuelto.
//   --apply: reconcilia grupos + escribe classificationTree + flag.
//   GOOGLE_CLOUD_PROJECT=diglo-desk-pd TENANT=diglo-it npx tsx scripts/activate-taxonomia-v2.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import type { AreaNode, ServiceNode, ElementNode } from '../src/model.js';

const APPLY = process.argv.includes('--apply');
const PROJECT = process.env.GOOGLE_CLOUD_PROJECT ?? 'diglo-desk-pd';
const TENANT = process.env.TENANT ?? 'diglo-it';
const here = dirname(fileURLToPath(import.meta.url));

interface RawTip { name: string; group?: string; note?: string; nuevo?: boolean }
interface RawSub { name: string; group?: string; note?: string; nuevo?: boolean; tips?: RawTip[] }
interface RawCat { name: string; group?: string; note?: string; subs?: RawSub[] }
const raw = JSON.parse(readFileSync(join(here, '..', 'importer', 'taxonomia-v2.json'), 'utf8')) as RawCat[];

// Renombrados del Excel (grupo real actual → nombre nuevo). El resto se resuelve por
// nombre normalizado (sin tildes / minúsculas), y lo que no exista se crea.
const RENAME: Record<string, string> = {
  'Tecnicos Gemini': 'Técnicos IA',
  'Tecnicos ITSM BI': 'Técnicos BI',
  'Tecnicos BI': 'Técnicos IT',
};

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
const slug = (s: string) => 'n-' + norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);

initializeApp({ projectId: PROJECT });
const db = getFirestore();

async function main(): Promise<void> {
  const snap = await db.collection(`tenants/${TENANT}/groups`).get();
  const real = snap.docs.map((d) => ({ id: d.id, name: String(d.data().name ?? '').trim() }));
  const renames: { id: string; from: string; to: string }[] = [];
  for (const r of real) if (RENAME[r.name]) { renames.push({ id: r.id, from: r.name, to: RENAME[r.name]! }); r.name = RENAME[r.name]!; }
  const byNorm = new Map(real.map((r) => [norm(r.name), r]));
  const creates: { id: string; name: string }[] = [];
  const resolveGroup = (name?: string): string | undefined => {
    if (!name) return undefined;
    const hit = byNorm.get(norm(name));
    if (hit) return hit.id;
    const ex = creates.find((c) => norm(c.name) === norm(name));
    if (ex) return ex.id;
    const id = db.collection(`tenants/${TENANT}/groups`).doc().id;
    creates.push({ id, name }); byNorm.set(norm(name), { id, name });
    return id;
  };

  const tree: AreaNode[] = raw.map((c, ci) => {
    let subs = c.subs ?? [];
    if (!subs.length && c.group) subs = [{ name: c.name, group: c.group }]; // categoría con grupo directo → 1 servicio
    const services: ServiceNode[] = subs.map((s, si) => {
      const elements: ElementNode[] = (s.tips ?? []).map((t) => ({ id: slug(`${c.name}-${s.name}-${t.name}`), name: t.name, ...(resolveGroup(t.group) ? { groupId: resolveGroup(t.group)! } : {}) }));
      return { id: slug(`${c.name}-${s.name}`), name: s.name, sortIndex: si + 1, ...(resolveGroup(s.group) ? { groupId: resolveGroup(s.group)! } : {}), ...(elements.length ? { elements } : {}) };
    });
    return { id: slug(c.name), name: c.name, sortIndex: ci + 1, ...(resolveGroup(c.group) ? { groupId: resolveGroup(c.group)! } : {}), services };
  });

  console.log(`Grupos reales en ${TENANT}: ${real.length}`);
  console.log(`\n=== RENOMBRAR (${renames.length}) ===`); renames.forEach((r) => console.log(`  «${r.from}» → «${r.to}»`));
  console.log(`\n=== CREAR (${creates.length}) ===`); creates.forEach((c) => console.log(`  + «${c.name}»`));
  console.log(`\n=== ÁRBOL (${tree.length} categorías) ===`);
  for (const a of tree) {
    console.log(`■ ${a.name}${a.groupId ? '' : ''}`);
    for (const s of a.services) console.log(`   - ${s.name}${s.groupId ? ` → ${real.concat(creates).find((g) => g.id === s.groupId)?.name ?? s.groupId}` : ''}${s.elements ? ` (${s.elements.length} tipologías)` : ''}`);
  }

  if (APPLY) {
    const batch = db.batch();
    for (const r of renames) batch.update(db.doc(`tenants/${TENANT}/groups/${r.id}`), { name: r.to });
    for (const c of creates) batch.set(db.doc(`tenants/${TENANT}/groups/${c.id}`), { name: c.name });
    await batch.commit();
    await db.doc(`tenants/${TENANT}`).set({ classificationTree: tree, classificationVersion: 'v3' }, { merge: true });
    console.log(`\n✓ APLICADO: ${renames.length} renombrados, ${creates.length} creados, classificationTree (${tree.length} cat.) + classificationVersion='v3'.`);
    console.log(`  Rollback: classificationVersion='legacy' (el árbol y los grupos se conservan).`);
  } else {
    console.log(`\n(dry-run: NO se ha escrito nada. Revisa renombrados/creados/árbol y añade --apply.)`);
  }
}
main().catch((e) => { console.error('ERROR:', (e as Error).message); process.exit(1); });
