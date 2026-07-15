// F4c · ANÁLISIS (solo lectura) de la poda del modo clásico. NO escribe nada.
// Reporta el impacto real:
//  · Tickets: propone categoría por (plantilla→group) y comprueba que el ciclo de la
//    categoría COINCIDE con el ciclo actual del ticket (para no romper sus estados).
//    Clasifica: OK (ciclo preservado) · MISMATCH (ciclo distinto) · SIN-MAPA (plantilla
//    sin categoría) · ESTADO-LIBRE (status ya en el catálogo plano de estados).
//  · Ciclos de vida: canónicos (referenciados por categorías, se CONSERVAN) vs resto
//    (candidatos a BORRAR).
//  · Plantillas: todas las clásicas son candidatas a borrar (simplificado usa 'unified').
//
//   GOOGLE_CLOUD_PROJECT=diglo-desk-pd TENANT=diglo-it npx tsx scripts/f4c-analyze.ts
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT ?? 'diglo-desk-pd';
const TENANT = process.env.TENANT ?? 'diglo-it';

// Correspondencia categoría → plantillas de origen (igual que apply-service-categories.ts).
const MAP: { name: string; src?: string[]; srcNames?: string[] }[] = [
  { name: 'Incidencias generales', src: ['Plantillas generales de incidentes'] },
  { name: 'Reclamaciones de clientes', src: ['Reclamaciones  de Clientes'] },
  { name: 'Recovery', src: ['Recovery'] },
  { name: 'BI / Datos', src: ['Solicitudes BI'] },
  { name: 'PD', src: ['Solicitudes PD'] },
  { name: 'AI · Gemini', src: ['AI - Gemini'] },
  { name: 'Informes (Looker/Google)', src: ['Informes Looker'] },
  { name: 'ITSM BI', src: ['ITSM BI'] },
  { name: 'Alta de usuario', srcNames: ['Alta de usuarios internos'] },
  { name: 'Baja de usuario', srcNames: ['Baja de usuario interno', 'Baja de usuario externo'] },
  { name: 'Modificación / alta externos', srcNames: ['Modificación de usuario', 'Alta de usuarios externos'] },
  { name: 'Peticiones generales', src: ['Peticiones'] },
  { name: 'Waiver', src: ['Solicitud Waiver'] },
  { name: 'Operaciones · Liquidaciones deuda', src: ['Operaciones'] },
  { name: 'Tareas REO', src: ['Tareas REO'] },
  { name: 'Seguimiento Infoser/Diglo', src: ['Seguimiento Operativo Infoser/Diglo'] },
];

initializeApp({ projectId: PROJECT });
const db = getFirestore();

type Tpl = { name?: string; group?: string; type?: string; lifecycleId?: string | null };
type Cat = { name: string; incident?: { lifecycleId: string | null }; service_request?: { lifecycleId: string | null } };
type Lc = { id: string; name?: string; states?: { key: string; label: string }[] };

