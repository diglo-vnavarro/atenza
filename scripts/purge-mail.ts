// Vacía la cola de correo `mail` (documentos que consume la extensión firestore-send-email).
// Uso previsto: tras clonar pd → dv, antes de instalar la extensión en dv, para que no
// reenvíe al sandbox los correos heredados de producción. Dry-run por defecto.
//
//   GOOGLE_CLOUD_PROJECT=diglo-desk-dv npx tsx scripts/purge-mail.ts           # cuenta y lista
//   GOOGLE_CLOUD_PROJECT=diglo-desk-dv APPLY=1 npx tsx scripts/purge-mail.ts   # borra
//
// Rechaza ejecutarse contra producción salvo FORCE_PROD=1 (en pd la cola es real).
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT;
if (!PROJECT) throw new Error('Falta GOOGLE_CLOUD_PROJECT (p. ej. diglo-desk-dv).');
if (PROJECT.endsWith('-pd') && process.env.FORCE_PROD !== '1') {
  throw new Error(`${PROJECT} es producción: la cola mail es real. Si de verdad quieres vaciarla, FORCE_PROD=1.`);
}
const APPLY = process.env.APPLY === '1';

initializeApp({ projectId: PROJECT });
const db = getFirestore();

(async () => {
  const snap = await db.collection('mail').get();
  console.log(`# ${PROJECT} · mail: ${snap.size} documento(s) ${APPLY ? '→ BORRANDO' : '(dry-run)'}`);
  for (const d of snap.docs.slice(0, 10)) {
    const to = d.get('to'); const subject = d.get('message')?.subject ?? d.get('subject') ?? '';
    console.log(`  · ${d.id}  to=${Array.isArray(to) ? to.join(',') : to ?? '-'}  «${subject}»`);
  }
  if (snap.size > 10) console.log(`  … y ${snap.size - 10} más`);
  if (!APPLY) { console.log('(dry-run) No se ha borrado nada. Repite con APPLY=1.'); return; }
  let n = 0;
  for (let i = 0; i < snap.docs.length; i += 400) {
    const batch = db.batch();
    for (const d of snap.docs.slice(i, i + 400)) { batch.delete(d.ref); n++; }
    await batch.commit();
  }
  console.log(`✓ ${n} documento(s) borrados de mail en ${PROJECT}.`);
})().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
