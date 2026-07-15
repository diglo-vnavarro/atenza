// F4a · Aplica el catálogo de CATEGORÍAS DE SERVICIO (modo simplificado) al tenant
// en la nube, derivándolo de los datos reales: ciclos canónicos (por nombre),
// permisos por grupo y CAMPOS específicos desde las plantillas de cada categoría.
// Idempotente, con dry-run. NO cambia operationMode (lo decide el usuario).
//
//   GOOGLE_APPLICATION_CREDENTIALS=<adc> GOOGLE_CLOUD_PROJECT=diglo-desk-pd \
//   TENANT=diglo-it npx tsx scripts/apply-service-categories.ts            (aplica)
//   ...  DRY_RUN=1 npx tsx scripts/apply-service-categories.ts             (previsualiza)
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT ?? 'diglo-desk-pd';
const TENANT = process.env.TENANT ?? 'diglo-it';
const DRY = process.env.DRY_RUN === '1' || process.argv.includes('--dry-run');

// Ciclos canónicos (los 6 del modelo). Se resuelven a su id real por nombre.
const LC = { STD_INC: 'RLC - Incidencias v1.0', APPROVAL: 'RLC - Aprobaciones', ALTA: 'Alta de usuarios internos', BAJA: 'Baja de usuarios', OPS: 'Operaciones - Liquidaciones Informativas Deuda' } as const;
type LcKey = keyof typeof LC | 'SIMPLE';

// Mapa aprobado (Opción A). inc/req = clave de ciclo canónico o 'SIMPLE' (sin flujo)
// o ausente (tipo no permitido). src = categorías de servicio (group) de origen;
// srcNames = nombres de plantilla de origen (para categorías que parten un group).
interface CatSpec { name: string; icon: string; inc?: LcKey; req?: LcKey; ug?: string[]; src?: string[]; srcNames?: string[] }
const MAP: CatSpec[] = [
  { name: 'Incidencias generales', icon: '🛠️', inc: 'STD_INC', src: ['Plantillas generales de incidentes'] },
  { name: 'Reclamaciones de clientes', icon: '📣', inc: 'STD_INC', ug: ['UsuariosReclamaciones'], src: ['Reclamaciones  de Clientes'] },
  { name: 'Recovery', icon: '🔧', inc: 'STD_INC', req: 'SIMPLE', src: ['Recovery'] },
  { name: 'BI / Datos', icon: '📊', inc: 'STD_INC', req: 'SIMPLE', ug: ['Usuarios  BI'], src: ['Solicitudes BI'] },
  { name: 'PD', icon: '🗂️', inc: 'STD_INC', req: 'SIMPLE', ug: ['Usuarios PD'], src: ['Solicitudes PD'] },
  { name: 'AI · Gemini', icon: '✨', inc: 'STD_INC', req: 'SIMPLE', src: ['AI - Gemini'] },
  { name: 'Informes (Looker/Google)', icon: '📈', req: 'SIMPLE', src: ['Informes Looker'] },
  { name: 'ITSM BI', icon: '📶', req: 'SIMPLE', src: ['ITSM BI'] },
  { name: 'Alta de usuario', icon: '👤', req: 'ALTA', ug: ['CAU', 'IT', 'Usuarios RRHH'], srcNames: ['Alta de usuarios internos'] },
  { name: 'Baja de usuario', icon: '🚪', req: 'BAJA', ug: ['CAU', 'IT', 'Usuarios RRHH'], srcNames: ['Baja de usuario interno', 'Baja de usuario externo'] },
  { name: 'Modificación / alta externos', icon: '👥', req: 'ALTA', ug: ['IT', 'Usuarios alta/baja', 'Usuarios Responsable'], srcNames: ['Modificación de usuario', 'Alta de usuarios externos'] },
  { name: 'Peticiones generales', icon: '📥', req: 'SIMPLE', src: ['Peticiones'] },
  { name: 'Waiver', icon: '📝', req: 'APPROVAL', src: ['Solicitud Waiver'] },
  { name: 'Operaciones · Liquidaciones deuda', icon: '💶', req: 'OPS', ug: ['IT', 'Usuarios NPL', 'Usuarios Operaciones'], src: ['Operaciones'] },
  { name: 'Tareas REO', icon: '🏠', inc: 'STD_INC', req: 'SIMPLE', src: ['Tareas REO'] },
  { name: 'Seguimiento Infoser/Diglo', icon: '🔎', req: 'SIMPLE', ug: ['Infoser', 'IT'], src: ['Seguimiento Operativo Infoser/Diglo'] },
];

