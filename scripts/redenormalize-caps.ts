// Re-denormaliza las CAPACIDADES (`caps`) de los miembros a partir de su rol + la definición de
// roles del tenant. Necesario cuando se añade una capacidad nueva a DEFAULT_CAPS (p. ej.
// `manageReports`): las reglas leen `member.caps` (denormalizado), que la sync PRESERVA y no
// actualiza. Idempotente: solo escribe los miembros cuyo array de caps cambie.
//
//   GOOGLE_APPLICATION_CREDENTIALS=<adc> GOOGLE_CLOUD_PROJECT=diglo-desk-pd \
//   TENANT=diglo-it npx tsx scripts/redenormalize-caps.ts        (aplica)
//   ... DRY_RUN=1   → solo reporta qué cambiaría.
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { memberCaps, type RoleDef, type RoleBase } from '../src/data/seed.js';

const TENANT = process.env.TENANT ?? 'diglo-it';
const DRY = process.env.DRY_RUN === '1' || process.argv.includes('--dry-run');
initializeApp({ projectId: process.env.GOOGLE_CLOUD_PROJECT ?? 'diglo-desk-pd' });
const db = getFirestore();

const same = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');

async function main() {
  const roles = ((await db.doc(`tenants/${TENANT}`).get()).data()?.roles ?? []) as RoleDef[];
  const snap = await db.collection(`tenants/${TENANT}/members`).get();
  let changed = 0, unchanged = 0; const added = new Set<string>();
  let batch = db.batch(), ops = 0;
  for (const d of snap.docs) {
    const m = d.data() as { role?: RoleBase; roleName?: string; caps?: string[] };
    if (!m.role) { unchanged++; continue; }
    const next = memberCaps({ role: m.role, roleName: m.roleName }, roles);
    const prev = m.caps ?? [];
    if (same(prev, next)) { unchanged++; continue; }
    for (const c of next) if (!prev.includes(c)) added.add(c);
    changed++;
    if (!DRY) { batch.update(d.ref, { caps: next }); if (++ops % 400 === 0) { await batch.commit(); batch = db.batch(); } }
  }
  if (!DRY && ops % 400 !== 0) await batch.commit();
  console.log(`${DRY ? '[DRY] ' : ''}miembros: ${changed} actualizados · ${unchanged} sin cambios. Caps añadidas: ${[...added].join(', ') || '—'}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
