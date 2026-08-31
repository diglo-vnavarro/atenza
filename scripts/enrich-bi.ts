// Enriquecimiento BI — trae los CAMPOS PERSONALIZADOS de SDP (Estado BI, Impacto en BI,
// Tipología, Prioridad BI, Gestión de datos, Informe afectado) + el comentario de cierre a los
// tickets BI de Atenza, para reproducir el informe «Seguimiento BI» (tabular) con datos vivos.
//
//   - Lista de SDP las solicitudes de las plantillas BI (todas, abiertas + cerradas).
//   - `udf_fields` viene en el LISTADO en bloque (barato); `closure_info` requiere DETALLE
//     por ticket → solo se pide para los CERRADOS que aún no tengan `closureComment` (idempotente).
//   - Docs que YA existen en Atenza → merge de {sdpUdf, templateName, closureComment}.
//   - Docs que FALTAN (histórico cerrado no importado) → se cuentan; con CREATE_MISSING=1 se crean.
//
//   GOOGLE_APPLICATION_CREDENTIALS=<adc> GOOGLE_CLOUD_PROJECT=diglo-desk-pd \
//   TENANT=diglo-it npx tsx scripts/enrich-bi.ts            (enriquece existentes)
//   ... DRY_RUN=1        → no escribe; reporta qué cambiaría y cuántos faltan.
//   ... CREATE_MISSING=1 → además crea los docs BI que falten (histórico cerrado).
//   ... LIMIT=40         → recorta para pruebas.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { isArchivedStatus } from '../src/model.js';
import { classifyToV3 } from '../src/data/classification-map.js';
import { loadZoho, zohoRefresh, sdpGet, type Zoho } from './lib/sdp-attachments.js';

const here = dirname(fileURLToPath(import.meta.url));
const importer = join(here, '..', 'importer');
const TENANT = process.env.TENANT ?? 'diglo-it';
const DRY = process.env.DRY_RUN === '1' || process.argv.includes('--dry-run');
const CREATE = process.env.CREATE_MISSING === '1';
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : 0;

// Plantillas SDP que mapean a la categoría BI (ar-bi) — ver src/data/classification-map.ts.
const BI_TEMPLATES = ['Solicitud de datos BI', 'Plantilla Incidencias BI', 'Peticion ITSM BI', 'Informes Looker', 'Solicitudes BI', 'ITSM BI'];
// Campos personalizados que guardamos para informes (whitelist; = etl.ts UDF_KEYS).
const UDF_KEYS = ['udf_char128', 'udf_char129', 'udf_char122', 'udf_char124', 'udf_char13', 'udf_long1', 'udf_char655', 'udf_char150'];
const CLOSED = ['cerrada', 'resuelta', 'cancelada', 'closed', 'resolved', 'cancelled', 'canceled'];

initializeApp({ projectId: process.env.GOOGLE_CLOUD_PROJECT ?? 'diglo-desk-pd' });
const db = getFirestore();

interface SdpReq {
  id: string; display_id?: string; subject?: string; status?: { name?: string }; priority?: { name?: string } | null;
  is_service_request?: boolean; template?: { id?: string; name?: string }; requester?: { id?: string } | null;
  technician?: { id?: string } | null; group?: { id?: string } | null; created_time?: { value?: string };
  udf_fields?: Record<string, unknown> | null;
}

// idmap (Firestore idmap + identity-map.json) → remapea personas SDP a cuentas Atenza al crear docs.
async function loadIdmap(): Promise<Record<string, string>> {
  const raw: Record<string, string> = process.env.IDENTITY_MAP_JSON
    ? JSON.parse(process.env.IDENTITY_MAP_JSON)
    : (() => { const p = join(importer, 'identity-map.json'); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {}; })();
  const map = Object.fromEntries(Object.entries(raw).filter(([k]) => !k.startsWith('_')));
  try { const s = await db.collection(`tenants/${TENANT}/idmap`).get(); s.forEach((d) => { const uid = d.data().uid as string | undefined; if (uid && !map[d.id]) map[d.id] = uid; }); } catch { /* sin idmap */ }
  return map;
}

async function listBi(z: Zoho): Promise<SdpReq[]> {
  const out: SdpReq[] = []; let start = 1; const rows = 100;
  const fields = ['subject', 'status', 'priority', 'requester', 'technician', 'group', 'template', 'display_id', 'created_time', 'is_service_request', 'udf_fields'];
  for (let page = 0; page < 200; page++) {
    const li = { row_count: rows, start_index: start, fields_required: fields, search_criteria: [{ field: 'template.name', condition: 'is', values: BI_TEMPLATES }] };
    const j = await sdpGet(z, `requests?input_data=${encodeURIComponent(JSON.stringify({ list_info: li }))}`);
    const arr = (j.requests as SdpReq[]) ?? [];
    out.push(...arr);
    const info = j.list_info as { has_more_rows?: boolean; total_count?: number } | undefined;
    if (page === 0 && info?.total_count) console.log(`  total BI en SDP: ${info.total_count}`);
    if (!info?.has_more_rows || !arr.length) break;
    start += rows;
    if (LIMIT && out.length >= LIMIT) break;
  }
  return LIMIT ? out.slice(0, LIMIT) : out;
}

