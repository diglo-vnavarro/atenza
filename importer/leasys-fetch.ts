// Reconocimiento (SOLO LECTURA) de la instancia Leasys: baja config + todos los
// tickets a importer/leasys-raw.json y caracteriza estados/categorías/grupos para
// diseñar bien el tenant. Auth: .zoho.leasys.local. Base: portal digloitsmleasys.
//   npx tsx importer/leasys-fetch.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const ZOHO = join(here, '..', '.zoho.leasys.local');
const BASE = 'https://digloitsm.sdpondemand.manageengine.eu/app/digloitsmleasys';
const ACCEPT = 'application/vnd.manageengine.sdp.v3+json';
const zoho = JSON.parse(readFileSync(ZOHO, 'utf8')) as { access_token: string; refresh_token: string; client_id: string; client_secret: string };
async function refresh() {
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: zoho.refresh_token, client_id: zoho.client_id, client_secret: zoho.client_secret });
  const r = await fetch('https://accounts.zoho.eu/oauth/v2/token', { method: 'POST', body });
  const j = (await r.json()) as { access_token?: string }; if (j.access_token) zoho.access_token = j.access_token;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function api(path: string): Promise<Record<string, unknown>> {
  for (let a = 0; a < 5; a++) {
    const res = await fetch(`${BASE}/api/v3/${path}`, { headers: { Authorization: `Zoho-oauthtoken ${zoho.access_token}`, Accept: ACCEPT } });
    if (res.status === 401) { await refresh(); continue; }
    if (res.status === 429) { await sleep(2000); continue; }
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
    return (await res.json()) as Record<string, unknown>;
  }
  throw new Error(`${path}: reintentos agotados`);
}
const li = (o: object) => encodeURIComponent(JSON.stringify({ list_info: o }));
async function all(res: string, key: string, fields?: string[]): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = []; let start = 0;
  for (let p = 0; p < 60; p++) {
    const info: Record<string, unknown> = { row_count: 100, start_index: start, get_total_count: true };
    if (fields) info.fields_required = fields;
    const d = await api(`${res}?input_data=${li(info)}`); const arr = (d[key] as Record<string, unknown>[]) ?? [];
    out.push(...arr); if (!(d.list_info as { has_more_rows?: boolean } | undefined)?.has_more_rows || !arr.length) break; start += 100;
  }
  return out;
}
async function main() {
  await refresh();
  console.log('Bajando configuración de Leasys…');
  const statuses = await all('statuses', 'statuses');
  const categories = await all('categories', 'categories');
  const groups = await all('groups', 'groups');
  const technicians = await all('technicians', 'technicians');
  const requesters = await all('requesters', 'requesters');
  const priorities = await all('priorities', 'priorities');
  const sites = await all('sites', 'sites');
  console.log('Bajando tickets (todos)…');
  const tickets = await all('requests', 'requests', ['id', 'display_id', 'subject', 'status', 'priority', 'category', 'subcategory', 'group', 'technician', 'requester', 'created_time', 'is_service_request', 'template']);
  writeFileSync(join(here, 'leasys-raw.json'), JSON.stringify({ statuses, categories, groups, technicians, requesters, priorities, sites, tickets }, null, 1));

  // caracterización
  const nm = (o: unknown) => (o && typeof o === 'object' ? (o as { name?: string }).name : undefined);
  console.log(`\n== LEASYS ==`);
  console.log(`tickets: ${tickets.length} · técnicos: ${technicians.length} · grupos: ${groups.length} · solicitantes: ${requesters.length} · sedes: ${sites.length}`);
  console.log(`\nESTADOS (${statuses.length}):`); statuses.forEach((s) => console.log(`  «${s.name}» internal=${s.internal_name ?? '-'} stop_timer=${s.stop_timer ?? '-'}`));
  console.log(`\nCATEGORÍAS (${categories.length}): ${categories.map((c) => c.name).join(' · ')}`);
  console.log(`\nGRUPOS: ${groups.map((g) => g.name).join(' · ')}`);
  const byStatus: Record<string, number> = {}; const byCat: Record<string, number> = {}; let sr = 0;
  for (const t of tickets) { const s = (nm(t.status) as string) ?? '∅'; byStatus[s] = (byStatus[s] ?? 0) + 1; const c = (nm(t.category) as string) ?? 'Sin categoría'; byCat[c] = (byCat[c] ?? 0) + 1; if (t.is_service_request) sr++; }
  console.log(`\nTICKETS por estado:`); Object.entries(byStatus).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${v}\t«${k}»`));
  console.log(`\nTICKETS por categoría:`); Object.entries(byCat).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${v}\t«${k}»`));
  console.log(`\ntipo: ${sr} peticiones · ${tickets.length - sr} incidencias`);
  console.log('\n✓ importer/leasys-raw.json escrito.');
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
