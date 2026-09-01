// M1 — BACKFILL de los ADJUNTOS de SDP a Firebase Storage (bucket diglo-desk-pd-atenza-files) +
// referencia en el ticket. Reanudable e IDEMPOTENTE (por adjunto: salta los ya migrados
// «sdp-{id}»). El lifecycle del bucket (Nearline 30d / Coldline 90d) los abarata.
//
//   dry-run (por defecto): recorre SDP, cuenta ficheros y suma tamaños EXACTOS. No descarga/escribe.
//   --apply: descarga de SDP → sube a Storage → patch ticket.attachments.
//   LIMIT=N acota. GOOGLE_CLOUD_PROJECT=diglo-desk-pd TENANT=diglo-it npx tsx scripts/migrate-attachments.ts [--apply]
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { loadZoho, zohoRefresh, sdpGet, attachmentsOf, fetchAndUpload, type AttRec } from './lib/sdp-attachments.js';

const APPLY = process.argv.includes('--apply');
const LIMIT = Number(process.env.LIMIT ?? 0);
const PROJECT = process.env.GOOGLE_CLOUD_PROJECT ?? 'diglo-desk-pd';
const TENANT = process.env.TENANT ?? 'diglo-it';
const BUCKET = process.env.BUCKET ?? 'diglo-desk-pd-atenza-files';

const z = loadZoho();
initializeApp({ projectId: PROJECT, storageBucket: BUCKET });
const db = getFirestore();
const bucket = getStorage().bucket();
const q = (o: object) => encodeURIComponent(JSON.stringify(o));

async function findTicketDoc(sdpId: string): Promise<string | null> {
  for (const cand of [`#${sdpId}`, sdpId]) if ((await db.doc(`tenants/${TENANT}/tickets/${cand}`).get()).exists) return cand;
  return null;
}

async function main(): Promise<void> {
  await zohoRefresh(z);
  let start = 1, scanned = 0, withA = 0, files = 0, bytes = 0, migrated = 0, skipped = 0, noDoc = 0, errors = 0;
  for (let page = 0; page < 400; page++) {
    const j = await sdpGet(z, `requests?input_data=${q({ list_info: { row_count: 100, start_index: start, fields_required: ['id', 'has_attachments'] } })}`);
    const arr = (j.requests as { id: string; has_attachments?: boolean }[]) ?? [];
    if (!arr.length) break;
    for (const r of arr) {
      if (LIMIT && scanned >= LIMIT) break;
      scanned++;
      if (r.has_attachments === false) continue;
      const d = (await sdpGet(z, `requests/${r.id}`)).request as Record<string, unknown> | undefined ?? {};
      const atts = attachmentsOf(d);
      if (!atts.length) continue;
      withA++; files += atts.length; for (const a of atts) bytes += a.size;
      if (APPLY) {
        const docId = await findTicketDoc(String(d.display_id ?? r.id)); // el doc de ticketIN es #{display_id}
        if (!docId) { noDoc++; continue; }
        const ref = db.doc(`tenants/${TENANT}/tickets/${docId}`);
        const cur = ((await ref.get()).data() ?? {}) as { attachments?: AttRec[] };
        const have = new Set((cur.attachments ?? []).map((a) => a.id));
        const todo = atts.filter((a) => !have.has(`sdp-${a.id}`)); // idempotente por adjunto
        if (!todo.length) { skipped++; continue; }
        try {
          const recs = await fetchAndUpload(z, bucket, TENANT, docId, String(r.id), todo, Date.now());
          await ref.set({ attachments: [...(cur.attachments ?? []), ...recs] }, { merge: true });
          migrated++;
        } catch (e) { errors++; console.error(`  x ${r.id}: ${(e as Error).message}`); }
      }
    }
    if (LIMIT && scanned >= LIMIT) break;
    start += 100;
    if (page % 5 === 0) console.error(`  …${scanned} escaneados · ${withA} con adj · ${files} fich · ${(bytes / 1048576).toFixed(0)} MB${APPLY ? ` · ${migrated} migrados · ${errors} err` : ''}`);
  }
  console.log(`\nSDP: ${scanned} solicitudes · ${withA} con adjuntos · ${files} ficheros · ${(bytes / 1073741824).toFixed(2)} GB`);
  if (APPLY) console.log(`✓ Migrados: ${migrated} tickets · saltados: ${skipped} · sin doc en ticketIN: ${noDoc} · errores: ${errors}`);
  else console.log(`(dry-run: NO descargó ni escribió. --apply para migrar. LIMIT=N acota.)`);
}
main().then(() => process.exit(0)).catch((e) => { console.error('ERROR:', (e as Error).message); process.exit(1); });
