// Sprint 2 (G4) — aplica las MEMBRESÍAS por grupo según la hoja «Grupos» del Excel
// (importer/roster-v2.json). Deja cada grupo con EXACTAMENTE su roster destino: resuelve
// los nombres cortos del Excel → uid de miembro (activo), y ajusta member.groupIds.
// Reversible por naturaleza (volver a añadir/quitar). Solo miembros ACTIVOS (tras el dedup).
//
//   dry-run (por defecto): NO escribe; muestra por grupo +altas/-bajas y los nombres SIN casar.
//   --apply: escribe member.groupIds.
//   GOOGLE_CLOUD_PROJECT=diglo-desk-pd TENANT=diglo-it npx tsx scripts/apply-rosters.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const APPLY = process.argv.includes('--apply');
const PROJECT = process.env.GOOGLE_CLOUD_PROJECT ?? 'diglo-desk-pd';
const TENANT = process.env.TENANT ?? 'diglo-it';
const here = dirname(fileURLToPath(import.meta.url));
const roster = JSON.parse(readFileSync(join(here, '..', 'importer', 'roster-v2.json'), 'utf8')) as { excelGroup: string; targetGroup: string; members: string[] }[];

// Alias de GRUPO: nombre del Excel → grupo real existente (fusión de IT).
const GROUP_ALIAS: Record<string, string> = { 'Técnicos IT': 'IT' };
// Alias de MIEMBRO para casos que el fuzzy no resuelve bien (nombre Excel → uid real). Se
// rellena tras ver el dry-run. Ej.: 'Vicente Navarra': 'QzdANMSSOuTQJWF9h18gaV0TRwo2'.
const MEMBER_ALIAS: Record<string, string> = {};

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const gkey = (s: string) => norm(s).replace(/[^a-z0-9]/g, '');
const STOP = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'di', 'da']);
const toks = (s: string) => norm(s).replace(/\([^)]*\)/g, '').split(/[\s-]+/).filter((t) => t && !STOP.has(t));
const lev1 = (a: string, b: string) => { if (a === b) return true; if (Math.abs(a.length - b.length) > 1) return false; let i = 0, j = 0, e = 0; while (i < a.length && j < b.length) { if (a[i] === b[j]) { i++; j++; } else { if (++e > 1) return false; if (a.length > b.length) i++; else if (a.length < b.length) j++; else { i++; j++; } } } return e + (a.length - i) + (b.length - j) <= 1; };
const tokMatch = (e: string, r: string) => e === r || r.startsWith(e) || e.startsWith(r) || lev1(e, r);

initializeApp({ projectId: PROJECT });
const db = getFirestore();

