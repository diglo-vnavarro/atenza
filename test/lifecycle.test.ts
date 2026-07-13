// Tests de ciclos de vida y de consumo de SLA por estado.
// El ciclo de ejemplo está inspirado en "RLC - Incidencias v1.0" de Diglo:
// varios estados de pausa (Pendiente Usuario/Banco/terceros), Resuelta que se
// puede reabrir, y estados terminales. Corren sin Java: `npm test`.
import { describe, it, expect } from 'vitest';
import type { Lifecycle, StatusSegment } from '../src/model.js';
import { canTransition, initialState, isTerminal, nextStates, outgoing } from '../src/lifecycle.js';
import { stateConsumesSla, consumedMs, slaStatus } from '../src/sla.js';

const t = (id: string, name: string, from: string, to: string) => ({ id, name, from, to });

const incidentLifecycle: Lifecycle = {
  id: 'lc-inc',
  name: 'RLC - Incidencias',
  version: '1.0',
  published: true,
  type: 'incident',
  states: [
    { key: 'open', label: 'Abierta', stage: 'open', category: 'in_progress', isInitial: true },
    { key: 'working', label: 'Trabajando', stage: 'open', category: 'in_progress' },
    { key: 'pending_user', label: 'Pendiente usuario', stage: 'pending', category: 'stop_timer' },
    { key: 'pending_bank', label: 'Pendiente Banco', stage: 'pending', category: 'stop_timer' },
    { key: 'resolved', label: 'Resuelta', stage: 'resolved', category: 'completed' },
    { key: 'closed', label: 'Cerrada', stage: 'closed', category: 'completed', isTerminal: true },
    { key: 'cancelled', label: 'Cancelada', stage: 'closed', category: 'completed', isTerminal: true },
  ],
  transitions: [
    t('tr1', 'Abierta -TO- Trabajando', 'open', 'working'),
    t('tr2', 'Abierta -TO- P.Usuario', 'open', 'pending_user'),
    t('tr3', 'Trabajando -TO- P.Usuario', 'working', 'pending_user'),
    t('tr4', 'Trabajando -TO- P.Banco', 'working', 'pending_bank'),
    t('tr5', 'P.Usuario -TO- Trabajando', 'pending_user', 'working'),
    t('tr6', 'P.Banco -TO- Trabajando', 'pending_bank', 'working'),
    t('tr7', 'Trabajando -TO- Resuelta', 'working', 'resolved'),
    t('tr8', 'Resuelta -TO- Cerrada', 'resolved', 'closed'),
    t('tr9', 'Resuelta -TO- Trabajando', 'resolved', 'working'), // reapertura
    t('tr10', 'Trabajando -TO- Cancelada', 'working', 'cancelled'),
  ],
};

const MIN = 60000;

describe('ciclo de vida: transiciones con nombre', () => {
  it('el estado inicial es el marcado como tal', () => {
    expect(initialState(incidentLifecycle)!.key).toBe('open');
  });

  it('permite solo transiciones declaradas', () => {
    expect(canTransition(incidentLifecycle, 'open', 'working')).toBe(true);
    expect(canTransition(incidentLifecycle, 'open', 'closed')).toBe(false); // no se cierra sin resolver
    expect(canTransition(incidentLifecycle, 'working', 'resolved')).toBe(true);
  });

  it('las transiciones tienen nombre (para historial y auditoría)', () => {
    const out = outgoing(incidentLifecycle, 'working').map((x) => x.name);
    expect(out).toContain('Trabajando -TO- Resuelta');
    expect(out).toContain('Trabajando -TO- P.Banco');
  });

  it('no se sale de un estado terminal (Cerrada)', () => {
    expect(isTerminal(incidentLifecycle, 'closed')).toBe(true);
    expect(canTransition(incidentLifecycle, 'closed', 'working')).toBe(false);
    expect(nextStates(incidentLifecycle, 'closed')).toEqual([]);
  });

  it('"Resuelta" está completada pero NO es terminal: se puede reabrir', () => {
    expect(isTerminal(incidentLifecycle, 'resolved')).toBe(false);
    expect(canTransition(incidentLifecycle, 'resolved', 'working')).toBe(true);
  });

  it('una plantilla SIN ciclo de vida admite cualquier cambio de estado', () => {
    expect(canTransition(null, 'cualquiera', 'otro')).toBe(true);
    expect(nextStates(null, 'x')).toEqual([]);
  });
});

describe('SLA: categorías de temporizador', () => {
  it('solo "in_progress" consume; "stop_timer" y "completed" no', () => {
    expect(stateConsumesSla(incidentLifecycle, 'open')).toBe(true);
    expect(stateConsumesSla(incidentLifecycle, 'working')).toBe(true);
    expect(stateConsumesSla(incidentLifecycle, 'pending_user')).toBe(false);
    expect(stateConsumesSla(incidentLifecycle, 'pending_bank')).toBe(false);
    expect(stateConsumesSla(incidentLifecycle, 'resolved')).toBe(false);
  });

  it('el tiempo "Pendiente usuario" NO cuenta para el SLA', () => {
    // 60m abierta + 120m pendiente usuario + 30m trabajando => consume 90m (no 210)
    const t0 = 1_000_000_000_000;
    const history: StatusSegment[] = [
      { state: 'open', from: t0, to: t0 + 60 * MIN },
      { state: 'pending_user', from: t0 + 60 * MIN, to: t0 + 180 * MIN },
      { state: 'working', from: t0 + 180 * MIN, to: t0 + 210 * MIN },
    ];
    expect(Math.round(consumedMs(incidentLifecycle, history, t0 + 210 * MIN) / MIN)).toBe(90);
  });

  it('slaStatus mide por tiempo consumido, no de pared', () => {
    const t0 = 1_000_000_000_000;
    // 5h de pared, 3h en pausa (Banco) => 2h consumidas; objetivo 4h => en plazo
    const history: StatusSegment[] = [
      { state: 'working', from: t0, to: t0 + 120 * MIN },
      { state: 'pending_bank', from: t0 + 120 * MIN, to: t0 + 300 * MIN },
    ];
    const s = slaStatus(incidentLifecycle, history, 240, t0 + 300 * MIN);
    expect(s.consumedMins).toBe(120);
    expect(s.breached).toBe(false);
  });
});
