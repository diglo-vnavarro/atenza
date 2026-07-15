// Reglas de cierre (como SDP): condiciones que un ticket debe cumplir antes de
// pasar a un estado "completado" (Resuelta/Cerrada). Puro y testeable; lo usan la
// UI (para avisar/bloquear) y el store (como salvaguarda).
import type { StatusDef, Ticket } from './model.js';

export interface ClosureRules {
  requireResolution?: boolean;
  requireCategory?: boolean;
  requireComment?: boolean;
  requireWorklog?: boolean;
}

export const DEFAULT_CLOSURE_RULES: ClosureRules = { requireResolution: true };

export const CLOSURE_RULE_LABELS: [keyof ClosureRules, string][] = [
  ['requireResolution', 'Exigir texto de resolución'],
  ['requireCategory', 'Exigir categoría'],
  ['requireComment', 'Exigir al menos un comentario'],
  ['requireWorklog', 'Exigir tiempo registrado'],
];

/** ¿Este estado dispara las reglas de cierre? = temporizador "completado" y NO
 *  "Cancelada" (cancelar no debe exigir resolución). */
export function isClosingStatus(statuses: StatusDef[] | undefined, name: string): boolean {
  const st = (statuses ?? []).find((s) => s.name === name);
  return !!st && st.timer === 'completed' && name !== 'Cancelada';
}

/** Lista de requisitos SIN cumplir (vacía = se puede cerrar). `opts` añade la
 *  puerta de la lista de comprobación de la plantilla (si la exige). */
export function closureBlockers(
  rules: ClosureRules | undefined,
  t: Pick<Ticket, 'resolution' | 'category' | 'comments' | 'worklog'>,
  opts?: { checklistGate?: boolean; checklist?: { done: boolean }[] },
): string[] {
  const r = rules ?? {};
  const miss: string[] = [];
  if (r.requireResolution && !t.resolution?.trim()) miss.push('texto de resolución');
  if (r.requireCategory && !t.category) miss.push('categoría');
  if (r.requireComment && !(t.comments ?? []).some((c) => !c.internal)) miss.push('un comentario');
  if (r.requireWorklog && !(t.worklog ?? []).length) miss.push('tiempo registrado');
  if (opts?.checklistGate && (opts.checklist ?? []).some((i) => !i.done)) miss.push('lista de comprobación completa');
  return miss;
}
