// Trae de SDP el LAYOUT REAL de cada plantilla (secciones · columnas · campos)
// y lo escribe en template.fieldDefs para que el alta («Nueva solicitud») lo
// renderice dinámicamente. Idempotente, con dry-run. Match de plantillas por id.
//
//   GOOGLE_APPLICATION_CREDENTIALS=<adc> GOOGLE_CLOUD_PROJECT=diglo-desk-pd \
//   TENANT=diglo-it npx tsx scripts/import-layouts.ts            (aplica)
//   ...  DRY_RUN=1 npx tsx scripts/import-layouts.ts             (previsualiza)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const BASE = process.env.SDP_BASE ?? 'https://digloitsm.sdpondemand.manageengine.eu/app/itdesk';
const ACCEPT = 'application/vnd.manageengine.sdp.v3+json';
const TENANT = process.env.TENANT ?? 'diglo-it';
const DRY = process.env.DRY_RUN === '1' || process.argv.includes('--dry-run');
const DEF_SEC = 'Detalles de la solicitud';

interface Tok { access_token: string; refresh_token?: string; client_id: string; client_secret: string }
const zoho: Tok = process.env.ZOHO_REFRESH_TOKEN
  ? { access_token: '', refresh_token: process.env.ZOHO_REFRESH_TOKEN, client_id: process.env.ZOHO_CLIENT_ID ?? '', client_secret: process.env.ZOHO_CLIENT_SECRET ?? '' }
  : JSON.parse(readFileSync(join(ROOT, '.zoho.local'), 'utf8'));
