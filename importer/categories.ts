// Importa la jerarquía real Categoría › Subcategoría › Artículo de SDP (API v3)
// a importer/imported-categories.json (CatNode[]). Token desde .zoho.local.
//   npx tsx importer/categories.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const ZOHO = join(ROOT, '.zoho.local');
const BASE = process.env.SDP_BASE ?? 'https://digloitsm.sdpondemand.manageengine.eu/app/itdesk';
const ACCEPT = 'application/vnd.manageengine.sdp.v3+json';

interface Tok { access_token: string; refresh_token?: string; client_id: string; client_secret: string }
const zoho: Tok = JSON.parse(readFileSync(ZOHO, 'utf8'));
async function refresh(): Promise<void> {
  if (!zoho.refresh_token) return;
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: zoho.refresh_token, client_id: zoho.client_id, client_secret: zoho.client_secret });
  const r = await fetch('https://accounts.zoho.eu/oauth/v2/token', { method: 'POST', body });
  const j = (await r.json()) as { access_token?: string };
  if (j.access_token) { zoho.access_token = j.access_token; writeFileSync(ZOHO, JSON.stringify(zoho)); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function api(path: string): Promise<Record<string, unknown>> {
  for (let a = 0; a < 4; a++) {
    const res = await fetch(`${BASE}/api/v3/${path}`, { headers: { Authorization: `Zoho-oauthtoken ${zoho.access_token}`, Accept: ACCEPT } });
    if (res.status === 401) { await refresh(); continue; }
    if (res.status === 429) { await sleep(2000); continue; }
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }
  throw new Error(`${path}: reintentos agotados`);
}
const li = (rows = 100, start = 1) => encodeURIComponent(JSON.stringify({ list_info: { row_count: rows, start_index: start } }));

interface Named { id: string; name: string }
async function page(path: string, key: string): Promise<Named[]> {
  const out: Named[] = []; let start = 1;
  for (let p = 0; p < 30; p++) {
    const j = await api(`${path}${path.includes('?') ? '&' : '?'}input_data=${li(100, start)}`);
    const arr = (j[key] as Named[]) ?? []; out.push(...arr);
    const info = j.list_info as { has_more_rows?: boolean } | undefined;
    if (!info?.has_more_rows || !arr.length) break; start += 100;
  }
  return out;
}

async function main() {
  await refresh();
  const cats = await page('categories', 'categories');
  console.log(`Categorías: ${cats.length}`);
  const tree: { name: string; subs: { name: string; items: string[] }[] }[] = [];
  let n = 0;
  for (const c of cats) {
    const subs = await page(`categories/${c.id}/subcategories`, 'subcategories').catch(() => []);
    const outSubs: { name: string; items: string[] }[] = [];
    for (const s of subs) {
      const items = await page(`categories/${c.id}/subcategories/${s.id}/items`, 'items').catch(() => []);
      outSubs.push({ name: s.name, items: items.map((i) => i.name) });
      if (++n % 20 === 0) await sleep(300);
    }
    tree.push({ name: c.name, subs: outSubs });
    console.log(`  ${c.name}: ${outSubs.length} subcategorías`);
  }
  writeFileSync(join(here, 'imported-categories.json'), JSON.stringify(tree, null, 2));
  const totalItems = tree.reduce((a, c) => a + c.subs.reduce((b, s) => b + s.items.length, 0), 0);
  console.log(`\nHecho. ${tree.length} categorías · ${tree.reduce((a, c) => a + c.subs.length, 0)} subcategorías · ${totalItems} artículos`);
  console.log('Escrito importer/imported-categories.json');
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
