// ============================================================================
// ETL de ACTIVOS: SDP (API v3) -> importer/imported-assets.json
//   Trae la lista + el detalle de cada activo (usuario asignado, nº serie,
//   etiqueta, garantía, compra, departamento…) y los mapea al modelo Asset de
//   Atenza. El usuario asignado se guarda como email en `_email` (el cargador
//   scripts/load-assets.ts lo resuelve a uid contra los miembros del tenant).
//   Solo LECTURA de SDP. Token: refresh desde .zoho.local (scope assets.READ).
//     npx tsx importer/assets-etl.ts
// ============================================================================
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const ZOHO = join(here, '..', '.zoho.local');
const BASE = 'https://digloitsm.sdpondemand.manageengine.eu/app/itdesk';
const ACCEPT = 'application/vnd.manageengine.sdp.v3+json';
const zoho = JSON.parse(readFileSync(ZOHO, 'utf8')) as { access_token: string; refresh_token: string; client_id: string; client_secret: string };

async function refresh(): Promise<void> {
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: zoho.refresh_token, client_id: zoho.client_id, client_secret: zoho.client_secret });
  const r = await fetch('https://accounts.zoho.eu/oauth/v2/token', { method: 'POST', body });
  const j = (await r.json()) as { access_token?: string };
  if (j.access_token) { zoho.access_token = j.access_token; try { writeFileSync(ZOHO, JSON.stringify(zoho)); } catch { /* ro */ } }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function api(path: string): Promise<Record<string, unknown>> {
  for (let a = 0; a < 5; a++) {
    const res = await fetch(`${BASE}/api/v3/${path}`, { headers: { Authorization: `Zoho-oauthtoken ${zoho.access_token}`, Accept: ACCEPT } });
    if (res.status === 401) { await refresh(); continue; }
    if (res.status === 429) { await sleep(2000); continue; }
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }
  throw new Error(`${path}: reintentos agotados`);
}
const listUrl = (start: number) => `assets?input_data=${encodeURIComponent(JSON.stringify({ list_info: { row_count: 100, start_index: start, get_total_count: true } }))}`;

// ---- mapeos ----
type S = Record<string, unknown>;
const nm = (o: unknown): string | undefined => (o && typeof o === 'object' ? ((o as S).name as string) : undefined) || undefined;
const epoch = (o: unknown): number | null => { const v = o && typeof o === 'object' ? (o as S).value : undefined; const n = v ? Number(v) : NaN; return Number.isFinite(n) && n > 0 ? n : null; };
const num = (v: unknown): number | null => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };

const STATE: Record<string, string> = { 'In Use': 'in_use', 'In Store': 'in_stock', 'In Repair': 'repair', 'Disposed': 'retired', 'Expired': 'retired', 'Retired': 'retired' };
function mapState(s?: string): string { return STATE[s ?? ''] ?? 'in_stock'; }
const DESKTOP_KW = /optiplex|desktop|torre|tower|mini\s?pc|thinkcentre|prodesk|elitedesk|sobremesa|aio|all[- ]?in[- ]?one/i;
function mapType(pt?: string, model?: string): string {
  switch ((pt ?? '').toLowerCase()) {
    case 'pantallas': case 'monitor': return 'Monitor';
    case 'smartphone': case 'mobile': case 'móvil': case 'movil': return 'Móvil';
    case 'tablet': return 'Tablet';
    case 'router': case 'switch': case 'network': case 'access point': return 'Red';
    case 'printer': case 'impresora': return 'Impresora';
    case 'server': case 'servidor': return 'Servidor';
    case 'workstation': case 'computer': case 'laptop': case 'notebook':
      return DESKTOP_KW.test(model ?? '') ? 'Sobremesa' : 'Portátil';
    default: return pt || 'Otro';
  }
}

async function main() {
  await refresh();
  // 1) ids de todos los activos
  const ids: string[] = [];
  for (let start = 0; start < 5000; start += 100) {
    const d = await api(listUrl(start));
    const arr = (d.assets as S[]) ?? [];
    for (const a of arr) ids.push(String(a.id));
    if (!(d.list_info as S | undefined)?.has_more_rows) break;
  }
  console.log(`Activos listados: ${ids.length}. Trayendo detalle…`);

  // 2) detalle + mapeo
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < ids.length; i++) {
    const d = await api(`assets/${ids[i]}`);
    const a = (d.asset as S) ?? {};
    const product = (a.product as S) ?? {};
    const model = (product.name as string) || undefined;
    const pt = nm(a.product_type) ?? nm(product.product_type);
    const topName = (a.name as string) || '';
    const tag = (a.asset_tag as string) || (a.barcode as string) || undefined;
    const name = (topName && topName !== '-' ? topName : '') || model || tag || `Activo ${a.id}`;
    const email = ((a.user as S)?.email_id as string) || undefined;
    out.push({
      id: `SDP-${a.id}`,
      name,
      tag,
      productType: mapType(pt, model),
      serial: (a.serial_number as string) || (a.discovered_serial_number as string) || undefined,
      status: mapState(nm(a.state)),
      assignedTo: null,
      _email: email ? email.toLowerCase() : null,
      site: nm(a.site),
      department: nm(a.department),
      vendor: nm(a.vendor),
      model,
      purchaseDate: epoch(a.acquisition_date),
      warrantyUntil: epoch(a.warranty_expiry) ?? epoch(a.expiry_date),
      cost: num(a.total_cost) ?? num(a.purchase_cost),
      notes: '',
      createdAt: epoch(a.created_time),
    });
    if ((i + 1) % 50 === 0) console.log(`  ${i + 1}/${ids.length}`);
    await sleep(60);
  }
  // limpia undefined (Firestore no los admite; el cargador hace lo propio, pero JSON ya limpio)
  const clean = out.map((o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)));
  writeFileSync(join(here, 'imported-assets.json'), JSON.stringify(clean, null, 1));
  // resumen
  const byType = new Map<string, number>(); const byStatus = new Map<string, number>(); let withUser = 0;
  for (const o of clean) { byType.set(o.productType as string, (byType.get(o.productType as string) ?? 0) + 1); byStatus.set(o.status as string, (byStatus.get(o.status as string) ?? 0) + 1); if (o._email) withUser++; }
  console.log(`\n✓ ${clean.length} activos -> importer/imported-assets.json`);
  console.log('Por tipo:', JSON.stringify(Object.fromEntries(byType)));
  console.log('Por estado:', JSON.stringify(Object.fromEntries(byStatus)));
  console.log(`Con usuario asignado (email): ${withUser}`);
  console.log('\nMUESTRA (2):'); console.log(JSON.stringify(clean.slice(0, 2), null, 1));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
