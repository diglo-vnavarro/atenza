import { describe, it, expect } from 'vitest';
import { runReport, periodBounds, reportToCsv, DEFAULT_REPORTS, type ReportDef } from '../src/reports.js';
import type { Ticket } from '../src/model.js';

const T0 = Date.UTC(2026, 7, 24, 12); // ref dentro del periodo
const tk = (o: Partial<Ticket>): Ticket => ({ type: 'incident', subject: 'x', requesterId: 'r', technicianId: null, status: 'Abierta', templateId: 'unified', ...o } as Ticket);
const DAY = 86400000;

describe('reports · runReport', () => {
  it('agrega por dimensión y respeta el periodo [from,to)', () => {
    const tickets = [
      tk({ groupId: 'g1', createdAt: T0 + 1 }),
      tk({ groupId: 'g1', createdAt: T0 + 2 }),
      tk({ groupId: 'g2', createdAt: T0 + 3 }),
      tk({ groupId: 'g1', createdAt: T0 - 10 * DAY }), // fuera del periodo
    ];
    const r = runReport({ id: 'x', name: 'x', dimension: 'group' }, tickets, T0, T0 + DAY);
    expect(r.total).toBe(3);
    expect(r.rows[0]).toMatchObject({ key: 'g1', count: 2, pct: 66.7 });
    expect(r.rows[1]).toMatchObject({ key: 'g2', count: 1 });
  });

  it('aplica los filtros antes de agregar', () => {
    const tickets = [
      tk({ area: 'a1', priority: 'Alta', createdAt: T0 }),
      tk({ area: 'a2', priority: 'Alta', createdAt: T0 }),
      tk({ area: 'a1', priority: 'Media', createdAt: T0 }),
    ];
    const def: ReportDef = { id: 'x', name: 'x', dimension: 'priority', filters: [{ field: 'area', value: 'a1' }] };
    const r = runReport(def, tickets, T0 - 1, T0 + 1);
    expect(r.total).toBe(2);
    expect(r.rows.find((x) => x.key === 'Alta')?.count).toBe(1);
    expect(r.rows.find((x) => x.key === 'Media')?.count).toBe(1);
  });

  it('técnico sin asignar y campos ausentes caen en su bucket', () => {
    const r = runReport({ id: 'x', name: 'x', dimension: 'technician' }, [tk({ createdAt: T0 }), tk({ technicianId: 'u1', createdAt: T0 })], T0 - 1, T0 + 1);
    expect(r.rows.find((x) => x.key === '(sin asignar)')?.count).toBe(1);
  });
});

describe('reports · periodBounds', () => {
  it('semana = 7 días y contiene ref, empezando en lunes', () => {
    const ref = Date.UTC(2026, 7, 26, 15); // miércoles
    const { from, to } = periodBounds(ref, 'week');
    expect(to - from).toBe(7 * DAY);
    expect(from).toBeLessThanOrEqual(ref);
    expect(ref).toBeLessThan(to);
    expect(new Date(from).getDay()).toBe(1); // lunes (hora local 00:00)
  });
  it('mes contiene ref', () => {
    const ref = Date.UTC(2026, 7, 15);
    const { from, to } = periodBounds(ref, 'month');
    expect(from).toBeLessThanOrEqual(ref);
    expect(ref).toBeLessThan(to);
  });
});

describe('reports · csv y presets', () => {
  it('reportToCsv incluye cabecera, filas y total', () => {
    const r = runReport({ id: 'x', name: 'x', dimension: 'status' }, [tk({ status: 'Abierta', createdAt: T0 })], T0 - 1, T0 + 1);
    const csv = reportToCsv(r);
    expect(csv.split('\n')[0]).toBe('status;tickets;%');
    expect(csv).toContain('Abierta;1;100');
    expect(csv.trim().endsWith('TOTAL;1;100')).toBe(true);
  });
  it('trae presets por defecto', () => {
    expect(DEFAULT_REPORTS.length).toBeGreaterThanOrEqual(5);
    expect(DEFAULT_REPORTS.map((d) => d.dimension)).toContain('group');
  });
});