async function main(): Promise<void> {
  const gsnap = await db.collection(`tenants/${TENANT}/groups`).get();
  const groups = gsnap.docs.map((d) => ({ id: d.id, name: String(d.data().name ?? '') }));
  const gByKey = new Map(groups.map((g) => [gkey(g.name), g]));
  const msnap = await db.collection(`tenants/${TENANT}/members`).get();
  const members = msnap.docs.map((d) => ({ uid: d.id, name: String(d.data().name ?? ''), email: String(d.data().email ?? ''), status: d.data().status as string, groupIds: (d.data().groupIds ?? []) as string[] }))
    .filter((m) => m.status === 'active');
  // Cuenta «real» preferida ante homónimos: con email > nombre completo > no MAYÚSCULAS > sin (paréntesis).
  const score = (m: { name: string; email: string }) => (m.email ? 2 : 0) + (/\(/.test(m.name) ? -2 : 0) + (m.name === m.name.toUpperCase() && /[A-ZÁÉÍÓÚ]/.test(m.name) ? -1 : 0) + toks(m.name).length * 0.05;

  // Resolver nombre Excel → miembro. Devuelve {uid} o {ambiguous|none}.
  const resolveMember = (name: string): { uid?: string; note?: string } => {
    if (MEMBER_ALIAS[name]) return { uid: MEMBER_ALIAS[name] };
    const et = toks(name); if (!et.length) return { note: 'vacío' };
    let cands = members.filter((m) => {
      const rt = toks(m.name); if (!rt.length) return false;
      return rt.some((x) => tokMatch(et[et.length - 1]!, x)) && tokMatch(et[0]!, rt[0]!); // apellido casa + nombre casa
    });
    if (cands.length === 0) return { note: 'SIN CASAR' };
    if (cands.length === 1) return { uid: cands[0]!.uid };
    const sorted = [...cands].sort((a, b) => score(b) - score(a));
    if (score(sorted[0]!) > score(sorted[1]!)) return { uid: sorted[0]!.uid }; // ganador claro
    return { note: `AMBIGUO → ${cands.map((c) => c.name).join(' | ')}` };
  };

  // Objetivo por grupo real (union si varias filas del Excel mapean al mismo grupo).
  const target = new Map<string, Set<string>>(); // gid → uids
  const unresolvedGroups: string[] = []; const unmatched: { group: string; name: string; note: string }[] = [];
  for (const row of roster) {
    const gname = GROUP_ALIAS[row.targetGroup] ?? row.targetGroup;
    const g = gByKey.get(gkey(gname));
    if (!g) { unresolvedGroups.push(row.targetGroup); continue; }
    const set = target.get(g.id) ?? new Set<string>();
    for (const nm of row.members) { const r = resolveMember(nm); if (r.uid) set.add(r.uid); else unmatched.push({ group: g.name, name: nm, note: r.note ?? '?' }); }
    target.set(g.id, set);
  }

  // Diff vs actual + plan de escritura.
  const nmeOf = (uid: string) => members.find((m) => m.uid === uid)?.name ?? uid;
  let addN = 0, remN = 0; const perMember = new Map<string, { add: Set<string>; rem: Set<string> }>();
  console.log(`=== ROSTERS (${target.size} grupos resueltos) ===`);
  for (const [gid, set] of target) {
    const gname = groups.find((g) => g.id === gid)!.name;
    const cur = new Set(members.filter((m) => m.groupIds.includes(gid)).map((m) => m.uid));
    const add = [...set].filter((u) => !cur.has(u)); const rem = [...cur].filter((u) => !set.has(u));
    if (!add.length && !rem.length) continue;
    console.log(`\n■ ${gname}`);
    if (add.length) console.log(`   + ${add.map(nmeOf).join(', ')}`);
    if (rem.length) console.log(`   - ${rem.map(nmeOf).join(', ')}`);
    for (const u of add) { const e = perMember.get(u) ?? { add: new Set(), rem: new Set() }; e.add.add(gid); perMember.set(u, e); addN++; }
    for (const u of rem) { const e = perMember.get(u) ?? { add: new Set(), rem: new Set() }; e.rem.add(gid); perMember.set(u, e); remN++; }
  }

  if (process.argv.includes('--show-map')) {
    const distinct = [...new Set(roster.flatMap((r) => r.members))].sort((a, b) => a.localeCompare(b));
    console.log(`\n=== RESOLUCIÓN DE NOMBRES (${distinct.length}) ===`);
    for (const nm of distinct) { const r = resolveMember(nm); console.log(`   «${nm}» → ${r.uid ? nmeOf(r.uid) : r.note}`); }
  }
  if (unresolvedGroups.length) console.log(`\n⚠ grupos del Excel sin equivalente real (${unresolvedGroups.length}): ${unresolvedGroups.join(' · ')}`);
  if (unmatched.length) { console.log(`\n⚠ NOMBRES SIN RESOLVER (${unmatched.length}) — corrige con MEMBER_ALIAS antes de --apply:`); for (const u of unmatched) console.log(`   [${u.group}] «${u.name}» → ${u.note}`); }
  console.log(`\nResumen: ${addN} altas · ${remN} bajas · ${perMember.size} miembros afectados · ${unmatched.length} sin resolver.`);

  if (APPLY) {
    if (unmatched.length) { console.log('\n✋ Hay nombres sin resolver. Arréglalos (MEMBER_ALIAS) antes de aplicar. NO se ha escrito nada.'); return; }
    let batch = db.batch(), n = 0;
    for (const [uid, e] of perMember) {
      const m = members.find((x) => x.uid === uid)!;
      const next = new Set(m.groupIds); for (const g of e.add) next.add(g); for (const g of e.rem) next.delete(g);
      batch.update(db.doc(`tenants/${TENANT}/members/${uid}`), { groupIds: [...next] });
      if (++n % 200 === 0) { await batch.commit(); batch = db.batch(); }
    }
    await batch.commit();
    console.log(`\n✓ APLICADO: ${perMember.size} miembros actualizados (${addN} altas, ${remN} bajas).`);
  } else {
    console.log(`\n(dry-run: NO se ha escrito nada. Revisa y añade --apply.)`);
  }
}
main().catch((e) => { console.error('ERROR:', (e as Error).message); process.exit(1); });
