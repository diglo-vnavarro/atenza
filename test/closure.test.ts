import { describe, it, expect } from 'vitest';
import { closureBlockers, isClosingStatus, DEFAULT_CLOSURE_RULES } from '../src/closure.js';
import type { StatusDef } from '../src/model.js';

const STATUSES: StatusDef[] = [
  { name: 'Abierta', timer: 'in_progress', color: '#0f0' },
  { name: 'Resuelta', timer: 'completed', color: '#00f' },
  { name: 'Cerrada', timer: 'completed', color: '#0aa' },
  { name: 'Cancelada', timer: 'completed', color: '#f00' },
];

describe('isClosingStatus', () => {
  it('completado dispara reglas de cierre', () => {
    expect(isClosingStatus(STATUSES, 'Resuelta')).toBe(true);
    expect(isClosingStatus(STATUSES, 'Cerrada')).toBe(true);
  });
  it('Cancelada NO dispara reglas de cierre', () => {
    expect(isClosingStatus(STATUSES, 'Cancelada')).toBe(false);
  });
  it('estado en curso no dispara', () => {
    expect(isClosingStatus(STATUSES, 'Abierta')).toBe(false);
  });
});

describe('closureBlockers', () => {
  it('por defecto exige resolución', () => {
    expect(closureBlockers(DEFAULT_CLOSURE_RULES, {})).toEqual(['texto de resolución']);
    expect(closureBlockers(DEFAULT_CLOSURE_RULES, { resolution: 'arreglado' })).toEqual([]);
  });
  it('acumula todos los requisitos incumplidos', () => {
    const rules = { requireResolution: true, requireCategory: true, requireComment: true, requireWorklog: true };
    const miss = closureBlockers(rules, {});
    expect(miss).toContain('texto de resolución');
    expect(miss).toContain('categoría');
    expect(miss).toContain('un comentario');
    expect(miss).toContain('tiempo registrado');
    expect(miss.length).toBe(4);
  });
  it('una nota interna no cuenta como comentario', () => {
    const rules = { requireComment: true };
    expect(closureBlockers(rules, { comments: [{ author: 'x', authorName: 'X', at: 1, text: 'hola', internal: true }] })).toEqual(['un comentario']);
    expect(closureBlockers(rules, { comments: [{ author: 'x', authorName: 'X', at: 1, text: 'hola' }] })).toEqual([]);
  });
  it('sin reglas, nada bloquea', () => {
    expect(closureBlockers(undefined, {})).toEqual([]);
  });
});