// Etiquetas de campos de SISTEMA (comunes de la plantilla única) que NO son campos
// propios de categoría → se excluyen del pool específico.
const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const SYS = new Set(['asunto', 'titulo', 'descripcion', 'categoria', 'subcategoria', 'articulo', 'prioridad', 'impacto', 'urgencia', 'modo', 'sede', 'solicitante', 'adjuntos', 'estado', 'tecnico', 'grupo', 'nivel'].map(norm));

initializeApp({ projectId: PROJECT });
const db = getFirestore();

async function main() {
  console.log(`${DRY ? '=== DRY-RUN === ' : ''}Aplicar categorías de servicio a ${TENANT}.`);
  const lcs = (await db.collection(`tenants/${TENANT}/lifecycles`).get()).docs.map((d) => ({ id: d.id, ...(d.data() as { name?: string; type?: string }) }));
  const tpls = (await db.collection(`tenants/${TENANT}/templates`).get()).docs.map((d) => d.data() as { name?: string; group?: string; type?: string; fieldDefs?: { id: string; label: string; type: string; mandatory?: boolean; options?: string[] }[] });
  const lcId = (key: LcKey): string | null => {
    if (key === 'SIMPLE') return null;
    const name = LC[key];
    const hit = lcs.find((l) => l.name === name) ?? lcs.find((l) => (l.name ?? '').includes(name.replace(/ v1\.0$/, '')));
    if (!hit) console.warn(`  ⚠ ciclo canónico no encontrado: ${key} ("${name}")`);
    return hit?.id ?? null;
  };
  const fieldsFor = (spec: CatSpec) => {
    const src = tpls.filter((t) => (spec.src?.includes(t.group ?? '') ?? false) || (spec.srcNames?.includes(t.name ?? '') ?? false));
    const seen = new Set<string>(); const out: { id: string; label: string; type: string; mandatory?: boolean; requesterVisible: boolean; section: string; col: 1 | 2; options?: string[] }[] = [];
    let col: 1 | 2 = 1;
    for (const t of src) for (const f of t.fieldDefs ?? []) {
      if (SYS.has(norm(f.label))) continue; const k = norm(f.label); if (seen.has(k)) continue; seen.add(k);
      out.push({ id: f.id, label: f.label, type: f.type, requesterVisible: true, section: 'Campos de la categoría', col, ...(f.mandatory ? { mandatory: true } : {}), ...(f.options ? { options: f.options } : {}) });
      col = col === 1 ? 2 : 1;
    }
    return out;
  };

  const cats = MAP.map((spec, i) => {
    const c: Record<string, unknown> = { id: 'sc-' + (i + 1), name: spec.name, icon: spec.icon };
    if (spec.inc) c.incident = { lifecycleId: lcId(spec.inc) };
    if (spec.req) c.service_request = { lifecycleId: lcId(spec.req) };
    if (spec.ug?.length) c.userGroups = spec.ug;
    const f = fieldsFor(spec); if (f.length) c.fields = f;
    return c;
  });

  console.log(`Ciclos en cloud: ${lcs.length} · plantillas: ${tpls.length}\n`);
  for (const c of cats as { name: string; incident?: { lifecycleId: string | null }; service_request?: { lifecycleId: string | null }; userGroups?: string[]; fields?: { label: string }[] }[]) {
    const tipos = [c.incident ? 'INC' : '', c.service_request ? 'PET' : ''].filter(Boolean).join('+');
    const lcInc = c.incident ? (lcs.find((l) => l.id === c.incident!.lifecycleId)?.name ?? 'sin flujo') : '';
    const lcReq = c.service_request ? (lcs.find((l) => l.id === c.service_request!.lifecycleId)?.name ?? 'sin flujo') : '';
    console.log(`  ${c.name} [${tipos}]  INC→${lcInc || '—'} · PET→${lcReq || '—'}  ug=[${(c.userGroups ?? []).join(', ') || 'todos'}]  campos: ${(c.fields ?? []).map((f) => f.label).join(', ') || '—'}`);
  }
  console.log(`\n${cats.length} categorías.`);

  if (DRY) { console.log('DRY-RUN: nada escrito.'); return; }
  await db.doc(`tenants/${TENANT}`).set({ serviceCategories: cats }, { merge: true });
  console.log('Aplicado: tenant.serviceCategories (operationMode sin cambiar).');
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
