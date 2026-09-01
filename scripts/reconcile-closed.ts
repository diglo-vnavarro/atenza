// ============================================================================
// RECONCILIACIÓN de cierres SDP → Atenza. El ETL solo trae los tickets ACTIVOS
// (excluye Cancelada/Cerrada/Resuelta); cuando un ticket se cierra en SDP sale
// del fetch y el upsert deja de tocarlo → en Atenza se queda "activo" (estancado).
// Este paso detecta los tickets que están activos en Atenza (con sdpId) pero YA
// NO están en el conjunto activo de SDP, consulta su estado REAL en SDP y los
// archiva con ese estado. Preciso y seguro: si SDP dijera que sigue abierto, no
// se archiva; y solo actúa si el fetch de activos vino COMPLETO (== total_count).
//
//   GOOGLE_APPLICATION_CREDENTIALS=<adc> GOOGLE_CLOUD_PROJECT=diglo-desk-pd \
//   TENANT=diglo-it npx tsx scripts/reconcile-closed.ts            (DRY)
//   ...  WRITE=1 npx tsx scripts/reconcile-closed.ts               (aplica)
// En el job (Cloud Run) va tras etl.ts + sync-tickets.ts; credenciales por env
// (ZOHO_*), base por SDP_BASE (igual que el ETL).
// ============================================================================
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { isArchivedStatus } from '../src/model.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const TENANT = process.env.TENANT ?? 'diglo-it';
const BASE = process.env.SDP_BASE ?? 'https://digloitsm.sdpondemand.manageengine.eu/app/itdesk';
const ACCEPT = 'application/vnd.manageengine.sdp.v3+json';
// Estados terminales de SDP para esta instancia (los que definen "no activo").
// Configurable por env porque varían por instancia: diglo-it usa español
// (Cancelada/Cerrada/Resuelta) y leasys inglés (Closed/Canceled/Resolved).
const EXCLUDE = (process.env.SDP_EXCLUDE ?? 'Cancelada,Cerrada,Resuelta').split(',').map((s) => s.trim()).filter(Boolean);
const DRY = process.env.WRITE !== '1';

interface Tok { access_token?: string; refresh_token: string; client_id: string; client_secret: string }
const zoho: Tok = process.env.ZOHO_REFRESH_TOKEN
  ? { refresh_token: process.env.ZOHO_REFRESH_TOKEN, client_id: process.env.ZOHO_CLIENT_ID ?? '', client_secret: process.env.ZOHO_CLIENT_SECRET ?? '' }
  : JSON.parse(readFileSync(join(ROOT, '.zoho.local'), 'utf8'));
let tok = zoho.access_token ?? '';
async function refresh() {
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: zoho.refresh_token, client_id: zoho.client_id, client_secret: zoho.client_secret });
  const r = await fetch('https://accounts.zoho.eu/oauth/v2/token', { method: 'POST', body });
  tok = ((await r.json()) as { access_token?: string }).access_token ?? tok;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function api(path: string): Promise<Record<string, unknown>> {
  for (let a = 0; a < 4; a++) {
    const res = await fetch(`${BASE}/api/v3/${path}`, { headers: { Authorization: `Zoho-oauthtoken ${tok}`, Accept: ACCEPT } });
    if (res.status === 401) { await refresh(); continue; }
    if (res.status === 429) { await sleep(2000); continue; }
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }
  throw new Error(`${path}: reintentos agotados`);
}
const enc = (o: unknown) => encodeURIComponent(JSON.stringify(o));
const digits = (s: string) => s.replace(/\D/g, '');

