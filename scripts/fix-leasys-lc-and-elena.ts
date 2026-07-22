// Arreglos puntuales sobre el tenant `leasys` (una sola pasada, idempotente):
//  1) CICLO DE VIDA lc-leasys: las transiciones se crearon sin `id`/`name` (y el
//     ciclo sin `version`), por lo que el lienzo (React Flow) no podía pintar las
//     flechas (todas las aristas con id=undefined colapsan). Se rellenan con la
//     misma convención que usa la app: id=`tr_${from}_${to}`, name=`${lf} → ${lt}`.
//  2) Elena Andrés (eandres@digloservicer.com) pasa a ADMINISTRADORA de Leasys:
//     role=tenant_admin, roleName=SDAdmin (todas las capacidades), enabled=true.
//
//   GOOGLE_APPLICATION_CREDENTIALS=<adc> GOOGLE_CLOUD_PROJECT=diglo-desk-pd \
//   npx tsx scripts/fix-leasys-lc-and-elena.ts           (DRY: solo muestra)
//   ...  WRITE=1 npx tsx scripts/fix-leasys-lc-and-elena.ts   (aplica)
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const WRITE = process.env.WRITE === '1';
const TENANT = 'leasys';
const ELENA_SDP_ID = '26423000000337497';
initializeApp({ projectId: process.env.GOOGLE_CLOUD_PROJECT ?? 'diglo-desk-pd' });
const db = getFirestore();

type St = { key: string; label: string };
type Tr = { id?: string; name?: string; from: string; to: string };

async function fixLifecycle() {
  const ref = db.doc(`tenants/${TENANT}/lifecycles/lc-leasys`);
  const snap = await ref.get();
  if (!snap.exists) { console.log('  ⚠ lc-leasys no existe'); return; }
  const lc = snap.data() as { version?: string; states: St[]; transitions: Tr[] };
  const label = new Map(lc.states.map((s) => [s.key, s.label]));
  const before = lc.transitions.filter((t) => t.id && t.name).length;
  const transitions = lc.transitions.map((t) => ({
    id: t.id ?? `tr_${t.from}_${t.to}`,
    name: t.name ?? `${label.get(t.from) ?? t.from} → ${label.get(t.to) ?? t.to}`,
    from: t.from, to: t.to,
  }));
  const version = lc.version ?? '1.0';
  console.log(`  ciclo lc-leasys: ${lc.transitions.length} transiciones · ${before} ya tenían id/name · version=${lc.version ?? '∅'}→${version}`);
  if (WRITE) { await ref.set({ version, transitions }, { merge: true }); console.log('  ✓ ciclo actualizado (id/name/version)'); }
}

async function promoteElena() {
  const ref = db.doc(`tenants/${TENANT}/members/${ELENA_SDP_ID}`);
  const snap = await ref.get();
  if (!snap.exists) { console.log('  ⚠ ficha de Elena no existe'); return; }
  console.log(`  Elena (${snap.get('email')}): role ${snap.get('role')}→tenant_admin · roleName ${snap.get('roleName') ?? '∅'}→SDAdmin · enabled→true`);
  if (WRITE) { await ref.set({ role: 'tenant_admin', roleName: 'SDAdmin', enabled: true }, { merge: true }); console.log('  ✓ Elena ascendida a administradora de Leasys'); }
}

(async () => {
  console.log(`${WRITE ? '' : '[DRY] '}Arreglos tenant ${TENANT}:`);
  await fixLifecycle();
  await promoteElena();
  if (!WRITE) console.log('\n[DRY] Nada escrito. Relanza con WRITE=1 para aplicar.');
})().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