async function refresh() { if (!zoho.refresh_token) return; const b = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: zoho.refresh_token, client_id: zoho.client_id, client_secret: zoho.client_secret }); const r = await fetch('https://accounts.zoho.eu/oauth/v2/token', { method: 'POST', body: b }); const j = (await r.json()) as { access_token?: string }; if (j.access_token) zoho.access_token = j.access_token; }
async function api(p: string): Promise<Record<string, unknown>> { for (let a = 0; a < 4; a++) { const r = await fetch(`${BASE}/api/v3/${p}`, { headers: { Authorization: `Zoho-oauthtoken ${zoho.access_token}`, Accept: ACCEPT } }); if (r.status === 401) { await refresh(); continue; } if (r.status === 429) { await new Promise((s) => setTimeout(s, 2000)); continue; } if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`); return (await r.json()) as Record<string, unknown>; } throw new Error(`${p}: reintentos`); }
const q = (o: object) => encodeURIComponent(JSON.stringify(o));

type FieldType = 'text' | 'textarea' | 'select' | 'bool' | 'date' | 'number' | 'person' | 'attachment' | 'reference';
const mapUdfType = (t: string): FieldType => (({ string: 'text', multi_select: 'select', pick_list: 'select', refered_field: 'reference', datetime: 'date', datestamp: 'date', boolean: 'bool', number: 'number', double: 'number', long: 'number' } as Record<string, FieldType>)[t] ?? 'text');

// Campos de sistema de SDP → etiqueta + tipo en Atenza. Los NO listados se omiten.
const SYS: Record<string, { label: string; type: FieldType }> = {
  requester: { label: 'Solicitante', type: 'person' },
  subject: { label: 'Asunto', type: 'text' },
  description: { label: 'Descripción', type: 'textarea' },
  priority: { label: 'Prioridad', type: 'select' },
  impact: { label: 'Impacto', type: 'select' },
  urgency: { label: 'Urgencia', type: 'select' },
  level: { label: 'Nivel', type: 'select' },
  mode: { label: 'Modo', type: 'select' },
  category: { label: 'Categoría', type: 'select' },
  subcategory: { label: 'Subcategoría', type: 'select' },
  item: { label: 'Artículo', type: 'select' },
  site: { label: 'Sede', type: 'select' },
  attachments: { label: 'Adjuntos', type: 'attachment' },
};
// Campos operativos / de solo lectura que NO forman parte del alta.
const SKIP = new Set(['status', 'technician', 'group', 'created_time', 'due_by_time', 'first_response_due_by_time', 'responded_time', 'completed_time', 'last_updated_time', 'resolution.content', 'resolution', 'email_ids_to_notify', 'assets', 'sla', 'template', 'request_type']);

const cleanSection = (name: string | undefined): string => {
  const n = (name ?? '').trim();
  if (!n || n === ':::' || /^-?\d+$/.test(n)) return DEF_SEC;
  if (/^resolution$/i.test(n)) return 'Resolución';
  if (/^requester details$/i.test(n)) return 'Detalles del solicitante';
  return n;
};

interface FieldDef { id: string; label: string; type: FieldType; mandatory?: boolean; requesterVisible?: boolean; section?: string; col?: 1 | 2; full?: boolean }
interface SdpField { name: string; position?: { col?: number }; requester_can_view?: boolean; mandatory?: boolean; scopings?: { scope_name?: string; value?: unknown }[] }
interface SdpSection { name?: string; fields?: SdpField[] }
interface SdpLayout { name?: string; sections?: SdpSection[] }

initializeApp({ projectId: process.env.GOOGLE_CLOUD_PROJECT ?? 'diglo-desk-pd' });
const db = getFirestore();

async function main() {
  await refresh();
  console.log(`${DRY ? '=== DRY-RUN === ' : ''}Importar layouts de ${TENANT} desde SDP → fieldDefs.`);

  // 1) UDF de request: field_key (udf_char4) → { id, label, type }
  const udfRes = await api(`udf_fields?input_data=${q({ list_info: { row_count: 200 } })}`);
  const udfList = ((udfRes.udf_fields as { id: string; name?: string; type: string; field_key?: string; module?: { name?: string } }[]) ?? []).filter((f) => f.module?.name === 'request');
  const udfByKey = new Map(udfList.map((f) => [f.field_key ?? '', { id: f.id, label: f.name ?? f.field_key ?? f.id, type: mapUdfType(f.type) }]));
  console.log(`UDF de request: ${udfByKey.size} campos.`);

  // 2) Plantillas en Firestore (match por id)
  const tSnap = await db.collection(`tenants/${TENANT}/templates`).get();
  const atenzaIds = new Set(tSnap.docs.map((d) => d.id));
  console.log(`Plantillas en Atenza: ${atenzaIds.size}`);

  const patchByTpl = new Map<string, { fieldDefs: FieldDef[]; fields: string[] }>();
  let done = 0;
  for (const id of atenzaIds) {
    let d: Record<string, unknown>;
    try { d = await api(`request_templates/${id}`); } catch { console.log(`  · ${id}: sin detalle en SDP (se omite)`); continue; }
    const tpl = (d.request_template ?? d) as { name?: string; layouts?: SdpLayout[] };
    const layouts = tpl.layouts ?? [];
    const tech = layouts.find((l) => l.name === 'technician_layout') ?? layouts[0];
    const reqLayout = layouts.find((l) => l.name === 'requester_layout');
    // nombres de campo visibles para el solicitante (según requester_layout)
    const reqVisible = new Set<string>();
    for (const s of reqLayout?.sections ?? []) for (const f of s.fields ?? []) reqVisible.add(f.name);
    if (!tech) { console.log(`  · ${id} (${tpl.name}): sin layout`); continue; }

    const defs: FieldDef[] = [];
    const seen = new Set<string>();
    for (const sec of tech.sections ?? []) {
      const section = cleanSection(sec.name);
      if (section === 'Resolución') continue; // la resolución no es parte del alta
      for (const f of sec.fields ?? []) {
        const raw = f.name;
        if (SKIP.has(raw)) continue;
        const col: 1 | 2 = f.position?.col === 2 ? 2 : 1;
        const mand = (f.mandatory ?? (f.scopings?.find((x) => x.scope_name === 'mandatory')?.value as boolean | undefined)) === true;
        let def: FieldDef | null = null;
        if (raw.startsWith('udf_fields.')) {
          const key = raw.slice('udf_fields.'.length);
          const u = udfByKey.get(key);
          if (!u) continue; // UDF desconocido → se omite
          def = { id: 'cf-' + u.id, label: u.label, type: u.type };
        } else if (SYS[raw]) {
          def = { id: 'sys-' + raw, label: SYS[raw]!.label, type: SYS[raw]!.type };
        } else {
          continue; // campo de sistema no soportado en el alta
        }
        if (seen.has(def.id)) continue; seen.add(def.id);
        const rcv = reqLayout ? reqVisible.has(raw) : (f.requester_can_view !== false);
        def.section = section; def.col = col;
        def.requesterVisible = rcv;
        if (mand) def.mandatory = true;
        if (def.type === 'textarea' || raw === 'subject') def.full = true;
        defs.push(def);
      }
    }
    if (defs.length) { patchByTpl.set(id, { fieldDefs: defs, fields: defs.map((f) => f.label) }); done++; }
    const secList = [...new Set(defs.map((f) => f.section))];
    console.log(`  ✓ ${id} (${tpl.name}): ${defs.length} campos · secciones: ${secList.join(' | ')}`);
  }
  console.log(`\nResumen: ${done}/${atenzaIds.size} plantillas con layout importado.`);

  if (DRY) { console.log('DRY-RUN: nada escrito.'); return; }
  const batch = db.batch();
  for (const [id, patch] of patchByTpl) batch.set(db.doc(`tenants/${TENANT}/templates/${id}`), patch, { merge: true });
  await batch.commit();
  console.log('Aplicado: fieldDefs en las plantillas.');
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
