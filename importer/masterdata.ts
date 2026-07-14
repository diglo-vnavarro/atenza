// Importa sedes y departamentos reales de SDP (API v3) a imported-masterdata.json.
//   npx tsx importer/masterdata.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const ZOHO = join(here, '..', '.zoho.local');
const BASE = process.env.SDP_BASE ?? 'https://digloitsm.sdpondemand.manageengine.eu/app/itdesk';
const ACCEPT = 'application/vnd.manageengine.sdp.v3+json';
interface Tok { access_token: string; refresh_token?: string; client_id: string; client_secret: string }
const zoho: Tok = JSON.parse(readFileSync(ZOHO, 'utf8'));
async function refresh() {
  if (!zoho.refresh_token) return;
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: zoho.refresh_token, client_id: zoho.client_id, client_secret: zoho.client_secret });
  const j = (await (await fetch('https://accounts.zoho.eu/oauth/v2/token', { method: 'POST', body })).json()) as { access_token?: string };
  if (j.access_token) { zoho.access_token = j.access_token; writeFileSync(ZOHO, JSON.stringify(zoho)); }
}
const li = (rows: number, start: number) => encodeURIComponent(JSON.stringify({ list_info: { row_count: rows, start_index: start } }));
async function page(resource: string, key: string): Promise<{ name?: string }[]> {
  const out: { name?: string }[] = []; let start = 1;
  for (let p = 0; p < 40; p++) {
    const res = await fetch(`${BASE}/api/v3/${resource}?input_data=${li(100, start)}`, { headers: { Authorization: `Zoho-oauthtoken ${zoho.access_token}`, Accept: ACCEPT } });
    if (!res.ok) throw new Error(`${resource}: HTTP ${res.status}`);
    const j = (await res.json()) as Record<string, unknown>;
    const arr = (j[key] as { name?: string }[]) ?? []; out.push(...arr);
    const info = j.list_info as { has_more_rows?: boolean } | undefined;
    if (!info?.has_more_rows || !arr.length) break; start += 100;
  }
  return out;
}
async function main() {
  await refresh();
  const sites = [...new Set((await page('sites', 'sites')).map((s) => s.name).filter(Boolean))] as string[];
  const departments = [...new Set((await page('departments', 'departments')).map((d) => d.name).filter(Boolean))] as string[];
  writeFileSync(join(here, 'imported-masterdata.json'), JSON.stringify({ sites, departments }, null, 2));
  console.log(`Sedes: ${sites.length} · Departamentos: ${departments.length}. Escrito imported-masterdata.json`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
