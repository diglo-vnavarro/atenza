// Asignación automática por CARGA real (el diferenciador: usa la capacidad de
// OrganiZate). Puro y testeable. Elige, entre los candidatos disponibles, el de
// menor ocupación (used/cap); descarta a quien está de baja/vacaciones (`off`).
import type { Capacity } from './data/seed.js';

/** Ocupación 0..∞ (cap 0 o sin datos → ∞ para no elegirlo). */
export function loadRatio(c: Capacity | undefined): number {
  if (!c || !c.cap) return Infinity;
  return c.used / c.cap;
}

/**
 * Devuelve el uid del técnico MENOS cargado y disponible, o null si ninguno.
 * Empata por menor `used` absoluto y, si persiste, por orden de entrada.
 */
export function pickByLoad(uids: string[], capacity: Record<string, Capacity>): string | null {
  let best: string | null = null;
  let bestRatio = Infinity;
  let bestUsed = Infinity;
  for (const uid of uids) {
    const c = capacity[uid];
    if (c?.off) continue; // de vacaciones / no disponible
    const r = loadRatio(c);
    const used = c?.used ?? 0;
    if (r < bestRatio || (r === bestRatio && used < bestUsed)) {
      best = uid; bestRatio = r; bestUsed = used;
    }
  }
  return best;
}

// Reparto VIVO a técnico (Fase 8): combina AFINIDAD (quién resolvió similares) con la
// CARGA de OrganiZate. Superset de pickByLoad: sin señal de afinidad, se comporta igual.
export const W_SKILL = 0.6, W_LOAD = 0.4;

/**
 * Elige el técnico con mejor mezcla afinidad×disponibilidad. `affinity[uid]` ∈ [0,1] =
 * cuota histórica del técnico en ese servicio (0 si no consta). Descarta `off`. Si ningún
 * candidato tiene afinidad, delega en pickByLoad (comportamiento actual, sin regresión).
 */
export function pickBySkillAndLoad(
  uids: string[], capacity: Record<string, Capacity>, affinity: Record<string, number>,
  w: { skill: number; load: number } = { skill: W_SKILL, load: W_LOAD },
): string | null {
  if (!uids.some((u) => (affinity[u] ?? 0) > 0)) return pickByLoad(uids, capacity);
  let best: string | null = null, bestScore = -Infinity, bestUsed = Infinity;
  for (const uid of uids) {
    const c = capacity[uid];
    if (c?.off) continue; // vacaciones / no disponible
    const r = loadRatio(c);
    const loadTerm = r === Infinity ? 0 : 1 - Math.min(1, r); // sin datos de carga → neutro
    const score = w.skill * (affinity[uid] ?? 0) + w.load * loadTerm;
    const used = c?.used ?? 0;
    if (score > bestScore || (score === bestScore && used < bestUsed)) { best = uid; bestScore = score; bestUsed = used; }
  }
  return best;
}
