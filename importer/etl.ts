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

interface SdpReqLite { id: string; display_id?: string; subject?: string; is_service_request?: boolean;
  template?: { id?: string }; status?: { name?: string }; created_time?: { value?: string }; due_by_time?: { value?: string };
  requester?: SdpPerson | null; technician?: SdpPerson | null; group?: { id?: string; name?: string } | null }
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
  for (let page = 0; page < 60; page++) {
    const input = encodeURIComponent(JSON.stringify({
      list_info: { row_count: rows, start_index: start, get_total_count: true, search_criteria: [{ field: 'status.name', condition: 'is not', values: EXCLUDE }] },
    }));
    const j = await api(`requests?input_data=${input}`);
    const arr = (j.requests as SdpReqLite[]) ?? [];
    out.push(...arr);
    const li = j.list_info as { has_more_rows?: boolean } | undefined;
    if (!li?.has_more_rows || arr.length === 0) break;
    start += rows;
  }
  return out;
}

async function main() {
  await refresh();
  console.log('Cargando roster de técnicos y grupos de soporte…');
  await loadGroupsAndTechs();
  console.log(`  técnicos: ${[...members.values()].filter((m) => m.role === 'technician').length} · con grupo: ${memberGroups.size}`);
  console.log('Listando tickets activos (excl. ' + EXCLUDE.join('/') + ')…');
  const lite = await listOpenIds();
  console.log(`  ${lite.length} tickets activos`);

  const tickets: StoredTicket[] = [];
  let i = 0;
  for (const r of lite) {
    let detail: Record<string, unknown> = {};
    try { detail = (await api(`requests/${r.id}`)).request as Record<string, unknown>; } catch { /* usa datos de lista */ }
    const templateId = String(r.template?.id ?? (detail.template as { id?: string } | undefined)?.id ?? 'tpl-inc');
    const statusName = r.status?.name ?? (detail.status as { name?: string })?.name ?? 'Abierta';
    const created = ms(r.created_time) ?? ms(detail.created_time as { value?: string }) ?? Date.now();
    // el estado guarda el NOMBRE real de SDP (casa con el catálogo de estados).
    const state = statusName;
    const priObj = (detail.priority as { name?: string } | null) ?? null;
    tickets.push({
      id: `#${r.display_id ?? r.id}`,
      type: r.is_service_request ? 'service_request' : 'incident',
      subject: r.subject ?? (detail.subject as string) ?? '(sin asunto)',
      description: (detail.description as string) ?? '',
      requesterId: person(r.requester ?? (detail.requester as SdpPerson)) ?? '',
      technicianId: person(r.technician ?? (detail.technician as SdpPerson)),
      groupId: r.group?.id ? String(r.group.id) : null,
      category: (detail.category as { name?: string } | null)?.name ?? '',
      subcategory: (detail.subcategory as { name?: string } | null)?.name ?? undefined,
      item: (detail.item as { name?: string } | null)?.name ?? undefined,
      priority: mapPriority(priObj?.name),
      templateId,
      status: state,
      slaId: null,
      resolveDueAt: ms(r.due_by_time) ?? null,
      statusHistory: [{ state, from: created, to: null }],
    });
    if (++i % 50 === 0) { console.log(`  ${i}/${lite.length}`); await sleep(300); }
  }

  for (const [uid, gs] of memberGroups) { const m = members.get(uid); if (m) m.groupIds = [...gs]; }
  const payload = { tickets, members: [...members.values()] };
  writeFileSync(join(here, 'imported-tickets.json'), JSON.stringify(payload, null, 2));
  const withGroup = [...members.values()].filter((m) => (m.groupIds ?? []).length).length;
  console.log(`\nHecho. Tickets: ${tickets.length} · personas: ${members.size} · con grupo asignado: ${withGroup}`);
  console.log('Escrito importer/imported-tickets.json');
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
