import { describe, it, expect } from 'vitest';
import { scoreGroups, pickGroupLive } from '../src/routing-live.js';
import type { RoutingStats } from '../src/model.js';

// Datos alineados con la realidad medida (Anexo A.4).
const stats: RoutingStats = {
  byService: {
    'sv-gemini': { 'Tecnicos Gemini': { resolved: 26, recent: 24 }, CAU: { resolved: 2, recent: 1 } },
    'sv-waiver': { CAU: { resolved: 4, recent: 4 } }, // realidad CAU aunque el prior sea otro
    'sv-inc': {}, // sin histórico → cold start
  },
};

describe('pickGroupLive', () => {
  it('la afinidad histórica gana al prior: Gemini → Tecnicos Gemini', () => {
    const r = pickGroupLive(stats, 'sv-gemini', undefined, 'CAU'); // prior=CAU, realidad=Gemini
    expect(r.groupId).toBe('Tecnicos Gemini');
    expect(r.why).toMatch(/%/);
  });
  it('corrige un prior equivocado: Waiver → CAU (prior REO)', () => {
    expect(pickGroupLive(stats, 'sv-waiver', undefined, 'Tecnicos REO').groupId).toBe('CAU');
  });
  it('cold start (sin histórico) → cae al prior (suelo)', () => {
    const r = pickGroupLive(stats, 'sv-inc', undefined, 'CAU');
    expect(r.groupId).toBe('CAU');
    expect(r.why).toMatch(/por defecto/);
  });
  it('sin stats ni prior → undefined', () => {
    expect(pickGroupLive(undefined, 'x', undefined, undefined).groupId).toBeUndefined();
  });
  it('el elemento con histórico propio prevalece sobre el servicio', () => {
    const s: RoutingStats = {
      byService: { 'sv-inc': { CAU: { resolved: 10, recent: 10 } } },
      byElement: { 'el-sap': { 'Tecnicos Apps': { resolved: 8, recent: 8 } } },
    };
    expect(pickGroupLive(s, 'sv-inc', 'el-sap', 'CAU').groupId).toBe('Tecnicos Apps');
  });
});

describe('scoreGroups', () => {
  it('ordena por score e incluye el prior aunque no tenga histórico', () => {
    const sc = scoreGroups({ A: { resolved: 10, recent: 10 } }, 'B');
    expect(sc[0]!.groupId).toBe('A');
    expect(sc.some((x) => x.groupId === 'B' && x.isPrior)).toBe(true);
  });
  it('penaliza las reasignaciones salientes', () => {
    const sc = scoreGroups({ A: { resolved: 10, recent: 10, reassignedOut: 10 }, B: { resolved: 8, recent: 8 } }, undefined);
    const a = sc.find((x) => x.groupId === 'A')!, b = sc.find((x) => x.groupId === 'B')!;
    expect(b.score).toBeGreaterThan(a.score);
  });
});
