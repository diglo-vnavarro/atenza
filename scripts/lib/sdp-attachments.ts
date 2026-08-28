// SDP (Zoho) + descarga/subida de ADJUNTOS. Compartido por scripts/migrate-attachments.ts
// (backfill del histórico) y scripts/sync-tickets.ts (adjuntos nuevos en la sync diaria).
// Auth Zoho por env (ZOHO_*, Cloud Run) o fichero .zoho.local (local).
import { readFileSync, writeFileSync } from 'node:fs';

export interface Zoho { access_token: string; refresh_token: string; client_id: string; client_secret: string }
const BASE = process.env.SDP_BASE ?? 'https://digloitsm.sdpondemand.manageengine.eu/app/itdesk';
const ACCEPT = 'application/vnd.manageengine.sdp.v3+json';

export function loadZoho(): Zoho {
  if (process.env.ZOHO_REFRESH_TOKEN) return { access_token: '', refresh_token: process.env.ZOHO_REFRESH_TOKEN, client_id: process.env.ZOHO_CLIENT_ID ?? '', client_secret: process.env.ZOHO_CLIENT_SECRET ?? '' };
  return JSON.parse(readFileSync('.zoho.local', 'utf8')) as Zoho;
}
export async function zohoRefresh(z: Zoho): Promise<void> {
  const b = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: z.refresh_token, client_id: z.client_id, client_secret: z.client_secret });
  const j = await (await fetch('https://accounts.zoho.eu/oauth/v2/token', { method: 'POST', body: b })).json() as { access_token?: string };
  if (j.access_token) { z.access_token = j.access_token; if (!process.env.ZOHO_REFRESH_TOKEN) { try { writeFileSync('.zoho.local', JSON.stringify(z)); } catch { /* ro */ } } }
}
export async function sdpGet(z: Zoho, path: string): Promise<Record<string, unknown>> {
  let r = await fetch(`${BASE}/api/v3/${path}`, { headers: { Authorization: `Zoho-oauthtoken ${z.access_token}`, Accept: ACCEPT } });
  if (r.status === 401) { await zohoRefresh(z); r = await fetch(`${BASE}/api/v3/${path}`, { headers: { Authorization: `Zoho-oauthtoken ${z.access_token}`, Accept: ACCEPT } }); }
  return r.json() as Promise<Record<string, unknown>>;
}
// Descarga el binario. El content_url viene como «/requests/{id}/_uploads/{file_id}»; el endpoint
// real es BASE/api/v3 + content_url (verificado). 401 → refresca y reintenta.
export async function sdpBin(z: Zoho, contentUrl: string): Promise<Buffer> {
  const url = `${BASE}/api/v3${contentUrl}`;
  let r = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${z.access_token}` } });
  if (r.status === 401) { await zohoRefresh(z); r = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${z.access_token}` } }); }
  if (!r.ok) throw new Error(`descarga ${r.status} ${contentUrl}`);
  return Buffer.from(await r.arrayBuffer());
}

export interface SdpAttachment { id: string; name: string; size: number; content_type?: string; content_url: string }
export function attachmentsOf(detail: Record<string, unknown>): SdpAttachment[] {
  const arr = (detail.attachments as Record<string, unknown>[] | undefined) ?? [];
  return arr.filter((a) => a && a.content_url).map((a) => ({ id: String(a.id ?? a.file_id), name: String(a.name ?? a.file_name ?? a.id), size: Number(a.size ?? a.content_size ?? 0), content_type: a.content_type as string | undefined, content_url: String(a.content_url) }));
}

/** Bucket mínimo (firebase-admin Storage) que necesitamos. */
export interface UploadBucket { file(path: string): { save(data: Buffer, opts: { contentType?: string; resumable?: boolean }): Promise<void> } }
export interface AttRec { id: string; name: string; size: number; contentType?: string; path: string; uploadedBy: string; uploadedByName: string; at: number }

/** Descarga los adjuntos de un request SDP y los sube a Storage; devuelve los registros Attachment. */
export async function fetchAndUpload(z: Zoho, bucket: UploadBucket, tenant: string, docId: string, sdpId: string, atts: SdpAttachment[], now: number): Promise<AttRec[]> {
  const recs: AttRec[] = [];
  for (const a of atts) {
    const buf = await sdpBin(z, a.content_url);
    const safe = a.name.replace(/[^\w.\-]+/g, '_');
    const path = `tenants/${tenant}/tickets/${docId}/sdp-${a.id}-${safe}`;
    await bucket.file(path).save(buf, { contentType: a.content_type ?? 'application/octet-stream', resumable: false });
    recs.push({ id: `sdp-${a.id}`, name: a.name, size: a.size || buf.byteLength, ...(a.content_type ? { contentType: a.content_type } : {}), path, uploadedBy: 'sdp', uploadedByName: 'SDP (import)', at: now });
  }
  return recs;
}
