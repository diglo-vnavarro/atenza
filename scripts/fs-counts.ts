// Recuento de documentos por colección raíz y por subcolección de tenants (SOLO LECTURA).
// Útil para comparar entornos (p. ej. antes/después de clonar pd → dv).
//   GOOGLE_CLOUD_PROJECT=diglo-desk-pd npx tsx scripts/fs-counts.ts
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT ?? 'diglo-desk-pd';
initializeApp({ projectId: PROJECT });
const db = getFirestore();

(async () => {
  console.log(`# ${PROJECT}`);
  const cols = await db.listCollections();
  for (const c of cols) {
    const n = (await c.count().get()).data().count;
    console.log(`${c.id}\t${n}`);
  }
  const ts = await db.collection('tenants').get();
  for (const t of ts.docs) {
    const sub = await t.ref.listCollections();
    const parts: string[] = [];
    for (const s of sub) parts.push(`${s.id}=${(await s.count().get()).data().count}`);
    const b = t.get('branding');
    console.log(`  tenant ${t.id}  branding=${b ? Object.keys(b).join(',') : '-'}  ${parts.join(' ')}`);
  }
})().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