// Conjunto de display_ids ACTIVOS en SDP (no Cancelada/Cerrada/Resuelta) + control de completitud.
async function activeIds(): Promise<{ ids: Set<string>; total: number; complete: boolean }> {
  const ids = new Set<string>(); let start = 1, total = 0;
  for (let p = 0; p < 600; p++) {
    const li = { row_count: 100, start_index: start, get_total_count: true, fields_required: ['display_id'], search_criteria: [{ field: 'status.name', condition: 'is not', values: EXCLUDE }] };
    const j = await api(`requests?input_data=${enc({ list_info: li })}`);
    const arr = (j.requests as { display_id?: string }[]) ?? [];
    for (const r of arr) if (r.display_id) ids.add(String(r.display_id));
    const l = j.list_info as { has_more_rows?: boolean; total_count?: number } | undefined;
    if (p === 0) total = l?.total_count ?? 0;
    if (!l?.has_more_rows || arr.length === 0) break;
    start += 100; await sleep(120);
  }
  return { ids, total, complete: total > 0 && ids.size >= total };
}

// Estado REAL en SDP de una lista de display_ids (por búsqueda, en lotes).
async function statusByDisplayIds(dids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (let i = 0; i < dids.length; i += 50) {
    const chunk = dids.slice(i, i + 50);
    const li = { row_count: 100, fields_required: ['display_id', 'status'], search_criteria: [{ field: 'display_id', condition: 'is', values: chunk }] };
    const j = await api(`requests?input_data=${enc({ list_info: li })}`);
    for (const r of (j.requests as { display_id?: string; status?: { name?: string } }[]) ?? []) if (r.display_id) map.set(String(r.display_id), r.status?.name ?? 'Cerrada');
    await sleep(150);
  }
  return map;
}

async function main() {
  // En el job va tras etl+sync; solo debe ACTUAR donde hace falta (diglo-it), no
  // en instancias cuyos cierres ya archiva el sync normal (p. ej. leasys, cuyos
  // estados terminales no los excluye el ETL). Gate por env RECONCILE=1.
  if (process.env.RECONCILE !== '1') { console.log('[reconcile] desactivado (RECONCILE≠1); saltando.'); return; }
  await refresh();
  const { ids, total, complete } = await activeIds();
  console.log(`[${TENANT}] SDP activos: ${ids.size} (total_count ${total}) · completo=${complete}`);
  if (!complete) { console.warn('[reconcile] el fetch de activos NO vino completo → se salta esta pasada (no se archiva por error).'); return; }

  initializeApp({ projectId: process.env.GOOGLE_CLOUD_PROJECT ?? 'diglo-desk-pd' });
  const db = getFirestore();
  const snap = await db.collection(`tenants/${TENANT}/tickets`).where('archived', '==', false).get();
  const disappeared = snap.docs.filter((d) => { const sid = d.get('sdpId'); const dd = digits(String(d.id)); return sid && dd && !ids.has(dd); });
  console.log(`[${TENANT}] Atenza activos: ${snap.size} · fuera del activo de SDP (a reconciliar): ${disappeared.length}`);
  if (!disappeared.length) { console.log('Nada que reconciliar.'); return; }

  const statusMap = await statusByDisplayIds(disappeared.map((d) => digits(String(d.id))));
  let toArchive = 0, keptOpen = 0, notFound = 0;
  const now = Date.now();
  for (let i = 0; i < disappeared.length; i += 400) {
    const batch = db.batch();
    for (const d of disappeared.slice(i, i + 400)) {
      const hit = statusMap.get(digits(String(d.id)));
      if (!hit) notFound++;
      const status = hit ?? 'Cerrada'; // sin registro en SDP (borrado) → Cerrada
      const archived = isArchivedStatus(status);
      if (archived) toArchive++; else keptOpen++;
      if (!DRY) batch.set(d.ref, { status, archived, syncedAt: now, reconciledAt: now }, { merge: true });
    }
    if (!DRY) await batch.commit();
  }
  console.log(`${DRY ? '[DRY] ' : ''}[${TENANT}] reconciliados ${disappeared.length}: archivados ${toArchive} · seguían abiertos (solo estado) ${keptOpen} · no hallados en SDP→Cerrada ${notFound}`);
  if (DRY) console.log('DRY: nada escrito. Relanza con WRITE=1 para aplicar.');
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
