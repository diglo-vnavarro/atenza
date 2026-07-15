// Motor de REGLAS DEL FORMULARIO (como SDP): según los valores del formulario,
// muestra/oculta, obliga/libera o habilita/deshabilita campos en vivo. Puro y
// testeable; lo usa «Nueva solicitud» al renderizar y en cada cambio de campo.
//
// A diferencia de las reglas de negocio (que parchean el ticket AL CREAR), estas
// afectan la UI del formulario mientras se rellena. No importables de SDP por API
// (no las expone) → feature propia.

export type FormOp = 'eq' | 'neq' | 'contains' | 'empty' | 'notempty';
export const FORM_OPS: [FormOp, string][] = [
  ['eq', 'es'], ['neq', 'no es'], ['contains', 'contiene'], ['empty', 'está vacío'], ['notempty', 'tiene valor'],
];
export interface FormRuleCondition { fieldId: string; op: FormOp; value?: string }

export type FormActionType = 'show' | 'hide' | 'mandatory' | 'optional' | 'enable' | 'disable';
export const FORM_ACTIONS: [FormActionType, string][] = [
  ['hide', 'Ocultar campo'], ['show', 'Mostrar campo'],
  ['mandatory', 'Hacer obligatorio'], ['optional', 'Hacer opcional'],
  ['disable', 'Deshabilitar'], ['enable', 'Habilitar'],
];
export interface FormRuleAction { type: FormActionType; fieldId: string }

export type FormScope = 'both' | 'technician' | 'requester';

export interface FormRule {
  id: string;
  name: string;
  enabled: boolean;
  /** plantillas a las que aplica; vacío = todas las del tenant. */
  templateIds: string[];
  /** vista donde aplica (como SDP: técnico / solicitante / ambas). */
  scope: FormScope;
  /** todas (all) o alguna (any) de las condiciones. */
  match: 'all' | 'any';
  conditions: FormRuleCondition[];
  actions: FormRuleAction[];
}

/** Efecto resuelto sobre un campo (sobrescribe la base del FieldDef). */
export interface FieldEffect { hidden?: boolean; mandatory?: boolean; disabled?: boolean }
export type FieldEffects = Record<string, FieldEffect>;

export interface FormRuleContext {
  templateId: string;
  /** 'requester' = vista de solicitante; cualquier otro = vista de técnico/admin. */
  role: string;
  /** valores actuales del formulario, indexados por id de FieldDef. */
  values: Record<string, string>;
}

function condMatches(c: FormRuleCondition, values: Record<string, string>): boolean {
  const v = String(values[c.fieldId] ?? '');
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

/** ¿Aplica esta regla en este contexto (plantilla + vista + condiciones)? */
export function ruleApplies(r: FormRule, ctx: FormRuleContext): boolean {
  if (!r.enabled) return false;
  if (r.templateIds.length && !r.templateIds.includes(ctx.templateId)) return false;
  const isReq = ctx.role === 'requester';
  if (r.scope === 'technician' && isReq) return false;
  if (r.scope === 'requester' && !isReq) return false;
  if (!r.conditions.length) return false; // sin condiciones no dispara (evita afectar a todo)
  return r.match === 'any' ? r.conditions.some((c) => condMatches(c, ctx.values)) : r.conditions.every((c) => condMatches(c, ctx.values));
}

/** Evalúa todas las reglas y devuelve el efecto resuelto por campo. Las reglas
 *  posteriores ganan (orden determinista). */
export function evaluateFormRules(rules: FormRule[] | undefined, ctx: FormRuleContext): FieldEffects {
  const eff: FieldEffects = {};
  const get = (id: string) => (eff[id] ??= {});
  for (const r of rules ?? []) {
    if (!ruleApplies(r, ctx)) continue;
    for (const a of r.actions) {
      const e = get(a.fieldId);
      switch (a.type) {
        case 'hide': e.hidden = true; break;
        case 'show': e.hidden = false; break;
        case 'mandatory': e.mandatory = true; break;
        case 'optional': e.mandatory = false; break;
        case 'disable': e.disabled = true; break;
        case 'enable': e.disabled = false; break;
      }
    }
  }
  return eff;
}
