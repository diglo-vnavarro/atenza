// AUDITORÍA (solo lectura): por cada categoría de servicio del modo simplificado,
// compara sus campos ACTUALES con TODOS los campos de sus plantillas de origen en
// SDP (fieldDefs en Firestore). Reporta lo que quedó FUERA:
//   · [SISTEMA]  = campo común de la plantilla única (correcto que no esté).
//   · [FALTA]    = campo propio de la plantilla que NO está en la categoría (candidato a añadir).
// No escribe nada. Base para decidir qué campos incorporar.
//
//   GOOGLE_CLOUD_PROJECT=diglo-desk-pd TENANT=diglo-it npx tsx scripts/audit-category-fields.ts
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT ?? 'diglo-desk-pd';
const TENANT = process.env.TENANT ?? 'diglo-it';

// Misma correspondencia categoría → plantillas de origen que apply-service-categories.ts.
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

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const SYS = new Set(['asunto', 'titulo', 'descripcion', 'categoria', 'subcategoria', 'articulo', 'prioridad', 'impacto', 'urgencia', 'modo', 'sede', 'sitio', 'solicitante', 'adjuntos', 'estado', 'tecnico', 'grupo', 'nivel', 'correos a notificar', 'emails to notify'].map(norm));

initializeApp({ projectId: PROJECT });
const db = getFirestore();

type FD = { id: string; label: string; type: string; mandatory?: boolean; options?: string[] };

async function main() {
  const tpls = (await db.collection(`tenants/${TENANT}/templates`).get()).docs.map((d) => d.data() as { name?: string; group?: string; fieldDefs?: FD[] });
  const cats = ((await db.doc(`tenants/${TENANT}`).get()).data()?.serviceCategories ?? []) as { name: string; fields?: FD[] }[];

  let totalFaltan = 0;
  for (const spec of MAP) {
    const cat = cats.find((c) => c.name === spec.name);
    const srcTpls = tpls.filter((t) => (spec.src?.includes(t.group ?? '') ?? false) || (spec.srcNames?.includes(t.name ?? '') ?? false));
    const catLabels = new Set((cat?.fields ?? []).map((f) => norm(f.label)));

    // Todos los campos distintos de las plantillas de origen.
    const seen = new Map<string, FD>();
    for (const t of srcTpls) for (const f of t.fieldDefs ?? []) if (!seen.has(norm(f.label))) seen.set(norm(f.label), f);

    const faltan = [...seen.values()].filter((f) => !SYS.has(norm(f.label)) && !catLabels.has(norm(f.label)));
    const sistema = [...seen.values()].filter((f) => SYS.has(norm(f.label)));

    console.log(`\n■ ${spec.name}`);
    console.log(`   plantillas origen: ${srcTpls.length ? srcTpls.map((t) => t.name).join(' · ') : '⚠ NINGUNA (revisar src/srcNames)'}`);
    console.log(`   campos en categoría: ${(cat?.fields ?? []).map((f) => f.label).join(', ') || '—'}`);
    if (faltan.length) { totalFaltan += faltan.length; console.log(`   [FALTAN ${faltan.length}]: ${faltan.map((f) => `${f.label} (${f.type}${f.mandatory ? ', oblig' : ''})`).join(' · ')}`); }
    else console.log('   [FALTAN 0] ✓ la categoría cubre todos los campos propios de sus plantillas');
    if (sistema.length) console.log(`   [sistema, correcto omitir]: ${sistema.map((f) => f.label).join(', ')}`);
  }
  console.log(`\n== Total campos candidatos a añadir: ${totalFaltan} ==`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
