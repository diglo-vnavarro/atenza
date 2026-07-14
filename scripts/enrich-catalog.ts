// Trae de SDP el CATÁLOGO DE SERVICIO y sus PERMISOS, y los CAMPOS ADICIONALES (UDF):
//   - tenant.customFields  ← udf_fields del módulo request (los "adicionales").
//   - por plantilla: group = categoría de servicio, userGroups = grupos de usuario
//     con acceso (permiso), showToRequester, type (incidencia/solicitud).
// Idempotente, con dry-run. Match de plantillas por id (= id de SDP).
//
//   GOOGLE_APPLICATION_CREDENTIALS=<adc> GOOGLE_CLOUD_PROJECT=diglo-desk-pd \
//   TENANT=diglo-it npx tsx scripts/enrich-catalog.ts            (aplica)
//   ...  DRY_RUN=1 npx tsx scripts/enrich-catalog.ts             (previsualiza)
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

interface Tok { access_token: string; refresh_token?: string; client_id: string; client_secret: string }
const zoho: Tok = process.env.ZOHO_REFRESH_TOKEN
  ? { access_token: '', refresh_token: process.env.ZOHO_REFRESH_TOKEN, client_id: process.env.ZOHO_CLIENT_ID ?? '', client_secret: process.env.ZOHO_CLIENT_SECRET ?? '' }
  : JSON.parse(readFileSync(join(ROOT, '.zoho.local'), 'utf8'));
async function refresh() { if (!zoho.refresh_token) return; const b = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: zoho.refresh_token, client_id: zoho.client_id, client_secret: zoho.client_secret }); const r = await fetch('https://accounts.zoho.eu/oauth/v2/token', { method: 'POST', body: b }); const j = (await r.json()) as { access_token?: string }; if (j.access_token) zoho.access_token = j.access_token; }
async function api(p: string): Promise<Record<string, unknown>> { for (let a = 0; a < 4; a++) { const r = await fetch(`${BASE}/api/v3/${p}`, { headers: { Authorization: `Zoho-oauthtoken ${zoho.access_token}`, Accept: ACCEPT } }); if (r.status === 401) { await refresh(); continue; } if (r.status === 429) { await new Promise((s) => setTimeout(s, 2000)); continue; } if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`); return (await r.json()) as Record<string, unknown>; } throw new Error(`${p}: reintentos`); }
const q = (o: object) => encodeURIComponent(JSON.stringify(o));

// UDF de SDP → FieldType de Atenza
const mapType = (t: string): string => ({ string: 'text', multi_select: 'select', refered_field: 'reference', datetime: 'date', datestamp: 'date', boolean: 'bool', number: 'number', double: 'number', long: 'number' } as Record<string, string>)[t] ?? 'text';

initializeApp({ projectId: process.env.GOOGLE_CLOUD_PROJECT ?? 'diglo-desk-pd' });
const db = getFirestore();

async function main() {
  await refresh();
  console.log(`${DRY ? '=== DRY-RUN === ' : ''}Enriquecer catálogo/campos de ${TENANT} desde SDP.`);

  // 1) Campos adicionales (UDF de request)
  const udfRes = await api(`udf_fields?input_data=${q({ list_info: { row_count: 200 } })}`);
  const udfs = ((udfRes.udf_fields as { id: string; display_name?: string; name?: string; type: string; module?: { name?: string } }[]) ?? []).filter((f) => f.module?.name === 'request');
  const customFields = udfs.map((f) => ({ id: 'cf-' + f.id, label: f.display_name ?? f.name ?? f.id, type: mapType(f.type), requesterVisible: true }));
  console.log(`UDF de request: ${customFields.length} campos adicionales.`);

  // 2) Plantillas: categoría de servicio + permisos (user_groups) + visibilidad + tipo
  const tSnap = await db.collection(`tenants/${TENANT}/templates`).get();
  const atenzaIds = new Set(tSnap.docs.map((d) => d.id));
  let all: { id: string }[] = []; let start = 1;
  for (let p = 0; p < 10; p++) { const r = await api(`request_templates?input_data=${q({ list_info: { row_count: 100, start_index: start } })}`); const a = (r.request_templates as { id: string }[]) ?? []; all.push(...a); const li = r.list_info as { has_more_rows?: boolean } | undefined; if (!li?.has_more_rows || !a.length) break; start += 100; }
  const patchByTpl = new Map<string, Record<string, unknown>>();
  let withCat = 0, withPerm = 0;
  for (const t of all) {
    if (!atenzaIds.has(t.id)) continue;
    const d = await api(`request_templates/${t.id}`);
    const tpl = (d.request_template ?? d) as { service_category?: { name?: string }; user_groups?: { name?: string }[]; show_to_requester?: boolean; is_service_template?: boolean };
    const patch: Record<string, unknown> = {};
    if (tpl.service_category?.name) { patch.group = tpl.service_category.name; withCat++; }
    const ug = (tpl.user_groups ?? []).map((g) => g.name).filter((n): n is string => !!n);
    if (ug.length) { patch.userGroups = ug; withPerm++; }
    patch.showToRequester = tpl.show_to_requester !== false;
    patch.type = tpl.is_service_template ? 'service_request' : 'incident';
    if (Object.keys(patch).length) patchByTpl.set(t.id, patch);
  }
  console.log(`plantillas: ${atenzaIds.size} en Atenza · ${patchByTpl.size} enriquecidas · ${withCat} con categoría de servicio · ${withPerm} con permisos (user_groups)`);

  if (DRY) { console.log('DRY-RUN: nada escrito.'); return; }
  await db.doc(`tenants/${TENANT}`).set({ customFields }, { merge: true });
  const batch = db.batch();
  for (const [id, patch] of patchByTpl) batch.set(db.doc(`tenants/${TENANT}/templates/${id}`), patch, { merge: true });
  await batch.commit();
  console.log('Aplicado: customFields + plantillas.');
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
