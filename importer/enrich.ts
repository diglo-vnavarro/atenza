// ============================================================================
// Enriquecedor: completa la config importada con lo que el LISTADO v3 no trae.
//   - fields por plantilla   (de request_templates/{id} -> layouts[].sections[].fields)
//   - lifecycleId por plantilla + los ciclos de vida completos (stages + transitions)
//   - ticketCount por plantilla (search_criteria template.id, para poder podar)
// Lee/escribe importer/imported-seed.json. Token OAuth desde .zoho.local (se
// refresca al arrancar con el refresh_token para disponer de 1h completa).
//
//   npx tsx importer/enrich.ts
// ============================================================================
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Lifecycle, LifecycleState, Transition, Stage, SlaCategory, TicketType } from '../src/model.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const SEED = join(here, 'imported-seed.json');
const ZOHO = join(ROOT, '.zoho.local');
const BASE = process.env.SDP_BASE ?? 'https://digloitsm.sdpondemand.manageengine.eu/app/itdesk';
const ACCEPT = 'application/vnd.manageengine.sdp.v3+json';

interface Tok { access_token: string; refresh_token?: string; client_id: string; client_secret: string; api_domain?: string }
const zoho: Tok = JSON.parse(readFileSync(ZOHO, 'utf8'));

async function refresh(): Promise<void> {
  if (!zoho.refresh_token) return;
  const body = new URLSearchParams({
    grant_type: 'refresh_token', refresh_token: zoho.refresh_token,
    client_id: zoho.client_id, client_secret: zoho.client_secret,
  });
  const r = await fetch('https://accounts.zoho.eu/oauth/v2/token', { method: 'POST', body });
  const j = (await r.json()) as { access_token?: string };
  if (j.access_token) { zoho.access_token = j.access_token; writeFileSync(ZOHO, JSON.stringify(zoho)); }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function api(path: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${BASE}/api/v3/${path}`, {
      headers: { Authorization: `Zoho-oauthtoken ${zoho.access_token}`, Accept: ACCEPT },
    });
    if (res.status === 401) { await refresh(); continue; }
    if (res.status === 429) { await sleep(2000); continue; }
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }
  throw new Error(`${path}: agotados los reintentos`);
}

// ---- helpers de mapeo de estado/etapa ----
const norm = (s: string) => s.toLowerCase();
function catOf(name: string): SlaCategory {
  const n = norm(name);
  if (/(espera|pendiente|terceros|aprobaci|hold|banco|proveedor)/.test(n)) return 'stop_timer';
  if (/(resuel|cerrad|cancel|complet|end_lifecycle|closed|resolved)/.test(n)) return 'completed';
  return 'in_progress';
}
function stageOf(name: string): Stage {
  const n = norm(name);
  if (/(resuel|resolved)/.test(n)) return 'resolved';
  if (/(cerrad|closed|cancel|end)/.test(n)) return 'closed';
  if (/(espera|pendiente|hold|aprobaci)/.test(n)) return 'pending';
  return 'open';
}
const SYNTH = (name: string) => /^(start|end)_lifecycle$/i.test(name);

// nombres de campo estándar SDP -> etiqueta legible (los udf_* quedan como código)
const FIELD_LABELS: Record<string, string> = {
  subject: 'Asunto', description: 'Descripción', priority: 'Prioridad', requester: 'Solicitante',
  technician: 'Técnico', group: 'Grupo', status: 'Estado', category: 'Categoría', subcategory: 'Subcategoría',
  item: 'Elemento', attachments: 'Adjuntos', site: 'Sede', impact: 'Impacto', urgency: 'Urgencia',
  level: 'Nivel', mode: 'Modo', 'resolution.content': 'Resolución', email_ids_to_notify: 'Notificar a',
  assets: 'Activos', service_category: 'Categoría de servicio',
};
// diccionario UDF (field_key -> etiqueta humana), poblado desde /udf_fields
const UDF: Record<string, string> = {};
async function loadUdfDict(): Promise<void> {
  let start = 1; const rows = 100;
  for (let page = 0; page < 50; page++) {
    const input = encodeURIComponent(JSON.stringify({ list_info: { row_count: rows, start_index: start } }));
    const j = await api(`udf_fields?input_data=${input}`);
    const arr = (j.udf_fields as { field_key?: string; name?: string }[]) ?? [];
    for (const f of arr) if (f.field_key && f.name) UDF[f.field_key] = f.name;
    const li = j.list_info as { has_more_rows?: boolean } | undefined;
    if (!li?.has_more_rows || arr.length === 0) break;
    start += rows;
  }
}
function fieldLabel(name: string): string {
  if (FIELD_LABELS[name]) return FIELD_LABELS[name]!;
  if (name.startsWith('udf_fields.')) { const key = name.slice('udf_fields.'.length); return UDF[key] ?? key; }
  return name;
}
// campos de sistema (solo lectura) que no cuentan como "campos de formulario"
const SYSTEM_FIELDS = new Set(['created_time', 'due_by_time', 'first_response_due_by_time', 'responded_time', 'completed_time', 'resolved_time', 'last_updated_time']);

interface SeedTpl { id: string; name: string; type: TicketType; lifecycleId: string | null; slaId: string | null; fields: string[]; ticketCount?: number; group?: string; showToRequester?: boolean }

async function templateFieldsAndLifecycle(id: string): Promise<{ fields: string[]; lifecycleId: string | null; group: string; showToRequester: boolean }> {
  const d = (await api(`request_templates/${id}`)).request_template as Record<string, unknown>;
  const layouts = (d.layouts as { sections?: { fields?: { name?: string }[] }[] }[]) ?? [];
  const names = new Set<string>();
  for (const lay of layouts) for (const sec of lay.sections ?? []) for (const f of sec.fields ?? []) {
    if (f.name && !SYSTEM_FIELDS.has(f.name)) names.add(f.name);
  }
  const lc = d.lifecycle as { id?: string } | null;
  const sc = d.service_category as { name?: string } | null;
  const group = sc?.name ?? (d.is_service_template ? 'Solicitudes de servicio' : 'Plantillas generales de incidentes');
  return { fields: [...names].map(fieldLabel), lifecycleId: lc?.id ? String(lc.id) : null, group, showToRequester: d.show_to_requester !== false };
}

async function ticketCount(templateId: string): Promise<number> {
  const input = encodeURIComponent(JSON.stringify({
    list_info: { row_count: 1, start_index: 1, get_total_count: true, search_criteria: [{ field: 'template.id', condition: 'is', value: templateId }] },
  }));
  const j = await api(`requests?input_data=${input}`);
  return (j.list_info as { total_count?: number })?.total_count ?? 0;
}

async function fetchLifecycle(id: string, type: TicketType): Promise<Lifecycle> {
  const lc = (await api(`lifecycles/${id}`)).lifecycle as Record<string, unknown>;
  const stages = (lc.stages as { id: string; name: string }[]) ?? [];
  const trans = (lc.transitions as { id: string; name?: string; from_stage?: { id: string; name: string }; to_stage?: { id: string; name: string } }[]) ?? [];
  const states: LifecycleState[] = stages.filter((s) => !SYNTH(s.name)).map((s) => ({
    key: String(s.id), label: s.name, stage: stageOf(s.name), category: catOf(s.name),
  }));
  const transitions: Transition[] = [];
  for (const t of trans) {
    const from = t.from_stage, to = t.to_stage;
    if (!from || !to) continue;
    if (SYNTH(from.name)) { const st = states.find((x) => x.key === String(to.id)); if (st) st.isInitial = true; continue; }
    if (SYNTH(to.name)) { const st = states.find((x) => x.key === String(from.id)); if (st) st.isTerminal = true; continue; }
    transitions.push({ id: String(t.id), name: t.name ?? `${from.name}→${to.name}`, from: String(from.id), to: String(to.id) });
  }
  return { id: String(id), name: String(lc.name ?? id), version: '1', published: lc.is_published !== false, type, states, transitions };
}

async function main() {
  await refresh();
  await loadUdfDict();
  console.log(`Diccionario UDF: ${Object.keys(UDF).length} campos personalizados`);
  const seed = JSON.parse(readFileSync(SEED, 'utf8')) as { templates: SeedTpl[]; lifecycles?: Lifecycle[]; [k: string]: unknown };
  const tpls = seed.templates;
  console.log(`Enriqueciendo ${tpls.length} plantillas…`);

  const lifecycleType = new Map<string, TicketType>();
  let i = 0;
  for (const tp of tpls) {
    const { fields, lifecycleId, group, showToRequester } = await templateFieldsAndLifecycle(tp.id);
    tp.fields = fields;
    tp.lifecycleId = lifecycleId;
    tp.group = group;
    tp.showToRequester = showToRequester;
    tp.ticketCount = await ticketCount(tp.id);
    if (lifecycleId) lifecycleType.set(lifecycleId, tp.type);
    i++;
    if (i % 10 === 0) { console.log(`  ${i}/${tpls.length}`); await sleep(300); }
  }

  console.log(`Trayendo ${lifecycleType.size} ciclos de vida…`);
  const lifecycles: Lifecycle[] = [];
  for (const [id, type] of lifecycleType) {
    try { lifecycles.push(await fetchLifecycle(id, type)); }
    catch (e) { console.warn(`  ciclo ${id}: ${(e as Error).message}`); }
  }
  seed.lifecycles = lifecycles;

  writeFileSync(SEED, JSON.stringify(seed, null, 2));
  const withFlow = tpls.filter((t) => t.lifecycleId).length;
  const empty = tpls.filter((t) => (t.ticketCount ?? 0) === 0).length;
  console.log(`\nHecho. Plantillas con flujo: ${withFlow}/${tpls.length} · ciclos: ${lifecycles.length}`);
  console.log(`Plantillas sin tickets (se podarán): ${empty} · con tickets: ${tpls.length - empty}`);
  console.log(`Campos poblados. Reescrito ${SEED}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