async function closureOf(z: Zoho, rid: string): Promise<string | undefined> {
  const d = (await sdpGet(z, `requests/${rid}`)).request as { closure_info?: { requester_ack_comments?: string } } | undefined;
  const c = d?.closure_info?.requester_ack_comments;
  return c && String(c).trim() ? String(c) : undefined;
}

async function main() {
  const z = loadZoho(); await zohoRefresh(z);
  const idmap = await loadIdmap();
  const remap = (id?: string): string | undefined => (id && idmap[id]) ? idmap[id] : (id ? String(id) : undefined);
  console.log(`Listando solicitudes BI de SDP (plantillas: ${BI_TEMPLATES.length})…`);
  const reqs = await listBi(z);
  console.log(`  ${reqs.length} solicitudes BI${LIMIT ? ` (LIMIT ${LIMIT})` : ''}`);

  let enriched = 0, created = 0, missing = 0, closures = 0, errors = 0, noop = 0;
  for (let i = 0; i < reqs.length; i += 100) {
    const slice = reqs.slice(i, i + 100);
    const refs = slice.map((r) => db.doc(`tenants/${TENANT}/tickets/#${r.display_id ?? r.id}`));
    const snaps = await db.getAll(...refs);
    const batch = db.batch(); let ops = 0;
    for (let j = 0; j < slice.length; j++) {
      const r = slice[j]!; const snap = snaps[j]!; const prev = snap.exists ? snap.data() as Record<string, unknown> : undefined;
      const sdpUdf: Record<string, string> = {};
      for (const k of UDF_KEYS) { const v = r.udf_fields?.[k]; if (v != null && v !== '') sdpUdf[k] = String(v); }
      const templateName = r.template?.name;
      const isClosed = CLOSED.includes((r.status?.name ?? '').toLowerCase());
      const needClosure = isClosed && (!prev || !prev.closureComment);
      let closure: string | undefined;
      if (needClosure) { try { closure = await closureOf(z, r.id); if (closure) closures++; } catch { errors++; } }

      if (prev) {
        const patch: Record<string, unknown> = {};
        if (Object.keys(sdpUdf).length) patch.sdpUdf = sdpUdf;
        if (templateName) patch.templateName = templateName;
        if (closure) patch.closureComment = closure;
        // Estampa el ámbito v3 (ar-bi/servicio) si falta: el histórico BI se importó sin
        // clasificar (N4) y el informe filtra por `area`. Aditivo: NO toca category/subcategory.
        if (!prev.area) { const v3 = classifyToV3({ template: templateName }); patch.area = v3.area; patch.service = v3.service; }
        if (Object.keys(patch).length) { if (!DRY) { batch.set(refs[j]!, patch, { merge: true }); ops++; } enriched++; } else noop++;
      } else {
        missing++;
        if (CREATE) {
          const v3 = classifyToV3({ template: templateName });
          const createdMs = r.created_time?.value ? Number(r.created_time.value) : Date.now();
          const status = r.status?.name ?? 'Cerrada';
          const doc: Record<string, unknown> = {
            id: `#${r.display_id ?? r.id}`, sdpRid: String(r.id),
            type: r.is_service_request ? 'service_request' : 'incident',
            subject: r.subject ?? '(sin asunto)', description: '',
            requesterId: remap(r.requester?.id ?? undefined) ?? '', technicianId: remap(r.technician?.id ?? undefined) ?? null,
            groupId: r.group?.id ? String(r.group.id) : null,
            area: v3.area, service: v3.service, ...(v3.element ? { element: v3.element } : {}),
            priority: r.priority?.name ?? 'Media', templateId: String(r.template?.id ?? 'tpl-inc'),
            status, slaId: null, resolveDueAt: null, createdAt: createdMs, archived: isArchivedStatus(status),
            statusHistory: [{ state: status, from: createdMs, to: null }],
            templateName, ...(Object.keys(sdpUdf).length ? { sdpUdf } : {}), ...(closure ? { closureComment: closure } : {}),
            syncedAt: Date.now(), source: 'enrich-bi',
          };
          if (!DRY) { batch.set(refs[j]!, doc); ops++; } created++;
        }
      }
    }
    if (!DRY && ops) await batch.commit();
    console.log(`  procesados ${Math.min(i + 100, reqs.length)}/${reqs.length}…`);
  }
  console.log(`\n${DRY ? '[DRY] ' : ''}Hecho. Enriquecidos: ${enriched} · creados: ${created} · sin cambios: ${noop} · faltantes${CREATE ? ' (creados)' : ' (NO creados)'}: ${missing} · comentarios de cierre: ${closures} · errores: ${errors}`);
  if (missing && !CREATE) console.log(`  → ${missing} tickets BI de SDP no existen en Atenza (histórico cerrado). Relanza con CREATE_MISSING=1 para importarlos.`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
