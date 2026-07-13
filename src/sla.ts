// ============================================================================
// Motor de SLA — cálculo del tiempo que REALMENTE consume el SLA.
//
// Punto clave (levantado por el usuario): no todos los estados del ciclo de
// vida consumen SLA. Un estado con `stopsSlaClock` (p. ej. "En espera del
// usuario") PAUSA el reloj: el tiempo ahí no cuenta.
//
// Nota: este cálculo usa tiempo transcurrido "de reloj" en los estados que
// consumen. La ponderación por HORARIO LABORAL (contar solo horas de oficina)
// es el siguiente refinamiento y encaja aquí mismo (parámetro businessHours).
// ============================================================================

import type { Lifecycle, StatusSegment } from './model.js';
import { stateOf } from './lifecycle.js';

/** ¿El tiempo en este estado cuenta para el SLA? Solo la categoría "in_progress". */
export function stateConsumesSla(lc: Lifecycle | null, key: string): boolean {
  if (!lc) return true; // sin ciclo de vida, todo consume por defecto
  const s = stateOf(lc, key);
  return !!s && s.category === 'in_progress';
}

/**
 * Milisegundos que han consumido SLA, sumando solo los tramos en estados que
 * consumen. Los tramos abiertos (`to === null`) se cierran con `now`.
 */
export function consumedMs(
  lc: Lifecycle | null,
  history: StatusSegment[],
  now: number,
): number {
  let total = 0;
  for (const seg of history) {
    if (!stateConsumesSla(lc, seg.state)) continue;
    const end = seg.to ?? now;
    if (end > seg.from) total += end - seg.from;
  }
  return total;
}

export interface SlaStatus {
  consumedMins: number;
  targetMins: number;
  remainingMins: number; // negativo = incumplido
  breached: boolean;
}

/** Estado del SLA de resolución dado el objetivo en minutos. */
export function slaStatus(
  lc: Lifecycle | null,
  history: StatusSegment[],
  targetMins: number,
  now: number,
): SlaStatus {
  const consumedMins = Math.round(consumedMs(lc, history, now) / 60000);
  const remainingMins = targetMins - consumedMins;
  return { consumedMins, targetMins, remainingMins, breached: remainingMins < 0 };
}
