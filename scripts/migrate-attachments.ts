// M1 — migra los ADJUNTOS de SDP a Firebase Storage (bucket diglo-desk-pd-atenza-files) y los
// referencia en el ticket de Atenza. Reanudable e IDEMPOTENTE (salta tickets que ya tienen
// adjuntos). El lifecycle del bucket (Nearline 30d / Coldline 90d) los abarata solo.
//
//   dry-run (por defecto): recorre SDP, cuenta ficheros y suma tamaños EXACTOS. NO descarga ni escribe.
//   --apply: descarga de SDP → sube a Storage → patch ticket.attachments.
//   LIMIT=N para acotar (0=todos). GOOGLE_CLOUD_PROJECT=diglo-desk-pd TENANT=diglo-it \
//   npx tsx scripts/migrate-attachments.ts [--apply]
import { readFileSync, writeFileSync } from 'node:fs';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

const APPLY = process.argv.includes('--apply');
const LIMIT = Number(process.env.LIMIT ?? 0); // 0 = todos
const PROJECT = process.env.GOOGLE_CLOUD_PROJECT ?? 'diglo-desk-pd';
const TENANT = process.env.TENANT ?? 'diglo-it';
const BUCKET = process.env.BUCKET ?? 'diglo-desk-pd-atenza-files';
const BASE = process.env.SDP_BASE ?? 'https://digloitsm.sdpondemand.manageengine.eu/app/itdesk';
const ACCEPT = 'application/vnd.manageengine.sdp.v3+json';

const z = JSON.parse(readFileSync('.zoho.local', 'utf8')) as { access_token: string; refresh_token: string; client_id: string; client_secret: string };
async function refresh(): Promise<void> {
  const b = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: z.refresh_token, client_id: z.client_id, client_secret: z.client_secret });
  const j = await (await fetch('https://accounts.zoho.eu/oauth/v2/token', { method: 'POST', body: b })).json() as { access_token?: string };
  if (j.access_token) { z.access_token = j.access_token; try { writeFileSync('.zoho.local', JSON.stringify(z)); } catch { /* ro */ } }
}
async function api(path: string): Promise<Record<string, unknown>> {
  let r = await fetch(`${BASE}/api/v3/${path}`, { headers: { Authorization: `Zoho-oauthtoken ${z.access_token}`, Accept: ACCEPT } });
  if (r.status === 401) { await refresh(); r = await fetch(`${BASE}/api/v3/${path}`, { headers: { Authorization: `Zoho-oauthtoken ${z.access_token}`, Accept: ACCEPT } }); }
  return r.json() as Promise<Record<string, unknown>>;
}
async function fetchBin(url: string): Promise<Buffer> {
  const r = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${z.access_token}` } });
  if (!r.ok) throw new Error(`descarga ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
const q = (o: object) => encodeURIComponent(JSON.stringify(o));

initializeApp({ projectId: PROJECT, storageBucket: BUCKET });
const db = getFirestore();
const bucket = getStorage().bucket();

// El ticket en Firestore tiene doc id «#NNNNN» (o el id crudo). Localiza el doc del request SDP.
async function findTicketDoc(sdpId: string): Promise<string | null> {
  for (const cand of [`#${sdpId}`, sdpId]) { if ((await db.doc(`tenants/${TENANT}/tickets/${cand}`).get()).exists) return cand; }
  return null;
}

async function main(): Promise<void> {
  await refresh();
  let start = 1, scanned = 0, withA = 0, files = 0, bytes = 0, migrated = 0, skipped = 0, noDoc = 0;
  for (let page = 0; page < 400; page++) {
    const j = await api(`requests?input_data=${q({ list_info: { row_count: 100, start_index: start, fields_required: ['id', 'has_attachments'] } })}`);
    const arr = (j.requests as { id: string; has_attachments?: boolean }[]) ?? [];
    if (!arr.length) break;
    for (const r of arr) {
      if (LIMIT && scanned >= LIMIT) break;
      scanned++;
      if (r.has_attachments === false) continue; // atajo si la lista lo indica
      const d = (await api(`requests/${r.id}`)).request as Record<string, unknown> | undefined ?? {};
      const atts = (d.attachments as { id: string; name?: string; file_name?: string; size?: number; content_size?: number; content_type?: string; content_url?: string }[]) ?? [];
      if (!atts.length) continue;
      withA++; files += atts.length; for (const a of atts) bytes += Number(a.size ?? a.content_size ?? 0);
      if (APPLY) {
        const docId = await findTicketDoc(r.id);
        if (!docId) { noDoc++; continue; }
        const ref = db.doc(`tenants/${TENANT}/tickets/${docId}`);
        const cur = (await ref.get()).data() ?? {};
        if (((cur.attachments as unknown[]) ?? []).length) { skipped++; continue; } // ya migrado
        const recs = [];
        for (const a of atts) {
          const url = a.content_url ?? `${BASE}/api/v3/requests/${r.id}/_uploads/${a.id}/download`;
          const buf = await fetchBin(url);
          const safe = String(a.name ?? a.file_name ?? a.id).replace(/[^\w.\-]+/g, '_');
          const path = `tenants/${TENANT}/tickets/${docId}/sdp-${a.id}-${safe}`;
          await bucket.file(path).save(buf, { contentType: a.content_type ?? 'application/octet-stream' });
          recs.push({ id: `sdp-${a.id}`, name: a.name ?? safe, size: Number(a.size ?? buf.byteLength), ...(a.content_type ? { contentType: a.content_type } : {}), path, uploadedBy: 'sdp', uploadedByName: 'SDP (import)', at: Date.now() });
        }
        await ref.set({ attachments: [...((cur.attachments as unknown[]) ?? []), ...recs] }, { merge: true });
        migrated++;
      }
    }
    if (LIMIT && scanned >= LIMIT) break;
    start += 100;
    if (page % 10 === 0) console.error(`  …${scanned} escaneados · ${files} ficheros · ${(bytes / 1048576).toFixed(0)} MB`);
  }
  console.log(`\nSDP: ${scanned} solicitudes · ${withA} con adjuntos · ${files} ficheros · ${(bytes / 1073741824).toFixed(2)} GB`);
  if (APPLY) console.log(`✓ Migrados: ${migrated} tickets · saltados (ya con adjuntos): ${skipped}${noDoc ? ` · sin doc en Atenza: ${noDoc}` : ''}.`);
  else console.log(`(dry-run: NO descargó ni escribió nada. Añade --apply para migrar. LIMIT=N para acotar.)`);
}
main().catch((e) => { console.error('ERROR:', (e as Error).message); process.exit(1); });
