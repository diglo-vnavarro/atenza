// Admin de MFA (2º factor TOTP). Usa Firebase Admin Auth (el estado del factor lo custodia
// Identity Platform, no Firestore).
//   GOOGLE_CLOUD_PROJECT=diglo-desk-pd TENANT=diglo-it npx tsx scripts/mfa-admin.ts <cmd>
//     status <email>   → muestra los factores MFA enrolados del usuario
//     reset  <email>   → borra los factores (soporte: si pierde el móvil; se re-enrola al entrar)
//     sync             → estampa `mfaEnrolled` en las fichas de miembro según Firebase Auth
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT ?? 'diglo-desk-pd';
const TENANT = process.env.TENANT ?? 'diglo-it';
initializeApp({ projectId: PROJECT });
const auth = getAuth();
const db = getFirestore();

async function status(email: string) {
  const u = await auth.getUserByEmail(email);
  const factors = u.multiFactor?.enrolledFactors ?? [];
  console.log(`${email} · uid=${u.uid} · proveedores=${u.providerData.map((p) => p.providerId).join(', ')}`);
  console.log(`  Factores MFA enrolados: ${factors.length}`);
  for (const f of factors) console.log(`   · ${f.factorId} «${f.displayName ?? ''}» enrolado ${f.enrollmentTime ?? ''}`);
}

async function reset(email: string) {
  const u = await auth.getUserByEmail(email);
  await auth.updateUser(u.uid, { multiFactor: { enrolledFactors: null } }); // borra TODOS los factores
  console.log(`✓ MFA reseteado para ${email} (uid ${u.uid}). Se re-enrola en el próximo acceso.`);
}

async function sync() {
  const enrolled = new Map<string, boolean>();
  let token: string | undefined;
  do {
    const res = await auth.listUsers(1000, token);
    for (const u of res.users) enrolled.set(u.uid, (u.multiFactor?.enrolledFactors ?? []).length > 0);
    token = res.pageToken;
  } while (token);
  const ms = await db.collection(`tenants/${TENANT}/members`).get();
  const batch = db.batch(); let n = 0, con = 0;
  ms.forEach((d) => {
    const has = enrolled.get(d.id);
    if (has === undefined) return; // ficha sin usuario Auth casado (p. ej. id de SDP)
    if (has) con++;
    if ((d.data().mfaEnrolled ?? false) !== has) { batch.set(d.ref, { mfaEnrolled: has }, { merge: true }); n++; }
  });
  if (n) await batch.commit();
  console.log(`✓ mfaEnrolled sincronizado · ${n} fichas actualizadas · ${con} miembros con 2º factor.`);
}

const [cmd, arg] = process.argv.slice(2);
const run = cmd === 'status' && arg ? status(arg)
  : cmd === 'reset' && arg ? reset(arg)
  : cmd === 'sync' ? sync()
  : Promise.resolve(console.log('Uso: mfa-admin.ts status|reset <email> | sync'));
run.then(() => process.exit(0)).catch((e) => { console.error(e.message ?? e); process.exit(1); });
