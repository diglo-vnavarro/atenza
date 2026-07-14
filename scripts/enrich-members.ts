// Enriquece los MIEMBROS ya existentes en Firestore con su sede, departamento,
// grupos de usuarios y grupos de soporte tomados de SDP (API v3). Arregla el hueco
// detectado en el análisis: en la nube los miembros no traían site/department/
// userGroups (y solo los técnicos traían groupIds). Idempotente y no crea miembros
// nuevos: solo hace merge sobre los que ya están (match por uid = id de SDP).
//
//   GOOGLE_APPLICATION_CREDENTIALS=<adc> GOOGLE_CLOUD_PROJECT=diglo-desk-pd \
//   TENANT=diglo-it npx tsx scripts/enrich-members.ts            (aplica)
//   ...  DRY_RUN=1  npx tsx scripts/enrich-members.ts            (previsualiza)
//
// Token de Zoho: env (ZOHO_REFRESH_TOKEN/CLIENT_ID/CLIENT_SECRET) o .zoho.local.
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
  ? { access_token: process.env.ZOHO_ACCESS_TOKEN ?? '', refresh_token: process.env.ZOHO_REFRESH_TOKEN, client_id: process.env.ZOHO_CLIENT_ID ?? '', client_secret: process.env.ZOHO_CLIENT_SECRET ?? '' }
  : JSON.parse(readFileSync(join(ROOT, '.zoho.local'), 'utf8'));

async function refresh(): Promise<void> {
  if (!zoho.refresh_token) return;
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: zoho.refresh_token, client_id: zoho.client_id, client_secret: zoho.client_secret });
  const r = await fetch('https://accounts.zoho.eu/oauth/v2/token', { method: 'POST', body });
  const j = (await r.json()) as { access_token?: string };
  if (j.access_token) zoho.access_token = j.access_token;
}
async function api(path: string): Promise<Record<string, unknown>> {
  for (let a = 0; a < 4; a++) {
    const res = await fetch(`${BASE}/api/v3/${path}`, { headers: { Authorization: `Zoho-oauthtoken ${zoho.access_token}`, Accept: ACCEPT } });
    if (res.status === 401) { await refresh(); continue; }
    if (res.status === 429) { await new Promise((r) => setTimeout(r, 2000)); continue; }
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }
  throw new Error(`${path}: reintentos agotados`);
}

interface SdpUser { id?: string; name?: string; email_id?: string; site?: { name?: string } | null; department?: { name?: string } | null; user_groups?: { name?: string }[] }
const q = (o: object) => encodeURIComponent(JSON.stringify(o));

/** Trae todas las páginas de un recurso de personas (technicians | requesters). */
async function fetchPeople(resource: string): Promise<SdpUser[]> {
  const out: SdpUser[] = [];
  let start = 1;
  for (let page = 0; page < 60; page++) {
    const j = await api(`${resource}?input_data=${q({ list_info: { row_count: 100, start_index: start } })}`);
    const arr = (j[resource] as SdpUser[]) ?? [];
    out.push(...arr);
    const li = j.list_info as { has_more_rows?: boolean } | undefined;
    if (!li?.has_more_rows || !arr.length) break; start += 100;
  }
  return out;
}

initializeApp({ projectId: process.env.GOOGLE_CLOUD_PROJECT ?? 'diglo-desk-pd' });
const db = getFirestore();

async function main() {
  await refresh();
  console.log(`${DRY ? '=== DRY-RUN === ' : ''}Enriquecer miembros de ${TENANT} desde SDP.`);
  const people = [...await fetchPeople('technicians'), ...await fetchPeople('requesters')];
  // mapa uid SDP -> {site, department, userGroups}
  const byId = new Map<string, { site?: string; department?: string; userGroups?: string[] }>();
  for (const p of people) {
    if (!p.id) continue;
    const site = p.site?.name; const department = p.department?.name;
    const userGroups = (p.user_groups ?? []).map((g) => g.name).filter((n): n is string => !!n);
    byId.set(String(p.id), { site, department, userGroups: userGroups.length ? userGroups : undefined });
  }
  console.log(`SDP: ${people.length} personas · con sede: ${[...byId.values()].filter((x) => x.site).length} · con departamento: ${[...byId.values()].filter((x) => x.department).length}`);

  const ms = await db.collection(`tenants/${TENANT}/members`).get();
  let patched = 0, matched = 0;
  const batch = db.batch();
  ms.forEach((d) => {
    const info = byId.get(d.id);
    if (!info) return;
    matched++;
    const patch: Record<string, unknown> = {};
    if (info.site) patch.site = info.site;
    if (info.department) patch.department = info.department;
    if (info.userGroups) patch.userGroups = info.userGroups;
    if (Object.keys(patch).length === 0) return;
    patched++;
    if (!DRY) batch.set(d.ref, patch, { merge: true });
  });
  if (!DRY) await batch.commit();
  console.log(`${DRY ? '[DRY] ' : ''}miembros: ${ms.size} en Atenza · ${matched} casan con SDP · ${patched} enriquecidos (site/department/userGroups).`);
  if (DRY) console.log('DRY-RUN: nada escrito.');
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