async function main() {
  const tplDocs = await db.collection(`tenants/${TENANT}/templates`).get();
  const tpls = new Map<string, Tpl>(tplDocs.docs.map((d) => [d.id, d.data() as Tpl]));
  const lcs = new Map<string, Lc>((await db.collection(`tenants/${TENANT}/lifecycles`).get()).docs.map((d) => [d.id, { id: d.id, ...(d.data() as object) } as Lc]));
  const root = (await db.doc(`tenants/${TENANT}`).get()).data() ?? {};
  const cats = (root.serviceCategories ?? []) as Cat[];
  const flatStatuses = new Set(((root.statuses ?? []) as { name: string }[]).map((s) => s.name));

  const catByName = new Map(cats.map((c) => [c.name, c]));
  // plantilla → nombre de categoría (por group/name)
  const tplCat = (t: Tpl): string | null => {
    const spec = MAP.find((m) => (m.src?.includes(t.group ?? '') ?? false) || (m.srcNames?.includes(t.name ?? '') ?? false));
    return spec?.name ?? null;
  };
  const lcName = (id?: string | null) => (id ? lcs.get(id)?.name ?? id : '—');
  const statusInLc = (status: string, lcId?: string | null) => {
    if (!lcId) return false;
    const lc = lcs.get(lcId);
    return !!lc?.states?.some((s) => s.key === status || s.label === status);
  };

  // ---- Tickets ----
  const tkDocs = await db.collection(`tenants/${TENANT}/tickets`).get();
  const buckets = { ok: 0, mismatch: 0, sinmapa: 0, libre: 0, yaSC: 0 };
  const mismatches: string[] = [];
  const unmapped = new Map<string, number>();
  for (const d of tkDocs.docs) {
    const t = d.data() as { templateId?: string; status?: string; type?: string; serviceCategoryId?: string };
    if (t.serviceCategoryId) { buckets.yaSC++; continue; }
    const tpl = t.templateId ? tpls.get(t.templateId) : undefined;
    const catName = tpl ? tplCat(tpl) : null;
    const type = (t.type ?? tpl?.type ?? 'incident') as 'incident' | 'service_request';
    const cat = catName ? catByName.get(catName) : undefined;
    const targetLc = cat?.[type]?.lifecycleId ?? null;
    const curLc = tpl?.lifecycleId ?? null;
    const status = t.status ?? '';
    if (!catName) { buckets.sinmapa++; unmapped.set(tpl?.group ?? tpl?.name ?? t.templateId ?? '?', (unmapped.get(tpl?.group ?? tpl?.name ?? t.templateId ?? '?') ?? 0) + 1); continue; }
    if (flatStatuses.has(status)) { buckets.libre++; continue; } // estado del catálogo plano → válido siempre
    if (curLc === targetLc || statusInLc(status, targetLc)) { buckets.ok++; }
    else { buckets.mismatch++; if (mismatches.length < 15) mismatches.push(`${d.id}: "${status}" · ${catName} [${type}] ciclo ${lcName(targetLc)} ≠ actual ${lcName(curLc)}`); }
  }

  // ---- Ciclos ----
  const canonical = new Set<string>();
  for (const c of cats) { for (const k of ['incident', 'service_request'] as const) { const id = c[k]?.lifecycleId; if (id) canonical.add(id); } }
  const deletableLc = [...lcs.values()].filter((l) => !canonical.has(l.id));

  console.log(`\n===== F4c · ANÁLISIS DE PODA · ${TENANT} =====\n`);
  console.log(`TICKETS (${tkDocs.size}):`);
  console.log(`  ✓ OK (ciclo preservado):      ${buckets.ok}`);
  console.log(`  ✓ estado en catálogo plano:   ${buckets.libre}`);
  console.log(`  ⚠ MISMATCH (ciclo distinto):  ${buckets.mismatch}`);
  console.log(`  ⚠ SIN MAPA (plantilla→cat):   ${buckets.sinmapa}`);
  console.log(`  · ya tenían serviceCategoryId: ${buckets.yaSC}`);
  if (mismatches.length) { console.log('\n  Ejemplos de MISMATCH (status no existe en el ciclo destino):'); mismatches.forEach((m) => console.log('    - ' + m)); }
  if (unmapped.size) { console.log('\n  Plantillas SIN categoría (group/nombre):'); [...unmapped.entries()].sort((a, b) => b[1] - a[1]).forEach(([g, n]) => console.log(`    - ${g}: ${n} tickets`)); }

  console.log(`\nCICLOS DE VIDA (${lcs.size}):`);
  console.log(`  conservar (canónicos, usados por categorías): ${canonical.size}`);
  [...canonical].forEach((id) => console.log(`    ✓ ${lcName(id)}`));
  console.log(`  BORRAR (no referenciados por ninguna categoría): ${deletableLc.length}`);
  deletableLc.forEach((l) => console.log(`    ✗ ${l.name ?? l.id}`));

  console.log(`\nPLANTILLAS: ${tpls.size} clásicas → todas candidatas a borrar (simplificado usa 'unified' + categorías).`);
  console.log('\n(análisis, nada escrito)\n');
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
