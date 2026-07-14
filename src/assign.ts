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
