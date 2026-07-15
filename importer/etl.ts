// ============================================================================
// ETL de tickets ACTIVOS: SDP (API v3) -> importer/imported-tickets.json
//   Alcance "abiertos/activos": todo estado excepto Cancelada / Cerrada / Resuelta
//   (Resuelta = ~17,5k resueltos-sin-cerrar, backlog parado, no trabajo activo).
// Trae lista + detalle (descripción/prioridad/categoría) de cada ticket, los
// mapea a StoredTicket de Atenza y recopila las personas (solicitante/técnico)
// referenciadas para importarlas también (subconjunto acotado, no las 929).
// El estado se mapea al key del estado del ciclo si su etiqueta coincide; si no,
// se guarda el nombre literal (la UI lo tolera). Token desde .zoho.local.
//
//   npx tsx importer/etl.ts
// ============================================================================
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Lifecycle } from '../src/model.js';
import type { StoredTicket, UiMember } from '../src/data/seed.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const ZOHO = join(ROOT, '.zoho.local');
const BASE = process.env.SDP_BASE ?? 'https://digloitsm.sdpondemand.manageengine.eu/app/itdesk';
const ACCEPT = 'application/vnd.manageengine.sdp.v3+json';
const CORP = process.env.SDP_CORP_DOMAIN ?? 'digloservicer.com';
// Alcance: 'active' (por defecto, convivencia = excluye Cancelada/Cerrada/Resuelta)
// o 'all' (ETL histórico COMPLETO para el corte por instancia; incluye todo, ~23k).
const SCOPE = process.env.SCOPE ?? 'active';
const EXCLUDE = SCOPE === 'all' ? [] : ['Cancelada', 'Cerrada', 'Resuelta'];

interface Tok { access_token: string; refresh_token?: string; client_id: string; client_secret: string }
// Token headless: de variables de entorno (Cloud Run / Secret Manager) si están,
// si no del fichero .zoho.local (uso local). En modo env NO se reescribe fichero.
const FROM_ENV = !!process.env.ZOHO_REFRESH_TOKEN;
const zoho: Tok = FROM_ENV
  ? { access_token: process.env.ZOHO_ACCESS_TOKEN ?? '', refresh_token: process.env.ZOHO_REFRESH_TOKEN, client_id: process.env.ZOHO_CLIENT_ID ?? '', client_secret: process.env.ZOHO_CLIENT_SECRET ?? '' }
  : JSON.parse(readFileSync(ZOHO, 'utf8'));
// imported-seed.json (mapeo etiqueta de estado → key del ciclo) es OPCIONAL: si no
// está (p. ej. en el contenedor), se degrada a guardar el nombre de estado literal.
let seed: { templates: { id: string; lifecycleId: string | null }[]; lifecycles: Lifecycle[] };
try { seed = JSON.parse(readFileSync(join(here, 'imported-seed.json'), 'utf8')); }
catch { seed = { templates: [], lifecycles: [] }; }

async function refresh(): Promise<void> {
  if (!zoho.refresh_token) return;
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: zoho.refresh_token, client_id: zoho.client_id, client_secret: zoho.client_secret });
  const r = await fetch('https://accounts.zoho.eu/oauth/v2/token', { method: 'POST', body });
  const j = (await r.json()) as { access_token?: string };
  if (j.access_token) { zoho.access_token = j.access_token; if (!FROM_ENV) try { writeFileSync(ZOHO, JSON.stringify(zoho)); } catch { /* FS de solo lectura */ } }
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

// ---- mapeos ----
// Guarda el NOMBRE real de prioridad de SDP (Alta/Media/Baja/Critica/Importante).
// Si SDP no la trae, por defecto 'Media'. La UI resuelve color por el catálogo.
function mapPriority(name?: string | null): string {
  return (name ?? '').trim() || 'Media';
}
// etiqueta de estado SDP -> key del estado del ciclo de la plantilla (si coincide)
function statusKey(templateId: string, statusName: string): string {
  const tpl = seed.templates.find((t) => t.id === templateId);
  const lc = tpl?.lifecycleId ? seed.lifecycles.find((l) => l.id === tpl.lifecycleId) : null;
  const st = lc?.states.find((s) => s.label.toLowerCase() === statusName.toLowerCase());
  return st?.key ?? statusName;
}
const ms = (t: { value?: string } | null | undefined) => (t?.value ? Number(t.value) : undefined);

interface SdpReqLite { id: string; display_id?: string; subject?: string; is_service_request?: boolean; description?: unknown;
  template?: { id?: string }; status?: { name?: string }; created_time?: { value?: string }; due_by_time?: { value?: string };
  priority?: { name?: string } | null; category?: { name?: string } | null; subcategory?: { name?: string } | null; item?: { name?: string } | null;
  requester?: SdpPerson | null; technician?: SdpPerson | null; group?: { id?: string; name?: string } | null }
// Campos que pedimos EN BLOQUE en el listado (evita una llamada de detalle por
// ticket: inviable con ~23k). El endpoint de lista los devuelve todos.
const LIST_FIELDS = ['subject', 'description', 'status', 'priority', 'category', 'subcategory', 'item', 'requester', 'technician', 'group', 'created_time', 'due_by_time', 'is_service_request', 'template', 'display_id'];
interface SdpPerson { id?: string; name?: string; email_id?: string; is_technician?: boolean }

const PALETTE = ['#4f46e5', '#0f766e', '#b45309', '#0369a1', '#be185d', '#7c3aed', '#15803d', '#0891b2'];
const members = new Map<string, UiMember>();
const memberGroups = new Map<string, Set<string>>(); // uid -> set de group ids
function person(p: SdpPerson | null | undefined): string | null {
  if (!p?.id) return null;
  const uid = String(p.id);
  if (!members.has(uid)) {
    const email = p.email_id ?? '';
    members.set(uid, {
      uid, name: p.name ?? email ?? uid, email, role: p.is_technician ? 'technician' : 'requester',
      status: 'active', external: !!email && !email.toLowerCase().endsWith('@' + CORP.toLowerCase()),
      color: PALETTE[members.size % PALETTE.length]!,
    });
  }
  return uid;
}

