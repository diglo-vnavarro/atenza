import { describe, it, expect } from 'vitest';
import { reconcileOwner } from '../src/owner.js';

describe('reconcileOwner', () => {
  it('siembra el primer segmento (desde `from`)', () => {
    expect(reconcileOwner(undefined, { group: 'g1', tech: 't1' }, 100, 50))
      .toEqual([{ group: 'g1', tech: 't1', from: 50, to: null }]);
  });

  it('sin cambio de dueño → mismo histórico (misma referencia)', () => {
    const h0 = [{ group: 'g1', tech: 't1', from: 50, to: null }];
    expect(reconcileOwner(h0, { group: 'g1', tech: 't1' }, 200, 50)).toBe(h0);
  });

  it('cambio de técnico → cierra el abierto y abre uno nuevo', () => {
    const h0 = [{ group: 'g1', tech: 't1', from: 50, to: null }];
    expect(reconcileOwner(h0, { group: 'g1', tech: 't2' }, 200, 50)).toEqual([
      { group: 'g1', tech: 't1', from: 50, to: 200 },
      { group: 'g1', tech: 't2', from: 200, to: null },
    ]);
  });

  it('cambio de grupo (reasignación SDP) → nuevo segmento', () => {
    const h0 = [{ group: 'g-cau', tech: null, from: 10, to: null }];
    const h = reconcileOwner(h0, { group: 'g-gemini', tech: null }, 300, 10);
    expect(h.length).toBe(2);
    expect(h[0]!.to).toBe(300);
    expect(h[1]).toEqual({ group: 'g-gemini', tech: null, from: 300, to: null });
  });

  it('normaliza undefined a null', () => {
    expect(reconcileOwner(undefined, {}, 100, 100)).toEqual([{ group: null, tech: null, from: 100, to: null }]);
  });
});
