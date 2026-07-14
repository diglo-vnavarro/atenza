import { describe, it, expect } from 'vitest';
import { pickByLoad, loadRatio } from '../src/assign.js';
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
