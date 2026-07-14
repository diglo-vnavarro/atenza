import { describe, it, expect } from 'vitest';
import { ruleMatches, applyBusinessRules, type BusinessRule } from '../src/rules.js';
import type { Ticket } from '../src/model.js';

const base = { subject: 'x', requesterId: 'u1', technicianId: null, templateId: 't', status: 'open' } as Ticket;

const rule = (over: Partial<BusinessRule>): BusinessRule => ({ id: 'r', name: 'r', enabled: true, match: 'all', conditions: [], actions: [], ...over });

describe('ruleMatches', () => {
  it('all: exige todas', () => {
    const r = rule({ conditions: [{ field: 'category', op: 'eq', value: 'Redes' }, { field: 'mode', op: 'eq', value: 'Llamada' }] });
    expect(ruleMatches(r, { ...base, category: 'Redes', mode: 'Llamada' })).toBe(true);
    expect(ruleMatches(r, { ...base, category: 'Redes', mode: 'E-Mail' })).toBe(false);
  });
  it('any: basta una', () => {
    const r = rule({ match: 'any', conditions: [{ field: 'priority', op: 'eq', value: 'Alta' }, { field: 'priority', op: 'eq', value: 'Critica' }] });
    expect(ruleMatches(r, { ...base, priority: 'Critica' })).toBe(true);
    expect(ruleMatches(r, { ...base, priority: 'Baja' })).toBe(false);
  });
  it('contains / empty / notempty', () => {
    expect(ruleMatches(rule({ conditions: [{ field: 'category', op: 'contains', value: 'red' }] }), { ...base, category: 'Redes' })).toBe(true);
    expect(ruleMatches(rule({ conditions: [{ field: 'site', op: 'empty' }] }), base)).toBe(true);
    expect(ruleMatches(rule({ conditions: [{ field: 'site', op: 'notempty' }] }), { ...base, site: 'Madrid' })).toBe(true);
  });
  it('regla SIN condiciones no dispara', () => {
    expect(ruleMatches(rule({ conditions: [] }), base)).toBe(false);
  });
});

describe('applyBusinessRules', () => {
  it('aplica acciones de la regla que casa', () => {
    const rules = [rule({ name: 'Redes', conditions: [{ field: 'category', op: 'contains', value: 'Red' }], actions: [{ type: 'setGroup', value: 'g-red' }, { type: 'setPriority', value: 'Alta' }] })];
    const out = applyBusinessRules(rules, { ...base, category: 'Redes' });
    expect(out.patch.groupId).toBe('g-red');
    expect(out.patch.priority).toBe('Alta');
    expect(out.applied).toEqual(['Redes']);
  });
  it('ignora reglas deshabilitadas y las que no casan', () => {
    const rules = [
      rule({ enabled: false, conditions: [{ field: 'category', op: 'eq', value: 'Redes' }], actions: [{ type: 'setGroup', value: 'g-red' }] }),
      rule({ conditions: [{ field: 'category', op: 'eq', value: 'Correo' }], actions: [{ type: 'setGroup', value: 'g-mail' }] }),
    ];
    const out = applyBusinessRules(rules, { ...base, category: 'Redes' });
    expect(out.patch).toEqual({});
    expect(out.applied).toEqual([]);
  });
  it('encadena: una regla ve lo que dejó la anterior', () => {
    const rules = [
      rule({ id: 'a', name: 'a', conditions: [{ field: 'category', op: 'eq', value: 'Redes' }], actions: [{ type: 'setPriority', value: 'Alta' }] }),
      rule({ id: 'b', name: 'b', conditions: [{ field: 'priority', op: 'eq', value: 'Alta' }], actions: [{ type: 'assignTo', value: 'u-net' }] }),
    ];
    const out = applyBusinessRules(rules, { ...base, category: 'Redes' });
    expect(out.patch.priority).toBe('Alta');
    expect(out.patch.technicianId).toBe('u-net');
    expect(out.applied).toEqual(['a', 'b']);
  });
});
