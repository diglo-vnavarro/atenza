// Motor de REGLAS DE NEGOCIO (como SDP): condición → acción al crear el ticket.
// Puro y testeable; lo usa el store en createTicket. Las reglas se evalúan en
// orden y encadenan (una regla ve lo que dejaron las anteriores).
import type { Ticket } from './model.js';

export const RULE_FIELDS: [string, string][] = [
  ['category', 'Categoría'], ['subcategory', 'Subcategoría'], ['item', 'Artículo'],
  ['priority', 'Prioridad'], ['impact', 'Impacto'], ['urgency', 'Urgencia'],
  ['mode', 'Modo'], ['site', 'Sede'], ['type', 'Tipo'], ['subject', 'Asunto'],
];
export type RuleField = string;
export type RuleOp = 'eq' | 'neq' | 'contains' | 'empty' | 'notempty';
export const RULE_OPS: [RuleOp, string][] = [
  ['eq', 'es'], ['neq', 'no es'], ['contains', 'contiene'], ['empty', 'está vacío'], ['notempty', 'tiene valor'],
];
export interface RuleCondition { field: RuleField; op: RuleOp; value?: string }

export type RuleActionType = 'setPriority' | 'setGroup' | 'setStatus' | 'assignTo' | 'assignByLoad';
export const RULE_ACTIONS: [RuleActionType, string][] = [
  ['setPriority', 'Fijar prioridad'], ['setGroup', 'Enrutar a grupo'],
  ['setStatus', 'Fijar estado'], ['assignTo', 'Asignar técnico'],
  ['assignByLoad', 'Auto-asignar por carga'],
];
export interface RuleAction { type: RuleActionType; value: string }

export interface BusinessRule {
  id: string;
  name: string;
  enabled: boolean;
  /** todas (all) o alguna (any) de las condiciones. */
  match: 'all' | 'any';
  conditions: RuleCondition[];
  actions: RuleAction[];
}

const fieldVal = (t: Ticket, f: RuleField): string => String((t as unknown as Record<string, unknown>)[f] ?? '');

function condMatches(c: RuleCondition, t: Ticket): boolean {
  const v = fieldVal(t, c.field);
  const cv = c.value ?? '';
  switch (c.op) {
    case 'eq': return v === cv;
    case 'neq': return v !== cv;
    case 'contains': return v.toLowerCase().includes(cv.toLowerCase());
    case 'empty': return !v;
    case 'notempty': return !!v;
    default: return false;
  }
}

/** ¿Casa la regla? Una regla SIN condiciones no dispara (evita aplicar a todo por error). */
export function ruleMatches(r: BusinessRule, t: Ticket): boolean {
  if (!r.conditions.length) return false;
  return r.match === 'any' ? r.conditions.some((c) => condMatches(c, t)) : r.conditions.every((c) => condMatches(c, t));
}

export interface RuleOutcome {
  patch: Partial<Ticket>;
  applied: string[];
  /** solicitud de auto-asignación por carga (la resuelve el store, que tiene la
   *  capacidad y los miembros). groupId '' / undefined = usar el grupo del ticket. */
  autoAssign?: { groupId?: string };
}

/** Aplica en orden las reglas habilitadas que casan; devuelve el patch de campos. */
export function applyBusinessRules(rules: BusinessRule[] | undefined, t: Ticket): RuleOutcome {
  const patch: Record<string, unknown> = {};
  const applied: string[] = [];
  let autoAssign: { groupId?: string } | undefined;
  for (const r of rules ?? []) {
    if (!r.enabled) continue;
    if (!ruleMatches(r, { ...t, ...patch } as Ticket)) continue; // encadena sobre lo ya parcheado
    for (const a of r.actions) {
      if (a.type === 'setPriority') patch.priority = a.value;
      else if (a.type === 'setGroup') patch.groupId = a.value;
      else if (a.type === 'setStatus') patch.status = a.value;
      else if (a.type === 'assignTo') patch.technicianId = a.value;
      else if (a.type === 'assignByLoad') autoAssign = { groupId: a.value || undefined };
    }
    applied.push(r.name);
  }
  return { patch: patch as Partial<Ticket>, applied, autoAssign };
}
