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

import type { Lifecycle, StatusSegment, SlaCategory } from './model.js';
import { stateOf } from './lifecycle.js';

/** Resuelve el temporizador de un estado por su nombre (catálogo de estados del
 *  tenant). Devuelve undefined si el estado no está en el catálogo. */
export type TimerResolver = (state: string) => SlaCategory | undefined;

/** ¿El tiempo en este estado cuenta para el SLA? Solo la categoría "in_progress".
 *  Prioriza el catálogo de estados (`timerOf`); si no, cae al ciclo de vida. */
export function stateConsumesSla(lc: Lifecycle | null, key: string, timerOf?: TimerResolver): boolean {
  const cat = timerOf?.(key);
  if (cat) return cat === 'in_progress';
  if (!lc) return true; // sin ciclo ni catálogo, todo consume por defecto
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
  timerOf?: TimerResolver,
): number {
  let total = 0;
  for (const seg of history) {
    if (!stateConsumesSla(lc, seg.state, timerOf)) continue;
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
  timerOf?: TimerResolver,
): SlaStatus {
  const consumedMins = Math.round(consumedMs(lc, history, now, timerOf) / 60000);
  const remainingMins = targetMins - consumedMins;
  return { consumedMins, targetMins, remainingMins, breached: remainingMins < 0 };
}
