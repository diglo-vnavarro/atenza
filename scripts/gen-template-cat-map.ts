// Genera importer/template-category-map.json = { <templateId SDP>: <nombre categoría de servicio> }
// a partir del snapshot de backup (plantilla→group) y del mapa aprobado. Lo usa el
// sync (scripts/sync-tickets.ts) para AUTO-CATEGORIZAR los tickets que llegan de SDP.
//   npx tsx scripts/gen-template-cat-map.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const BACKUP = process.env.BACKUP ?? join(here, 'backups', 'classic-diglo-it-2026-07-15.json');
// Mismo mapa que restore-service-cat.ts: categoría ← group (src) o nombre de plantilla (srcNames).
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

const snap = JSON.parse(readFileSync(BACKUP, 'utf8')) as { templates: { _id: string; name?: string; group?: string }[] };
const out: Record<string, string> = {};
for (const t of snap.templates) {
  const spec = MAP.find((m) => (m.src?.includes(t.group ?? '') ?? false) || (m.srcNames?.includes(t.name ?? '') ?? false));
  if (spec) out[t._id] = spec.name; // los no mapeados caen en el default del sync
}
const file = join(here, '..', 'importer', 'template-category-map.json');
writeFileSync(file, JSON.stringify(out, null, 1));
console.log(`✓ ${Object.keys(out).length} plantillas mapeadas → ${file}`);
console.log(Object.entries(out).map(([k, v]) => `  ${k} → ${v}`).join('\n'));
