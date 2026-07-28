// Backfill/cobertura de la clasificación v3 (Fase 2). Lee los tickets de SDP,
// aplica classifyToV3 y reporta el % de cobertura (mapeados vs «Sin clasificar»),
// el desglose por área/servicio y las plantillas sin mapear.
//
//   --dry-run (por defecto): NO escribe nada; solo reporta.
//   Token SDP: env ZOHO_FILE=/ruta/.zoho.local (o .zoho.local en la raíz del repo).
//
//   ZOHO_FILE=../../.zoho.local npx tsx scripts/map-classification.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { classifyToV3, isUnclassified } from '../src/data/classification-map.js';
import { DIGLO_CLASSIFICATION_V3 } from '../src/data/classification-seed.js';

const APPLY = process.argv.includes('--apply');
const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const ZOHO = process.env.ZOHO_FILE ?? join(ROOT, '.zoho.local');
const BASE = process.env.SDP_BASE ?? 'https://digloitsm.sdpondemand.manageengine.eu/app/itdesk';
const ACCEPT = 'application/vnd.manageengine.sdp.v3+json';
const zoho = JSON.parse(readFileSync(ZOHO, 'utf8')) as { access_token: string; refresh_token?: string; client_id: string; client_secret: string };

// id → nombre (para el desglose legible)
const NAME: Record<string, string> = { 'sin-clasificar': 'Sin clasificar' };
for (const a of DIGLO_CLASSIFICATION_V3) { NAME[a.id] = a.name; for (const s of a.services) NAME[s.id] = s.name; }

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

interface Lite { template?: { name?: string }; category?: { name?: string }; subcategory?: { name?: string }; item?: { name?: string }; status?: { name?: string } }

async function main(): Promise<void> {
  await refresh();
  console.log(APPLY ? '⚠️  modo --apply (aún NO implementado el write en Fase 2): se comporta como dry-run.' : 'Modo dry-run (no escribe nada).');
  const FIELDS = ['template', 'category', 'subcategory', 'item', 'status'];
  const rows = 100; let start = 1, total: number | null = null, n = 0, unclassified = 0;
  const byArea: Record<string, number> = {}, byService: Record<string, number> = {}, unmappedTpl: Record<string, number> = {}, withElement = { yes: 0 };
  for (let page = 0; page < 600; page++) {
    const j = await api(`requests?input_data=${q({ list_info: { row_count: rows, start_index: start, get_total_count: true, fields_required: FIELDS } })}`);
    const arr = (j.requests as Lite[]) ?? [];
    if (page === 0) { total = (j.list_info as { total_count?: number })?.total_count ?? null; console.error(`total en SDP: ${total}`); }
    for (const r of arr) {
      n++;
      const v3 = classifyToV3({ template: r.template?.name, item: r.item?.name });
      byArea[v3.area] = (byArea[v3.area] ?? 0) + 1;
      byService[v3.service] = (byService[v3.service] ?? 0) + 1;
      if (v3.element) withElement.yes++;
      if (isUnclassified(v3)) { unclassified++; unmappedTpl[r.template?.name?.trim() || '(sin plantilla)'] = (unmappedTpl[r.template?.name?.trim() || '(sin plantilla)'] ?? 0) + 1; }
    }
    const li = j.list_info as { has_more_rows?: boolean } | undefined;
    if (!li?.has_more_rows || arr.length === 0) break;
    start += rows; if (n % 3000 < rows) { console.error(`  ${n}…`); await sleep(150); }
  }
  const mapped = n - unclassified;
  const pct = (x: number) => `${((100 * x) / n).toFixed(1)}%`;
  const show = (o: Record<string, number>, lbl: (k: string) => string) => Object.entries(o).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${String(v).padStart(6)}  ${lbl(k)}`));
  console.log(`\n===== COBERTURA v3 (dry-run) =====`);
  console.log(`Tickets: ${n} · mapeados: ${mapped} (${pct(mapped)}) · Sin clasificar: ${unclassified} (${pct(unclassified)}) · con elemento N3: ${withElement.yes} (${pct(withElement.yes)})`);
  console.log(`\n--- por Área ---`); show(byArea, (k) => NAME[k] ?? k);
  console.log(`\n--- por Servicio ---`); show(byService, (k) => NAME[k] ?? k);
  console.log(`\n--- plantillas SIN mapear (→ Sin clasificar) ---`); show(unmappedTpl, (k) => k);
}
main().catch((e) => { console.error('ERROR:', (e as Error).message); process.exit(1); });
