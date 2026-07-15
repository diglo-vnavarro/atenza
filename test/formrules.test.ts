// Tests puros del motor de reglas del formulario. `npm test` (sin emulador).
import { describe, it, expect } from 'vitest';
import { evaluateFormRules, ruleApplies, type FormRule, type FormRuleContext } from '../src/formrules.js';

const base = (over: Partial<FormRule> = {}): FormRule => ({
  id: 'r1', name: 'r', enabled: true, templateIds: [], scope: 'both', match: 'all',
  conditions: [{ fieldId: 'vip', op: 'eq', value: 'true' }], actions: [{ type: 'mandatory', fieldId: 'asset' }], ...over,
});
const ctx = (over: Partial<FormRuleContext> = {}): FormRuleContext => ({ templateId: 'tpl-1', role: 'technician', values: {}, ...over });

describe('ruleApplies', () => {
  it('dispara cuando la condición se cumple', () => {
    expect(ruleApplies(base(), ctx({ values: { vip: 'true' } }))).toBe(true);
  });
  it('no dispara si la condición no se cumple', () => {
    expect(ruleApplies(base(), ctx({ values: { vip: 'false' } }))).toBe(false);
  });
  it('regla deshabilitada nunca aplica', () => {
    expect(ruleApplies(base({ enabled: false }), ctx({ values: { vip: 'true' } }))).toBe(false);
  });
  it('regla sin condiciones no dispara (evita afectar a todo)', () => {
    expect(ruleApplies(base({ conditions: [] }), ctx({ values: { vip: 'true' } }))).toBe(false);
  });
  it('respeta el ámbito de plantilla', () => {
    const r = base({ templateIds: ['tpl-2'] });
    expect(ruleApplies(r, ctx({ templateId: 'tpl-1', values: { vip: 'true' } }))).toBe(false);
    expect(ruleApplies(r, ctx({ templateId: 'tpl-2', values: { vip: 'true' } }))).toBe(true);
  });
  it('respeta el ámbito de vista (solicitante/técnico)', () => {
    const soloReq = base({ scope: 'requester' });
    expect(ruleApplies(soloReq, ctx({ role: 'requester', values: { vip: 'true' } }))).toBe(true);
    expect(ruleApplies(soloReq, ctx({ role: 'technician', values: { vip: 'true' } }))).toBe(false);
    const soloTec = base({ scope: 'technician' });
    expect(ruleApplies(soloTec, ctx({ role: 'requester', values: { vip: 'true' } }))).toBe(false);
  });
  it('match any dispara con una sola condición cumplida', () => {
    const r = base({ match: 'any', conditions: [{ fieldId: 'a', op: 'eq', value: 'x' }, { fieldId: 'b', op: 'eq', value: 'y' }] });
    expect(ruleApplies(r, ctx({ values: { a: 'x', b: 'no' } }))).toBe(true);
    expect(ruleApplies(r, ctx({ values: { a: 'no', b: 'no' } }))).toBe(false);
  });
  it('operadores empty/notempty/contains', () => {
    expect(ruleApplies(base({ conditions: [{ fieldId: 'f', op: 'empty' }] }), ctx({ values: { f: '' } }))).toBe(true);
    expect(ruleApplies(base({ conditions: [{ fieldId: 'f', op: 'notempty' }] }), ctx({ values: { f: 'x' } }))).toBe(true);
    expect(ruleApplies(base({ conditions: [{ fieldId: 'f', op: 'contains', value: 'red' }] }), ctx({ values: { f: 'Incidencia de RED' } }))).toBe(true);
  });
});

describe('evaluateFormRules', () => {
  it('marca obligatorio el campo objetivo', () => {
    const eff = evaluateFormRules([base()], ctx({ values: { vip: 'true' } }));
    expect(eff.asset?.mandatory).toBe(true);
  });
  it('no aplica efecto si la regla no dispara', () => {
    const eff = evaluateFormRules([base()], ctx({ values: { vip: 'false' } }));
    expect(eff.asset).toBeUndefined();
  });
  it('mostrar/ocultar: la regla posterior gana', () => {
    const rules: FormRule[] = [
      base({ id: 'a', actions: [{ type: 'hide', fieldId: 'x' }] }),
      base({ id: 'b', actions: [{ type: 'show', fieldId: 'x' }] }),
    ];
    expect(evaluateFormRules(rules, ctx({ values: { vip: 'true' } })).x?.hidden).toBe(false);
  });
  it('combina efectos de varias reglas sobre distintos campos', () => {
    const rules: FormRule[] = [
      base({ id: 'a', actions: [{ type: 'hide', fieldId: 'x' }] }),
      base({ id: 'b', actions: [{ type: 'disable', fieldId: 'y' }] }),
    ];
    const eff = evaluateFormRules(rules, ctx({ values: { vip: 'true' } }));
    expect(eff.x?.hidden).toBe(true);
    expect(eff.y?.disabled).toBe(true);
  });
});
