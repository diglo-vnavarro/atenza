import { describe, it, expect } from 'vitest';
import { pickByLoad, loadRatio, pickBySkillAndLoad } from '../src/assign.js';
import type { Capacity } from '../src/data/seed.js';

const cap: Record<string, Capacity> = {
  elena: { used: 34, cap: 40 },   // 85%
  oscar: { used: 41, cap: 40 },   // 102%
  sergio: { used: 19, cap: 40 },  // 47% (menos cargado)
  bea: { used: 0, cap: 40, off: 'Vacaciones' },
};

describe('loadRatio', () => {
  it('cap 0 o sin datos → Infinity', () => {
    expect(loadRatio(undefined)).toBe(Infinity);
    expect(loadRatio({ used: 5, cap: 0 })).toBe(Infinity);
    expect(loadRatio({ used: 20, cap: 40 })).toBe(0.5);
  });
});

describe('pickByLoad', () => {
  it('elige al menos cargado disponible', () => {
    expect(pickByLoad(['elena', 'oscar', 'sergio', 'bea'], cap)).toBe('sergio');
  });
  it('descarta a quien está de vacaciones (off)', () => {
    expect(pickByLoad(['bea'], cap)).toBeNull();
    expect(pickByLoad(['bea', 'elena'], cap)).toBe('elena');
  });
  it('sin candidatos → null', () => {
    expect(pickByLoad([], cap)).toBeNull();
  });
  it('empata por menor used absoluto', () => {
    const c: Record<string, Capacity> = { x: { used: 10, cap: 20 }, y: { used: 20, cap: 40 } }; // ambos 50%
    expect(pickByLoad(['x', 'y'], c)).toBe('x');
  });
  it('sin datos de capacidad (Infinity) solo si no hay mejor', () => {
    const c: Record<string, Capacity> = { z: { used: 30, cap: 40 } };
    expect(pickByLoad(['nuevo', 'z'], c)).toBe('z'); // z (0.75) mejor que nuevo (Infinity)
  });
});

describe('pickBySkillAndLoad (Fase 8)', () => {
  it('sin señal de afinidad → delega en pickByLoad (menos cargado)', () => {
    expect(pickBySkillAndLoad(['elena', 'oscar', 'sergio'], cap, {})).toBe('sergio');
  });
  it('la afinidad gana pese a más carga (experto saturado pero muy afín)', () => {
    const c: Record<string, Capacity> = { exp: { used: 38, cap: 40 }, rook: { used: 4, cap: 40 } };
    expect(pickBySkillAndLoad(['exp', 'rook'], c, { exp: 0.9, rook: 0 })).toBe('exp');
  });
  it('la carga gana cuando la afinidad es modesta y el experto está saturado', () => {
    const c: Record<string, Capacity> = { exp: { used: 40, cap: 40 }, rook: { used: 4, cap: 40 } };
    expect(pickBySkillAndLoad(['exp', 'rook'], c, { exp: 0.5, rook: 0 })).toBe('rook');
  });
  it('descarta a quien está de vacaciones aunque tenga afinidad', () => {
    const c: Record<string, Capacity> = { exp: { used: 4, cap: 40, off: 'Vacaciones' }, rook: { used: 4, cap: 40 } };
    expect(pickBySkillAndLoad(['exp', 'rook'], c, { exp: 0.9, rook: 0.1 })).toBe('rook');
  });
});
