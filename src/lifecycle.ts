// ============================================================================
// Ciclos de vida — máquina de estados configurable por tipología.
//
// Una plantilla puede llevar un ciclo de vida (transiciones forzadas) o no
// llevarlo (estado libre). Las transiciones tienen identidad y nombre, como en
// ServiceDesk Plus ("Abierta -TO- En espera"). Un mismo ciclo se reutiliza en
// varias plantillas.
// ============================================================================

import type { Lifecycle, LifecycleState } from './model.js';

export function stateOf(lc: Lifecycle, key: string): LifecycleState | undefined {
  return lc.states.find((s) => s.key === key);
}

export function initialState(lc: Lifecycle): LifecycleState | undefined {
  return lc.states.find((s) => s.isInitial) ?? lc.states[0];
}

export function isTerminal(lc: Lifecycle, key: string): boolean {
  return !!stateOf(lc, key)?.isTerminal;
}

/**
 * ¿Se permite pasar de `from` a `to`?
 * - Con ciclo de vida: solo si existe una transición declarada from→to.
 * - Sin ciclo de vida (lc == null): estado libre → cualquier cambio vale.
 * Nunca se sale de un estado terminal.
 */
export function canTransition(lc: Lifecycle | null, from: string, to: string): boolean {
  if (!lc) return true;
  if (from === to) return false;
  if (!stateOf(lc, to)) return false;
  if (isTerminal(lc, from)) return false;
  return lc.transitions.some((t) => t.from === from && t.to === to);
}

/** Transiciones salientes desde `from` (para pintar el desplegable de acciones). */
export function outgoing(lc: Lifecycle | null, from: string) {
  if (!lc || isTerminal(lc, from)) return [];
  return lc.transitions.filter((t) => t.from === from);
}

/** Estados destino alcanzables desde `from`. */
export function nextStates(lc: Lifecycle | null, from: string): string[] {
  return outgoing(lc, from).map((t) => t.to);
}
