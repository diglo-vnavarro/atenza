import { describe, it, expect } from 'vitest';
import { runReport, periodBounds, reportToCsv, DEFAULT_REPORTS, DEFAULT_TABLE_REPORTS, runTableReport, tableReportToCsv, tableCellRaw, AVAILABLE_COLUMNS, AVAILABLE_DIMENSIONS, filterableColumns, runMatrixReport, matrixToCsv, type ReportDef } from '../src/reports.js';
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

describe('reports · tabular (listados)', () => {
  const bi = (o: Partial<Ticket>): Ticket => tk({ area: 'ar-bi', templateName: 'Solicitud de datos BI', sdpUdf: { udf_char128: 'Completada', udf_long1: '1' }, ...o });

  it('tableCellRaw resuelve campos estándar, templateName y udf:', () => {
    const t = bi({ subject: 'Alta activo', closureComment: 'cerrado' });
    expect(tableCellRaw(t, 'subject')).toBe('Alta activo');
    expect(tableCellRaw(t, 'templateName')).toBe('Solicitud de datos BI');
    expect(tableCellRaw(t, 'udf:udf_char128')).toBe('Completada');
    expect(tableCellRaw(t, 'closureComment')).toBe('cerrado');
    expect(tableCellRaw(t, 'udf:no_existe')).toBe('');
  });

  it('tableCellRaw · doble fuente dual: nativo (cf) primero, SDP (udf) de respaldo', () => {
    // Ticket nativo de ticketIN: valor en udf[cf-*] → gana sobre el histórico de SDP.
    const nativo = tk({ udf: { 'cf-dep': 'FIN - Financiero' }, sdpUdf: { udf_char673: 'Otro dpto SDP' } });
    expect(tableCellRaw(nativo, 'dual:cf-dep:udf_char673')).toBe('FIN - Financiero');
    expect(tableCellRaw(nativo, 'cf:cf-dep')).toBe('FIN - Financiero');
    // Ticket sincronizado de SDP: sin campo nativo → cae al udf histórico.
    const sdp = tk({ sdpUdf: { udf_char673: 'Third Party Business' } });
    expect(tableCellRaw(sdp, 'dual:cf-dep:udf_char673')).toBe('Third Party Business');
    // Sin ninguna de las dos fuentes → cadena vacía.
    expect(tableCellRaw(tk({}), 'dual:cf-dep:udf_char673')).toBe('');
  });

  it('runTableReport filtra por ámbito y proyecta columnas', () => {
    const def: ReportDef = { id: 't', name: 'BI', dimension: 'area', kind: 'table', filters: [{ field: 'area', value: 'ar-bi' }], columns: [{ key: 'subject', label: 'Asunto' }, { key: 'udf:udf_char128', label: 'Estado BI' }] };
    const tickets = [bi({ subject: 'a' }), bi({ subject: 'b', sdpUdf: { udf_char128: 'Abierta' } }), tk({ area: 'ar-reo', subject: 'c' })];
    const r = runTableReport(def, tickets);
    expect(r.total).toBe(2);
    expect(r.rows.map((x) => x['subject'])).toEqual(['a', 'b']);
    expect(r.rows[1]!['udf:udf_char128']).toBe('Abierta');
  });

  it('respeta el periodo cuando se pasa [from,to)', () => {
    const def: ReportDef = { id: 't', name: 'BI', dimension: 'area', kind: 'table', filters: [{ field: 'area', value: 'ar-bi' }], columns: [{ key: 'subject', label: 'Asunto' }] };
    const r = runTableReport(def, [bi({ subject: 'in', createdAt: T0 }), bi({ subject: 'out', createdAt: T0 - 10 * DAY })], T0 - 1, T0 + 1);
    expect(r.total).toBe(1);
    expect(r.rows[0]!['subject']).toBe('in');
  });

  it('openOnly excluye los archivados (backlog)', () => {
    const def: ReportDef = { id: 't', name: 'REO', dimension: 'group', kind: 'table', openOnly: true, columns: [{ key: 'subject', label: 'Asunto' }] };
    const tickets = [tk({ subject: 'abierto' }), { ...tk({ subject: 'cerrado' }), archived: true } as unknown as Ticket];
    const r = runTableReport(def, tickets);
    expect(r.total).toBe(1);
    expect(r.rows[0]!['subject']).toBe('abierto');
  });

  it('periodField:resolved filtra por fecha de cierre, no de creación', () => {
    const def: ReportDef = { id: 't', name: 'Closed', dimension: 'group', kind: 'table', periodField: 'resolved', columns: [{ key: 'subject', label: 'Asunto' }] };
    const tickets = [
      { ...tk({ subject: 'cerrado en periodo', createdAt: T0 - 100 * DAY }), resolvedAt: T0 } as unknown as Ticket,
      { ...tk({ subject: 'creado en periodo pero no cerrado', createdAt: T0 }), resolvedAt: T0 - 100 * DAY } as unknown as Ticket,
    ];
    const r = runTableReport(def, tickets, T0 - 1, T0 + 1);
    expect(r.total).toBe(1);
    expect(r.rows[0]!['subject']).toBe('cerrado en periodo');
  });

  it('tableReportToCsv usa etiquetas de columna y humaniza con label()', () => {
    const def: ReportDef = { id: 't', name: 'BI', dimension: 'area', kind: 'table', filters: [{ field: 'area', value: 'ar-bi' }], columns: [{ key: 'subject', label: 'Asunto' }, { key: 'technician', label: 'Técnico' }] };
    const r = runTableReport(def, [bi({ subject: 'Con; punto y coma', technicianId: 'u1' })]);
    const csv = tableReportToCsv(r, (k, raw) => (k === 'technician' && raw === 'u1' ? 'Ana' : raw));
    expect(csv.split('\n')[0]).toBe('Asunto;Técnico');
    expect(csv.split('\n')[1]).toBe('"Con; punto y coma";Ana'); // escapado por el ';'
  });

  it('no quedan presets tabulares de código (Seguimiento BI es ahora un informe guardado real)', () => {
    expect(DEFAULT_TABLE_REPORTS).toHaveLength(0);
  });
});

