// Enrutado VIVO a grupo (Fase 7), PURO y testeable. Sobre el suelo fijo (grupo declarado
// en el árbol) puntúa cada grupo con la AFINIDAD histórica (quién resolvió de verdad,
// pesando lo reciente) menos las reasignaciones salientes. Explicable (`why`).
// Inerte hasta que el tenant activa `liveRouting` y ticketIN crea/asigna (post-corte).
import type { RoutingStats, GroupStat } from './model.js';

export interface GroupScore { groupId: string; score: number; affinity: number; isPrior: boolean }
export interface RoutingChoice { groupId: string | undefined; why: string; scores: GroupScore[] }

// Pesos (configurables a futuro). El prior es un suelo pequeño: gana en frío/empate,
// pero la afinidad histórica lo supera cuando hay señal clara.
export const W_PRIOR = 0.15, W_RECENT = 0.7, W_ALL = 0.3, W_REASSIGN = 0.5;

const sum = (stats: Record<string, GroupStat>, f: (s: GroupStat) => number): number =>
  Object.values(stats).reduce((a, s) => a + f(s), 0);

/** Puntúa los grupos candidatos (los del histórico + el prior). Orden desc por score. */
export function scoreGroups(nodeStats: Record<string, GroupStat> | undefined, priorGroup: string | undefined): GroupScore[] {
  const stats = nodeStats ?? {};
  const totRecent = sum(stats, (s) => s.recent ?? 0);
  const totAll = sum(stats, (s) => s.resolved ?? 0);
  const totReass = sum(stats, (s) => s.reassignedOut ?? 0);
  const ids = new Set<string>([...Object.keys(stats), ...(priorGroup ? [priorGroup] : [])]);
  const out: GroupScore[] = [];
  for (const g of ids) {
    const s = stats[g];
    const shareRecent = totRecent ? (s?.recent ?? 0) / totRecent : 0;
    const shareAll = totAll ? (s?.resolved ?? 0) / totAll : 0;
    const affinity = W_RECENT * shareRecent + W_ALL * shareAll;
    const reassignShare = totReass ? (s?.reassignedOut ?? 0) / totReass : 0;
    const isPrior = g === priorGroup;
    const score = affinity + (isPrior ? W_PRIOR : 0) - W_REASSIGN * reassignShare;
    out.push({ groupId: g, score, affinity, isPrior });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** Elige el grupo para un ticket clasificado (servicio/elemento) dado el prior (suelo).
 *  Usa el elemento si tiene histórico propio; si no, el servicio. Devuelve el `why`. */
export function pickGroupLive(stats: RoutingStats | undefined, serviceId: string | undefined, elementId: string | undefined, priorGroup: string | undefined): RoutingChoice {
  const elNode = elementId ? stats?.byElement?.[elementId] : undefined;
  const node = (elNode && Object.keys(elNode).length) ? elNode : (serviceId ? stats?.byService?.[serviceId] : undefined);
  const scores = scoreGroups(node, priorGroup);
  const top = scores[0];
  if (!top) return { groupId: priorGroup, why: priorGroup ? 'grupo por defecto (sin histórico)' : 'sin grupo', scores };
  const totRecent = node ? sum(node, (s) => s.recent ?? 0) : 0;
  const totAll = node ? sum(node, (s) => s.resolved ?? 0) : 0;
  const base = totRecent || totAll;
  if (top.isPrior && top.affinity === 0) return { groupId: top.groupId, why: 'grupo por defecto (sin histórico)', scores };
  const n = node?.[top.groupId];
  const cnt = totRecent ? (n?.recent ?? 0) : (n?.resolved ?? 0);
  const pct = base ? Math.round((cnt / base) * 100) : 0;
  return { groupId: top.groupId, why: `${pct}% de ${base} tickets ${totRecent ? 'recientes' : 'históricos'} de este servicio se resolvieron aquí`, scores };
}
