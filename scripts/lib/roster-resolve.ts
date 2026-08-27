// Resolución de ROSTER (hoja «Grupos» del Excel → membresías Atenza), compartida por
// scripts/apply-rosters.ts (aplicación manual) y scripts/sync-tickets.ts (traducción en el
// volcado). Resuelve nombres cortos del Excel → uid de miembro ACTIVO (fuzzy + preferencia por
// cuenta real) y grupos del Excel → id real (gkey + alias), y calcula las altas/bajas por
// miembro para dejar cada grupo con EXACTAMENTE su roster destino.

export interface RGroup { id: string; name: string }
export interface RMember { uid: string; name: string; email?: string; groupIds?: string[] }
export interface RosterRow { targetGroup: string; members: string[] }
export interface RosterPlan {
  perMember: Map<string, { add: Set<string>; rem: Set<string> }>;
  unmatched: { group: string; name: string; note: string }[];
  unresolvedGroups: string[];
  addN: number; remN: number;
  changes: { group: string; add: string[]; rem: string[] }[]; // nombres, para report
}

const norm = (s: string) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
export const gkey = (s: string) => norm(s).replace(/[^a-z0-9]/g, '');
const STOP = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'di', 'da']);
const toks = (s: string) => norm(s).replace(/\([^)]*\)/g, '').split(/[\s-]+/).filter((t) => t && !STOP.has(t));
const lev1 = (a: string, b: string) => { if (a === b) return true; if (Math.abs(a.length - b.length) > 1) return false; let i = 0, j = 0, e = 0; while (i < a.length && j < b.length) { if (a[i] === b[j]) { i++; j++; } else { if (++e > 1) return false; if (a.length > b.length) i++; else if (a.length < b.length) j++; else { i++; j++; } } } return e + (a.length - i) + (b.length - j) <= 1; };
const tokMatch = (e: string, r: string) => e === r || r.startsWith(e) || e.startsWith(r) || lev1(e, r);

export function planRoster(roster: RosterRow[], groups: RGroup[], members: RMember[], groupAlias: Record<string, string> = {}): RosterPlan {
  const active = members; // el llamante ya filtra a activos
  const gByKey = new Map(groups.map((g) => [gkey(g.name), g]));
  const score = (m: RMember) => (m.email ? 2 : 0) + (/\(/.test(m.name) ? -2 : 0) + (m.name === m.name.toUpperCase() && /[A-ZÁÉÍÓÚ]/.test(m.name) ? -1 : 0) + toks(m.name).length * 0.05;
  const resolveMember = (name: string): { uid?: string; note?: string } => {
    const et = toks(name); if (!et.length) return { note: 'vacío' };
    const cands = active.filter((m) => { const rt = toks(m.name); return rt.length ? (rt.some((x) => tokMatch(et[et.length - 1]!, x)) && tokMatch(et[0]!, rt[0]!)) : false; });
    if (cands.length === 0) return { note: 'SIN CASAR' };
    if (cands.length === 1) return { uid: cands[0]!.uid };
    const sorted = [...cands].sort((a, b) => score(b) - score(a));
    return score(sorted[0]!) > score(sorted[1]!) ? { uid: sorted[0]!.uid } : { note: `AMBIGUO → ${cands.map((c) => c.name).join(' | ')}` };
  };

  const target = new Map<string, Set<string>>();
  const unresolvedGroups: string[] = []; const unmatched: RosterPlan['unmatched'] = [];
  for (const row of roster) {
    const g = gByKey.get(gkey(groupAlias[row.targetGroup] ?? row.targetGroup));
    if (!g) { unresolvedGroups.push(row.targetGroup); continue; }
    const set = target.get(g.id) ?? new Set<string>();
    for (const nm of row.members) { const r = resolveMember(nm); if (r.uid) set.add(r.uid); else unmatched.push({ group: g.name, name: nm, note: r.note ?? '?' }); }
    target.set(g.id, set);
  }

  const nmeOf = (uid: string) => active.find((m) => m.uid === uid)?.name ?? uid;
  const perMember = new Map<string, { add: Set<string>; rem: Set<string> }>();
  const changes: RosterPlan['changes'] = []; let addN = 0, remN = 0;
  for (const [gid, set] of target) {
    const gname = groups.find((g) => g.id === gid)!.name;
    const cur = new Set(active.filter((m) => (m.groupIds ?? []).includes(gid)).map((m) => m.uid));
    const add = [...set].filter((u) => !cur.has(u)); const rem = [...cur].filter((u) => !set.has(u));
    if (!add.length && !rem.length) continue;
    changes.push({ group: gname, add: add.map(neOf => nmeOf(neOf)), rem: rem.map((u) => nmeOf(u)) });
    for (const u of add) { const e = perMember.get(u) ?? { add: new Set(), rem: new Set() }; e.add.add(gid); perMember.set(u, e); addN++; }
    for (const u of rem) { const e = perMember.get(u) ?? { add: new Set(), rem: new Set() }; e.rem.add(gid); perMember.set(u, e); remN++; }
  }
  return { perMember, unmatched, unresolvedGroups, addN, remN, changes };
}
