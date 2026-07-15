// F4c · PODA del modo clásico (destructivo). Dry-run por defecto; APPLY=1 escribe.
// Requiere haber hecho antes scripts/backup-config.ts (punto de retorno) + tag git.
//
// Pasos:
//  1. MIGRA los tickets clásicos al modelo simplificado: fija serviceCategoryId (por
//     plantilla→group→categoría; los no mapeados → «Incidencias generales») + type.
//     NO toca el status (los importados usan el catálogo plano de estados, que sigue
//     válido; los que casan un ciclo canónico conservan sus transiciones).
//  2. BORRA los ciclos de vida NO canónicos (no referenciados por ninguna categoría).
//  3. BORRA todas las plantillas clásicas (simplificado usa 'unified' + categorías).
//  No toca SLAs, grupos ni miembros.
//
//   GOOGLE_CLOUD_PROJECT=diglo-desk-pd TENANT=diglo-it [APPLY=1] npx tsx scripts/f4c-prune.ts
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT ?? 'diglo-desk-pd';
const TENANT = process.env.TENANT ?? 'diglo-it';
const APPLY = process.env.APPLY === '1';
const DEFAULT_CAT = 'Incidencias generales';

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

type Tpl = { name?: string; group?: string; type?: string };
type Cat = { id: string; name: string; incident?: unknown; service_request?: unknown };

async function main() {
  console.log(`\n===== F4c · PODA · ${TENANT} · ${APPLY ? 'APLICAR' : 'DRY-RUN'} =====\n`);
  const tplDocs = await db.collection(`tenants/${TENANT}/templates`).get();
  const tpls = new Map<string, Tpl>(tplDocs.docs.map((d) => [d.id, d.data() as Tpl]));
  const lcDocs = await db.collection(`tenants/${TENANT}/lifecycles`).get();
  const root = (await db.doc(`tenants/${TENANT}`).get()).data() ?? {};
  const cats = (root.serviceCategories ?? []) as Cat[];
  const catByName = new Map(cats.map((c) => [c.name, c]));
  const defaultCat = catByName.get(DEFAULT_CAT);
  if (!defaultCat) throw new Error(`No existe la categoría por defecto "${DEFAULT_CAT}"`);

  const catOf = (t?: Tpl): Cat => {
    const spec = t && MAP.find((m) => (m.src?.includes(t.group ?? '') ?? false) || (m.srcNames?.includes(t.name ?? '') ?? false));
    return (spec && catByName.get(spec.name)) || defaultCat;
  };
  const typeOf = (t?: Tpl, tk?: { type?: string }): 'incident' | 'service_request' => {
    const ty = (tk?.type ?? t?.type ?? 'incident') as 'incident' | 'service_request';
    const cat = catOf(t);
    // Si la categoría no admite ese tipo, usa el que sí admita.
    if (cat[ty]) return ty;
    return cat.incident ? 'incident' : 'service_request';
  };

  // ---- 1. Migración de tickets ----
  const tkDocs = await db.collection(`tenants/${TENANT}/tickets`).get();
  const migr: { id: string; patch: Record<string, string> }[] = [];
  for (const d of tkDocs.docs) {
    const tk = d.data() as { templateId?: string; type?: string; serviceCategoryId?: string; serviceCategory?: string };
    if (tk.serviceCategoryId) continue;
    const tpl = tk.templateId ? tpls.get(tk.templateId) : undefined;
    const cat = catOf(tpl); const type = typeOf(tpl, tk);
    migr.push({ id: d.id, patch: { serviceCategoryId: cat.id, serviceCategory: cat.name, type } });
  }

  // ---- 2. Ciclos no canónicos ----
  const canonical = new Set<string>();
  for (const c of cats) for (const k of ['incident', 'service_request'] as const) { const id = (c[k] as { lifecycleId?: string } | undefined)?.lifecycleId; if (id) canonical.add(id); }
  const delLc = lcDocs.docs.filter((d) => !canonical.has(d.id));

  console.log(`1. Migrar tickets → categoría/tipo: ${migr.length} (de ${tkDocs.size})`);
  console.log(`2. Borrar ciclos no canónicos: ${delLc.length} (conservar ${canonical.size})`);
  console.log(`3. Borrar plantillas clásicas: ${tplDocs.size}`);

  if (!APPLY) { console.log('\nDRY-RUN: nada escrito. Repite con APPLY=1 (tras backup + tag).\n'); return; }

  const commit = async (ops: { ref: FirebaseFirestore.DocumentReference; data?: Record<string, unknown> }[], del: boolean) => {
    for (let i = 0; i < ops.length; i += 400) {
      const batch = db.batch();
      for (const o of ops.slice(i, i + 400)) del ? batch.delete(o.ref) : batch.set(o.ref, o.data!, { merge: true });
      await batch.commit();
    }
  };
  await commit(migr.map((m) => ({ ref: db.doc(`tenants/${TENANT}/tickets/${m.id}`), data: m.patch })), false);
  console.log(`  ✓ ${migr.length} tickets migrados`);
  await commit(delLc.map((d) => ({ ref: d.ref })), true);
  console.log(`  ✓ ${delLc.length} ciclos borrados`);
  await commit(tplDocs.docs.map((d) => ({ ref: d.ref })), true);
  console.log(`  ✓ ${tplDocs.size} plantillas borradas`);
  console.log('\nPoda completada. (operationMode ya es simplified; el código mantiene ambos modos.)\n');
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
