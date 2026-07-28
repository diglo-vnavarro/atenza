// Construye el índice de ENRUTADO VIVO (routingStats) desde el histórico de SDP:
// por (servicio v3) → grupo que RESOLVIÓ, con conteo total y reciente (12 meses).
// Es el dato del que aprende src/routing-live.ts. Ver Fase 7.
//
//   dry-run (por defecto): calcula y muestra; NO escribe.
//   --apply: escribe tenants/{TENANT}.routingStats en Firestore (requiere GCP ADC).
//   Token SDP: env ZOHO_FILE=/ruta/.zoho.local (o .zoho.local en la raíz del repo).
//
//   ZOHO_FILE=../../.zoho.local npx tsx scripts/build-routing-index.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { classifyToV3, isUnclassified } from '../src/data/classification-map.js';
import { DIGLO_CLASSIFICATION_V3 } from '../src/data/classification-seed.js';
import type { GroupStat, RoutingStats } from '../src/model.js';

const APPLY = process.argv.includes('--apply');
const TENANT = process.env.TENANT ?? 'diglo-it';
const NOW = Date.now();
const YEAR = 365 * 24 * 3600 * 1000;
const here = dirname(fileURLToPath(import.meta.url));
const ZOHO = process.env.ZOHO_FILE ?? join(here, '..', '.zoho.local');
const BASE = process.env.SDP_BASE ?? 'https://digloitsm.sdpondemand.manageengine.eu/app/itdesk';
const ACCEPT = 'application/vnd.manageengine.sdp.v3+json';
const zoho = JSON.parse(readFileSync(ZOHO, 'utf8')) as { access_token: string; refresh_token?: string; client_id: string; client_secret: string };

const NAME: Record<string, string> = {};
for (const a of DIGLO_CLASSIFICATION_V3) for (const s of a.services) NAME[s.id] = `${a.name} › ${s.name}`;

async function refresh(): Promise<void> {
  if (!zoho.refresh_token) return;
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: zoho.refresh_token, client_id: zoho.client_id, client_secret: zoho.client_secret });
  const r = await fetch('https://accounts.zoho.eu/oauth/v2/token', { method: 'POST', body });
  const j = (await r.json()) as { access_token?: string };
  if (j.access_token) zoho.access_token = j.access_token;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function api(path: string): Promise<Record<string, unknown>> {
  for (let a = 0; a < 5; a++) {
    const res = await fetch(`${BASE}/api/v3/${path}`, { headers: { Authorization: `Zoho-oauthtoken ${zoho.access_token}`, Accept: ACCEPT } });
    if (res.status === 401) { await refresh(); continue; }
    if (res.status === 429) { await sleep(2500); continue; }
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }
  throw new Error(`${path}: reintentos agotados`);
}
const q = (o: object) => encodeURIComponent(JSON.stringify(o));
const norm = (s?: string) => (s ?? '').trim();

interface Lite { template?: { name?: string }; item?: { name?: string }; group?: { name?: string }; technician?: { name?: string }; status?: { name?: string }; created_time?: { value?: string } }

// NOTA: se indexa por NOMBRE de grupo (legible + estable en SDP). Al aplicar a la instancia
// real, el árbol de clasificación debe usar el mismo espacio de claves para el `groupId`
// (nombre de grupo o un mapeo nombre→id) para que el prior y el índice casen.
function bump(byService: RoutingStats['byService'], svc: string, group: string, recent: boolean, at: number) {
  const node = (byService[svc] ??= {});
  const g: GroupStat = (node[group] ??= { resolved: 0, recent: 0 });
  g.resolved++; if (recent) g.recent++;
  if (!g.lastAt || at > g.lastAt) g.lastAt = at;
}

async function main(): Promise<void> {
  await refresh();
  const RESOLVED = new Set(['Resuelta', 'Cerrada']);
  const byService: RoutingStats['byService'] = {};
  const byServiceTech: RoutingStats['byService'] = {};
  const rows = 100; let start = 1, total: number | null = null, n = 0, used = 0;
  const FIELDS = ['template', 'item', 'group', 'technician', 'status', 'created_time'];
  for (let page = 0; page < 600; page++) {
    const j = await api(`requests?input_data=${q({ list_info: { row_count: rows, start_index: start, get_total_count: true, fields_required: FIELDS } })}`);
    const arr = (j.requests as Lite[]) ?? [];
    if (page === 0) { total = (j.list_info as { total_count?: number })?.total_count ?? null; console.error(`total SDP: ${total}`); }
    for (const r of arr) {
      n++;
      if (!RESOLVED.has(norm(r.status?.name))) continue;
      const grp = norm(r.group?.name); if (!grp) continue;
      const v3 = classifyToV3({ template: r.template?.name, item: r.item?.name });
      if (isUnclassified(v3)) continue;
      const at = r.created_time?.value ? Number(r.created_time.value) : 0;
      bump(byService, v3.service, grp, at >= NOW - YEAR, at);
      const tech = norm(r.technician?.name); if (tech) bump(byServiceTech, v3.service, tech, at >= NOW - YEAR, at);
      used++;
    }
    const li = j.list_info as { has_more_rows?: boolean } | undefined;
    if (!li?.has_more_rows || arr.length === 0) break;
    start += rows; if (n % 3000 < rows) { console.error(`  ${n}…`); await sleep(150); }
  }
  const stats: RoutingStats = { byService, byServiceTech, generatedAt: NOW };

  console.log(`\n===== ÍNDICE DE ENRUTADO VIVO (${used} tickets resueltos usados) =====`);
  for (const [svc, groups] of Object.entries(byService).sort()) {
    const tot = Object.values(groups).reduce((a, g) => a + g.resolved, 0);
    const top = Object.entries(groups).sort((a, b) => b[1].resolved - a[1].resolved).slice(0, 3)
      .map(([g, s]) => `${g} ${Math.round((s.resolved / tot) * 100)}% (${s.resolved}/${s.recent}rec)`).join(' · ');
    console.log(`■ ${NAME[svc] ?? svc}  [${tot}]  → ${top}`);
    const tg = byServiceTech[svc];
    if (tg) console.log(`    técnicos: ${Object.entries(tg).sort((a, b) => b[1].resolved - a[1].resolved).slice(0, 3).map(([g, s]) => `${g} ${s.resolved}`).join(' · ')}`);
  }

  if (APPLY) {
    const { initializeApp } = await import('firebase-admin/app');
    const { getFirestore } = await import('firebase-admin/firestore');
    initializeApp({ projectId: process.env.GOOGLE_CLOUD_PROJECT ?? 'diglo-desk-pd' });
    await getFirestore().doc(`tenants/${TENANT}`).set({ routingStats: stats }, { merge: true });
    console.log(`\n✓ routingStats escrito en tenants/${TENANT}`);
  } else {
    console.log(`\n(dry-run: no se ha escrito nada. Usa --apply para guardar en Firestore.)`);
  }
}
main().catch((e) => { console.error('ERROR:', (e as Error).message); process.exit(1); });
