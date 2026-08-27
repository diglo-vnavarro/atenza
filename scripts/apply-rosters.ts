// Sprint 2 (G4) — aplica las MEMBRESÍAS por grupo según la hoja «Grupos» del Excel
// (importer/roster-v2.json). Deja cada grupo con EXACTAMENTE su roster destino. Usa el
// resolvedor compartido scripts/lib/roster-resolve.ts (mismo que la sync). Solo miembros ACTIVOS.
//
//   dry-run (por defecto): NO escribe; muestra +altas/-bajas y los nombres SIN casar.
//   --apply: escribe member.groupIds (aborta si hay nombres sin resolver).
//   --show-map: además imprime la tabla de resolución de nombres.
//   GOOGLE_CLOUD_PROJECT=diglo-desk-pd TENANT=diglo-it npx tsx scripts/apply-rosters.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { planRoster, type RosterRow } from './lib/roster-resolve.js';

const APPLY = process.argv.includes('--apply');
const PROJECT = process.env.GOOGLE_CLOUD_PROJECT ?? 'diglo-desk-pd';
const TENANT = process.env.TENANT ?? 'diglo-it';
const here = dirname(fileURLToPath(import.meta.url));
const roster = JSON.parse(readFileSync(join(here, '..', 'importer', 'roster-v2.json'), 'utf8')) as RosterRow[];
const GROUP_ALIAS: Record<string, string> = { 'Técnicos IT': 'IT' }; // fusión de IT

initializeApp({ projectId: PROJECT });
const db = getFirestore();

async function main(): Promise<void> {
  const groups = (await db.collection(`tenants/${TENANT}/groups`).get()).docs.map((d) => ({ id: d.id, name: String(d.data().name ?? '') }));
  const members = (await db.collection(`tenants/${TENANT}/members`).get()).docs
    .map((d) => ({ uid: d.id, name: String(d.data().name ?? ''), email: String(d.data().email ?? ''), status: d.data().status as string, groupIds: (d.data().groupIds ?? []) as string[] }))
    .filter((m) => m.status === 'active');
  const plan = planRoster(roster, groups, members, GROUP_ALIAS);

  console.log(`=== ROSTERS (${plan.changes.length} grupos con cambios) ===`);
  for (const c of plan.changes) { console.log(`\n■ ${c.group}`); if (c.add.length) console.log(`   + ${c.add.join(', ')}`); if (c.rem.length) console.log(`   - ${c.rem.join(', ')}`); }
  if (plan.unresolvedGroups.length) console.log(`\n⚠ grupos del Excel sin equivalente real (${plan.unresolvedGroups.length}): ${plan.unresolvedGroups.join(' · ')}`);
  if (plan.unmatched.length) { console.log(`\n⚠ NOMBRES SIN RESOLVER (${plan.unmatched.length}):`); for (const u of plan.unmatched) console.log(`   [${u.group}] «${u.name}» → ${u.note}`); }
  console.log(`\nResumen: ${plan.addN} altas · ${plan.remN} bajas · ${plan.perMember.size} miembros afectados · ${plan.unmatched.length} sin resolver.`);

  if (APPLY) {
    if (plan.unmatched.length) { console.log('\n✋ Hay nombres sin resolver. Arréglalos antes de aplicar. NO se ha escrito nada.'); return; }
    let batch = db.batch(), n = 0;
    for (const [uid, e] of plan.perMember) {
      const m = members.find((x) => x.uid === uid)!;
      const next = new Set(m.groupIds); for (const g of e.add) next.add(g); for (const g of e.rem) next.delete(g);
      batch.update(db.doc(`tenants/${TENANT}/members/${uid}`), { groupIds: [...next] });
      if (++n % 200 === 0) { await batch.commit(); batch = db.batch(); }
    }
    await batch.commit();
    console.log(`\n✓ APLICADO: ${plan.perMember.size} miembros actualizados (${plan.addN} altas, ${plan.remN} bajas).`);
  } else {
    console.log(`\n(dry-run: NO se ha escrito nada. Revisa y añade --apply.)`);
  }
}
main().catch((e) => { console.error('ERROR:', (e as Error).message); process.exit(1); });
