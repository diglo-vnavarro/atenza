// Orquestador del importador: trae metadatos de SDP v3, los mapea al modelo de
// Atenza y escribe importer/imported-seed.json.
//
//   SDP_OAUTH_TOKEN=xxxx npm run import
//
// Requiere Node 18+ (fetch global). Ver README para conseguir el token OAuth.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { configFromEnv, fetchAll, ENDPOINTS } from './client.js';
import { mapSnapshot, type SdpRaw } from './map.js';

const here = dirname(fileURLToPath(import.meta.url));

async function main() {
  const cfg = configFromEnv();
  const instanceName = process.env.SDP_INSTANCE_NAME ?? 'Diglo ITSM (importado)';
  const corpDomain = process.env.SDP_CORP_DOMAIN ?? 'digloservicer.com';
  console.log('Importando de', cfg.base);

  const grab = async (resource: string) => {
    try { const a = await fetchAll(cfg, resource); console.log(`  ${resource}: ${a.length}`); return a; }
    catch (e) { console.warn(`  ${resource}: ERROR ${(e as Error).message}`); return []; }
  };

  const raw: SdpRaw = {
    instanceName, corpDomain,
    templates: await grab(ENDPOINTS.templates) as never,
    categories: await grab(ENDPOINTS.categories) as never,
    slas: await grab(ENDPOINTS.slas) as never,
    groups: await grab(ENDPOINTS.groups) as never,
    technicians: await grab(ENDPOINTS.technicians) as never,
    requesters: await grab(ENDPOINTS.requesters) as never,
    priorities: await grab(ENDPOINTS.priorities) as never,
    statuses: await grab(ENDPOINTS.statuses) as never,
  };

  const snapshot = mapSnapshot(raw);
  const outPath = join(here, 'imported-seed.json');
  writeFileSync(outPath, JSON.stringify(snapshot, null, 2), 'utf8');
  console.log('\nEscrito', outPath);
  console.log(`  categorías: ${snapshot.categories.length} · plantillas: ${snapshot.templates.length} · SLAs: ${snapshot.slas.length} · grupos: ${snapshot.groups.length} · personas: ${snapshot.members.length}`);
  console.log('Cárgalo en la app con Administración → Catálogo → «Importar datos» (pega el JSON).');
}

main().catch((e) => { console.error(e); process.exit(1); });