describe('reports · constructor (catálogo)', () => {
  it('AVAILABLE_COLUMNS incluye estándar + campos udf de SDP', () => {
    const keys = AVAILABLE_COLUMNS.map((c) => c.key);
    expect(keys).toContain('subject');
    expect(keys).toContain('templateName');
    expect(keys).toContain('udf:udf_char128'); // Estado BI
    expect(AVAILABLE_DIMENSIONS.map((d) => d[0])).toContain('group');
  });
  it('filterableColumns excluye texto/fecha (asunto, id, createdAt, cierre)', () => {
    const cols = [{ key: 'subject', label: 'Asunto' }, { key: 'status', label: 'Estado' }, { key: 'createdAt', label: 'Fecha' }, { key: 'udf:udf_char128', label: 'Estado BI' }];
    expect(filterableColumns(cols)).toEqual(['status', 'udf:udf_char128']);
  });
});

describe('reports · matriz (tabla cruzada)', () => {
  const def: ReportDef = { id: 'm', name: 'M', dimension: 'group', dimension2: 'priority', kind: 'matrix' };
  it('cuenta por fila×columna con totales', () => {
    const tickets = [
      tk({ groupId: 'g1', priority: 'Alta', createdAt: T0 }),
      tk({ groupId: 'g1', priority: 'Alta', createdAt: T0 }),
      tk({ groupId: 'g1', priority: 'Baja', createdAt: T0 }),
      tk({ groupId: 'g2', priority: 'Alta', createdAt: T0 }),
    ];
    const r = runMatrixReport(def, tickets, T0 - 1, T0 + 1);
    expect(r.total).toBe(4);
    expect(r.cells['g1']!['Alta']).toBe(2);
    expect(r.cells['g1']!['Baja']).toBe(1);
    expect(r.rowTotals['g1']).toBe(3);
    expect(r.colTotals['Alta']).toBe(3);
    expect(r.rows[0]).toBe('g1'); // ordenado por total desc
  });
  it('matrixToCsv trae cabecera, filas y total', () => {
    const r = runMatrixReport(def, [tk({ groupId: 'g1', priority: 'Alta', createdAt: T0 })], T0 - 1, T0 + 1);
    const csv = matrixToCsv(r, (_dim, key) => key);
    expect(csv.split('\n')[0]).toBe(';Alta;Total');
    expect(csv).toContain('g1;1;1');
    expect(csv.trim().endsWith('Total;1;1')).toBe(true);
  });
});