// Perfilado: cada grupo lista sus técnicos → member.groupIds. Además metemos el
// roster COMPLETO de técnicos (aunque no tengan ticket activo) para que el
// asignador filtrado por grupo tenga el pool correcto.
async function loadGroupsAndTechs(): Promise<void> {
  const q = (o: object) => encodeURIComponent(JSON.stringify(o));
  let start = 1;
  for (let page = 0; page < 20; page++) {
    const j = await api(`technicians?input_data=${q({ list_info: { row_count: 100, start_index: start } })}`);
    const arr = (j.technicians as SdpPerson[]) ?? [];
    for (const t of arr) person({ ...t, is_technician: true });
    const li = j.list_info as { has_more_rows?: boolean } | undefined;
    if (!li?.has_more_rows || !arr.length) break; start += 100;
  }
  const gids: string[] = []; start = 1;
  for (let page = 0; page < 20; page++) {
    const j = await api(`groups?input_data=${q({ list_info: { row_count: 100, start_index: start } })}`);
    const arr = (j.groups as { id: string }[]) ?? [];
    gids.push(...arr.map((g) => String(g.id)));
    const li = j.list_info as { has_more_rows?: boolean } | undefined;
    if (!li?.has_more_rows || !arr.length) break; start += 100;
  }
  for (const gid of gids) {
    try {
      const g = (await api(`groups/${gid}`)).group as { technicians?: SdpPerson[] };
      for (const t of g.technicians ?? []) {
        const uid = person({ ...t, is_technician: true });
        if (uid) { if (!memberGroups.has(uid)) memberGroups.set(uid, new Set()); memberGroups.get(uid)!.add(gid); }
      }
    } catch { /* grupo sin detalle accesible */ }
  }
}

async function listOpenIds(): Promise<SdpReqLite[]> {
  const out: SdpReqLite[] = []; let start = 1; const rows = 100;
  // SCOPE=all → sin filtro (todo el histórico); si no, excluye Cancelada/Cerrada/Resuelta.
  const li0: Record<string, unknown> = { row_count: rows, get_total_count: true, fields_required: LIST_FIELDS };
  if (EXCLUDE.length) li0.search_criteria = [{ field: 'status.name', condition: 'is not', values: EXCLUDE }];
  for (let page = 0; page < 600; page++) { // 600×100 = 60k de margen
    const input = encodeURIComponent(JSON.stringify({ list_info: { ...li0, start_index: start } }));
    const j = await api(`requests?input_data=${input}`);
    const arr = (j.requests as SdpReqLite[]) ?? [];
    out.push(...arr);
    const li = j.list_info as { has_more_rows?: boolean; total_count?: number } | undefined;
    if (page === 0 && li?.total_count) console.log(`  total en SDP: ${li.total_count}`);
    if (!li?.has_more_rows || arr.length === 0) break;
    start += rows;
    if (out.length % 1000 < rows) { console.log(`  listados ${out.length}…`); await sleep(200); }
  }
  return out;
}

async function main() {
  await refresh();
  console.log('Cargando roster de técnicos y grupos de soporte…');
  await loadGroupsAndTechs();
  console.log(`  técnicos: ${[...members.values()].filter((m) => m.role === 'technician').length} · con grupo: ${memberGroups.size}`);
  console.log(`Listando tickets (${SCOPE === 'all' ? 'HISTÓRICO COMPLETO' : 'activos, excl. ' + EXCLUDE.join('/')})…`);
  const lite = await listOpenIds();
  console.log(`  ${lite.length} tickets`);

  // Todos los campos vienen ya del listado en bloque (fields_required); NO se llama
  // al detalle por ticket (sería inviable con ~23k y agotaría la cuota de la API).
  const tickets: StoredTicket[] = [];
  for (const r of lite) {
    const templateId = String(r.template?.id ?? 'tpl-inc');
    const state = r.status?.name ?? 'Abierta'; // NOMBRE real de SDP (casa con el catálogo de estados)
    const created = ms(r.created_time) ?? Date.now();
    const desc = typeof r.description === 'string' ? r.description : '';
    tickets.push({
      id: `#${r.display_id ?? r.id}`,
      type: r.is_service_request ? 'service_request' : 'incident',
      subject: r.subject ?? '(sin asunto)',
      description: desc,
      requesterId: person(r.requester) ?? '',
      technicianId: person(r.technician),
      groupId: r.group?.id ? String(r.group.id) : null,
      category: r.category?.name ?? '',
      subcategory: r.subcategory?.name ?? undefined,
      item: r.item?.name ?? undefined,
      priority: mapPriority(r.priority?.name),
      templateId,
      status: state,
      slaId: null,
      resolveDueAt: ms(r.due_by_time) ?? null,
      statusHistory: [{ state, from: created, to: null }],
    });
  }

  for (const [uid, gs] of memberGroups) { const m = members.get(uid); if (m) m.groupIds = [...gs]; }
  const payload = { tickets, members: [...members.values()] };
  writeFileSync(join(here, 'imported-tickets.json'), JSON.stringify(payload, null, 2));
  const withGroup = [...members.values()].filter((m) => (m.groupIds ?? []).length).length;
  console.log(`\nHecho. Tickets: ${tickets.length} · personas: ${members.size} · con grupo asignado: ${withGroup}`);
  console.log('Escrito importer/imported-tickets.json');
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
