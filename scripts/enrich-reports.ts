// Enriquecimiento GENERAL de campos de informe (udf + resolvedAt + templateName + comentario de cierre)
// para los tickets de unos GRUPOS y/o PLANTILLAS de SDP. Base de los informes tabulares del equipo
// (REO por grupo, Reclamaciones por plantilla, etc.). Idempotente: merge sobre los docs existentes.
//
//   GOOGLE_CLOUD_PROJECT=diglo-desk-pd TENANT=diglo-it \
//   GRP_IDS=9207000001900239,9207000001900291 npx tsx scripts/enrich-reports.ts       (REO CRM+WEB)
//   ... TEMPLATES="Plantilla Reclamación" ...                                          (Reclamaciones)
//   ... DRY_RUN=1   → no escribe; reporta.   LIMIT=40 → recorta para pruebas.
import { readFileSync, writeFileSync } from 'node:fs';
import { REPORT_UDF_KEYS } from '../src/reports.js';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { loadZoho, zohoRefresh, sdpGet, type Zoho } from './lib/sdp-attachments.js';

const TENANT = process.env.TENANT ?? 'diglo-it';
const DRY = process.env.DRY_RUN === '1' || process.argv.includes('--dry-run');
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : 0;
const GROUPS = (process.env.GRP_IDS ?? process.env.GROUP_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const TEMPLATES = (process.env.TEMPLATES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const CLOSED = ['cerrada', 'resuelta', 'cancelada', 'closed', 'resolved', 'cancelled', 'canceled'];
const LIST_FIELDS = ['subject', 'status', 'priority', 'requester', 'technician', 'group', 'template', 'display_id', 'created_time', 'resolved_time', 'completed_time', 'is_service_request', 'udf_fields'];

initializeApp({ projectId: process.env.GOOGLE_CLOUD_PROJECT ?? 'diglo-desk-pd' });
const db = getFirestore();

interface SdpReq { id: string; display_id?: string; status?: { name?: string }; template?: { name?: string }; resolved_time?: { value?: string }; completed_time?: { value?: string }; udf_fields?: Record<string, unknown> | null }
const ms = (t?: { value?: string }) => (t?.value ? Number(t.value) : undefined);
function udfStr(v: unknown): string { if (v == null || v === '') return ''; if (typeof v === 'object') { const o = v as { display_value?: string; value?: string }; return o.display_value ?? o.value ?? ''; } return String(v); }

async function listBy(z: Zoho, criteria: object): Promise<SdpReq[]> {
  const out: SdpReq[] = []; let start = 1; const rows = 100;
  for (let page = 0; page < 300; page++) {
    const li = { row_count: rows, start_index: start, fields_required: LIST_FIELDS, search_criteria: [criteria] };
    const j = await sdpGet(z, `requests?input_data=${encodeURIComponent(JSON.stringify({ list_info: li }))}`);
    const arr = (j.requests as SdpReq[]) ?? []; out.push(...arr);
    const info = j.list_info as { has_more_rows?: boolean } | undefined;
    if (!info?.has_more_rows || !arr.length) break; start += rows;
  }
  return out;
}
async function closureOf(z: Zoho, rid: string): Promise<string | undefined> {
  const d = (await sdpGet(z, `requests/${rid}`)).request as { closure_info?: { requester_ack_comments?: string } } | undefined;
  const c = d?.closure_info?.requester_ack_comments; return c && String(c).trim() ? String(c) : undefined;
}

async function main() {
  if (!GROUPS.length && !TEMPLATES.length) { console.error('Indica GROUPS y/o TEMPLATES.'); process.exit(1); }
  const z = loadZoho(); await zohoRefresh(z);
  const byId = new Map<string, SdpReq>();
  for (const g of GROUPS) { const a = await listBy(z, { field: 'group.id', condition: 'is', values: [g] }); a.forEach((r) => byId.set(String(r.id), r)); console.log(`  grupo ${g}: ${byId.size} acumulado`); }
  if (TEMPLATES.length) { const a = await listBy(z, { field: 'template.name', condition: 'is', values: TEMPLATES }); a.forEach((r) => byId.set(String(r.id), r)); console.log(`  plantillas ${TEMPLATES.join('/')}: ${byId.size} acumulado`); }
  let reqs = [...byId.values()]; if (LIMIT) reqs = reqs.slice(0, LIMIT);
  console.log(`Total a enriquecer: ${reqs.length}`);

  let enriched = 0, missing = 0, closures = 0, errors = 0;
  for (let i = 0; i < reqs.length; i += 100) {
    const slice = reqs.slice(i, i + 100);
    const refs = slice.map((r) => db.doc(`tenants/${TENANT}/tickets/#${r.display_id ?? r.id}`));
    const snaps = await db.getAll(...refs);
    const batch = db.batch(); let ops = 0;
    for (let j = 0; j < slice.length; j++) {
      const r = slice[j]!; const snap = snaps[j]!; const prev = snap.exists ? snap.data() as Record<string, unknown> : undefined;
      if (!prev) { missing++; continue; }
      const sdpUdf: Record<string, string> = {};
      for (const k of REPORT_UDF_KEYS) { const s = udfStr(r.udf_fields?.[k]); if (s) sdpUdf[k] = s; }
      const patch: Record<string, unknown> = {};
      if (Object.keys(sdpUdf).length) patch.sdpUdf = sdpUdf;
      if (r.template?.name) patch.templateName = r.template.name;
      const rAt = ms(r.resolved_time) ?? ms(r.completed_time); if (rAt) patch.resolvedAt = rAt;
      const isClosed = CLOSED.includes((r.status?.name ?? '').toLowerCase());
      if (isClosed && !prev.closureComment) { try { const c = await closureOf(z, r.id); if (c) { patch.closureComment = c; closures++; } } catch { errors++; } }
      if (Object.keys(patch).length) { if (!DRY) { batch.set(refs[j]!, patch, { merge: true }); ops++; } enriched++; }
    }
    if (!DRY && ops) await batch.commit();
    console.log(`  procesados ${Math.min(i + 100, reqs.length)}/${reqs.length}…`);
  }
  console.log(`\n${DRY ? '[DRY] ' : ''}Hecho. Enriquecidos: ${enriched} · sin doc en Atenza: ${missing} · comentarios cierre: ${closures} · errores: ${errors}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
