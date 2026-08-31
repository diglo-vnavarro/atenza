// M2 — Motor de INFORMES (puro y testeable). Agrega tickets por una dimensión, dentro de un
// periodo y con filtros opcionales. Reutilizado por la vista «Informes» (on-demand) y, a futuro,
// por el job programado (semanal) que renderiza + envía por email.
import type { Ticket, TicketType } from './model.js';

export type ReportDimension = 'area' | 'service' | 'element' | 'group' | 'status' | 'priority' | 'technician' | 'type' | 'serviceCategory';
export interface ReportFilter { field: ReportDimension; value: string }
/** Columna de un informe TABULAR. `key` es un selector: campo estándar
 *  ('subject','status','technician'…), 'templateName'/'closureComment', o 'udf:udf_char128'. */
export interface ReportColumn { key: string; label: string }
/** Ámbito BASE de un listado tabular: por qué campo indexado se cargan los tickets (grupo, área…). */
export interface ReportScope { label: string; field: 'group' | 'area' | 'technician' | 'service'; value: string }
export interface ReportDef {
  id: string; name: string; dimension: ReportDimension; filters?: ReportFilter[];
  /** 'summary' (por defecto) = agrega por dimensión; 'table' = listado con columnas. */
  kind?: 'summary' | 'table';
  columns?: ReportColumn[];
  /** Acotación temporal del listado tabular ('none' = todo el histórico del ámbito). */
  period?: 'none' | 'week' | 'month';
  /** Ámbitos base seleccionables (primero = por defecto). Cada uno es una carga distinta. */
  scopes?: ReportScope[];
  /** Columnas por las que ofrecer un filtro desplegable en la vista (además del rango de fechas). */
  filterCols?: string[];
}
/** Campo de Firestore para el ámbito base de un listado (índice de un solo campo). */
export const SCOPE_DB_FIELD: Record<ReportScope['field'], string> = { group: 'groupId', area: 'area', technician: 'technicianId', service: 'service' };
export interface ReportRow { key: string; count: number; pct: number }
export interface ReportResult { def: ReportDef; from: number; to: number; total: number; rows: ReportRow[] }
export interface TableResult { def: ReportDef; from?: number; to?: number; total: number; rows: Record<string, string>[] }

const NONE = '—';
/** Valor de la dimensión para un ticket (id/valor crudo; el nombre lo resuelve la UI). */
export function dimValue(t: Ticket, dim: ReportDimension): string {
  switch (dim) {
    case 'area': return t.area || NONE;
    case 'service': return t.service || NONE;
    case 'element': return t.element || NONE;
    case 'group': return t.groupId || NONE;
    case 'status': return t.status || NONE;
    case 'priority': return t.priority || NONE;
    case 'technician': return t.technicianId || '(sin asignar)';
    case 'type': return t.type as TicketType;
    case 'serviceCategory': return t.serviceCategory || t.serviceCategoryId || NONE;
    default: return NONE;
  }
}

/** Tickets creados en [from, to) que cumplen los filtros, agregados por la dimensión (desc). */
export function runReport(def: ReportDef, tickets: Ticket[], from: number, to: number): ReportResult {
  const filtered = tickets.filter((t) => {
    const c = t.createdAt ?? 0;
    if (c < from || c >= to) return false;
    return (def.filters ?? []).every((f) => dimValue(t, f.field) === f.value);
  });
  const counts = new Map<string, number>();
  for (const t of filtered) { const k = dimValue(t, def.dimension); counts.set(k, (counts.get(k) ?? 0) + 1); }
  const total = filtered.length;
  const rows: ReportRow[] = [...counts.entries()]
    .map(([key, count]) => ({ key, count, pct: total ? Math.round((count / total) * 1000) / 10 : 0 }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  return { def, from, to, total, rows };
}

// ---- INFORMES TABULARES (listado con columnas; p. ej. «Seguimiento BI») ----
/** Valor CRUDO de una columna para un ticket (ids sin resolver; el nombre lo pone `label`). */
export function tableCellRaw(t: Ticket, key: string): string {
  if (key.startsWith('udf:')) return t.sdpUdf?.[key.slice(4)] ?? '';
  switch (key) {
    case 'id': return (t as { id?: string }).id ?? '';
    case 'subject': return t.subject ?? '';
    case 'status': return t.status ?? '';
    case 'priority': return t.priority ?? '';
    case 'type': return t.type as string;
    case 'templateName': return t.templateName ?? '';
    case 'closureComment': return t.closureComment ?? '';
    case 'group': return t.groupId ?? '';
    case 'technician': return t.technicianId ?? '';
    case 'requester': return t.requesterId ?? '';
    case 'area': return t.area ?? '';
    case 'service': return t.service ?? '';
    case 'element': return t.element ?? '';
    case 'createdAt': return t.createdAt ? String(t.createdAt) : '';
    default: return '';
  }
}

/** Ejecuta un informe TABULAR: filtra por ámbito (y periodo si aplica) y proyecta las columnas. */
export function runTableReport(def: ReportDef, tickets: Ticket[], from?: number, to?: number): TableResult {
  const cols = def.columns ?? [];
  const filtered = tickets.filter((t) => {
    if (from != null && to != null) { const c = t.createdAt ?? 0; if (c < from || c >= to) return false; }
    return (def.filters ?? []).every((f) => dimValue(t, f.field) === f.value);
  });
  const rows = filtered.map((t) => { const r: Record<string, string> = {}; for (const c of cols) r[c.key] = tableCellRaw(t, c.key); return r; });
  return { def, from, to, total: filtered.length, rows };
}

/** CSV del informe tabular. `label(colKey, raw)` humaniza ids (grupo/técnico/estado…). */
export function tableReportToCsv(r: TableResult, label: (colKey: string, raw: string) => string): string {
  const cols = r.def.columns ?? [];
  const esc = (s: string) => /[;\n"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  const head = cols.map((c) => esc(c.label)).join(';');
  const lines = r.rows.map((row) => cols.map((c) => esc(label(c.key, row[c.key] ?? ''))).join(';'));
  return [head, ...lines].join('\n');
}

/** HTML del informe tabular (para email / vista). `label` humaniza ids; `fmt` fechas. */
export function tableReportToHtml(r: TableResult, label: (colKey: string, raw: string) => string, fmt: (t: number) => string): string {
  const cols = r.def.columns ?? [];
  const th = 'text-align:left;padding:6px 10px;border-bottom:2px solid #ddd;white-space:nowrap';
  const td = 'padding:6px 10px;border-bottom:1px solid #eee;vertical-align:top';
  const head = cols.map((c) => `<th style="${th}">${c.label}</th>`).join('');
  const body = r.rows.map((row) => `<tr>${cols.map((c) => `<td style="${td}">${label(c.key, row[c.key] ?? '') || '—'}</td>`).join('')}</tr>`).join('');
  const period = r.from != null && r.to != null ? `${fmt(r.from)} – ${fmt(r.to - 1)} · ` : '';
  return `<div style="font-family:system-ui,Arial,sans-serif;color:#1a2233">`
    + `<h2 style="margin:0 0 2px">${r.def.name}</h2>`
    + `<p style="color:#777;margin:0 0 12px;font-size:13px">${period}${r.total} solicitudes</p>`
    + `<table style="border-collapse:collapse;font-size:13px"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

/** Límites [from, to) de la SEMANA (lunes 00:00 local) o del MES que contiene `ref`. */
export function periodBounds(ref: number, unit: 'week' | 'month'): { from: number; to: number } {
  const d = new Date(ref);
  if (unit === 'month') {
    return { from: new Date(d.getFullYear(), d.getMonth(), 1).getTime(), to: new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime() };
  }
  const dow = (d.getDay() + 6) % 7; // 0 = lunes
  const from = new Date(d.getFullYear(), d.getMonth(), d.getDate() - dow).getTime();
  return { from, to: from + 7 * 24 * 3600 * 1000 };
}

/** Informe PROGRAMADO (F2): un ReportDef + periodicidad + destinatarios, para el envío semanal. */
export interface ReportSchedule extends ReportDef { unit: 'week' | 'month'; recipients: string[]; enabled: boolean }

/** Render del informe a HTML (para el email). `label` resuelve id→nombre; `fmt` fecha. */
export function reportToHtml(r: ReportResult, label: (key: string) => string, fmt: (t: number) => string): string {
  const cell = 'padding:6px 10px;border-bottom:1px solid #eee';
  const rows = r.rows.map((row) => `<tr><td style="${cell}">${label(row.key)}</td><td style="${cell};text-align:right">${row.count}</td><td style="${cell};text-align:right;color:#777">${row.pct}%</td></tr>`).join('');
  return `<div style="font-family:system-ui,Arial,sans-serif;color:#1a2233">`
    + `<h2 style="margin:0 0 2px">${r.def.name}</h2>`
    + `<p style="color:#777;margin:0 0 12px;font-size:13px">${fmt(r.from)} – ${fmt(r.to - 1)} · ${r.total} solicitudes</p>`
    + `<table style="border-collapse:collapse;font-size:14px;min-width:340px"><thead><tr>`
    + `<th style="text-align:left;padding:6px 10px;border-bottom:2px solid #ddd">${r.def.name}</th>`
    + `<th style="text-align:right;padding:6px 10px;border-bottom:2px solid #ddd">Tickets</th>`
    + `<th style="text-align:right;padding:6px 10px;border-bottom:2px solid #ddd">%</th></tr></thead>`
    + `<tbody>${rows}</tbody>`
    + `<tfoot><tr><td style="padding:6px 10px;font-weight:600">Total</td><td style="padding:6px 10px;text-align:right;font-weight:600">${r.total}</td><td style="padding:6px 10px;text-align:right">100%</td></tr></tfoot></table></div>`;
}

/** Periodo COMPLETO anterior al de `ref` (la semana/mes que acaba de cerrar). */
export function previousPeriod(ref: number, unit: 'week' | 'month'): { from: number; to: number } {
  const cur = periodBounds(ref, unit);
  return periodBounds(cur.from - 1, unit);
}

/** Informe a CSV (una fila por categoría de la dimensión). */
export function reportToCsv(r: ReportResult): string {
  const head = `${r.def.dimension};tickets;%`;
  const lines = r.rows.map((row) => `${row.key.replace(/;/g, ',')};${row.count};${row.pct}`);
  return [head, ...lines, `TOTAL;${r.total};100`].join('\n');
}

/** Presets genéricos. Los específicos del equipo (Altas/Bajas, BI, WEB…) se definen con `filters`. */
export const DEFAULT_REPORTS: ReportDef[] = [
  { id: 'rep-grupo', name: 'Por grupo de soporte', dimension: 'group' },
  { id: 'rep-estado', name: 'Por estado', dimension: 'status' },
  { id: 'rep-categoria', name: 'Por categoría', dimension: 'area' },
  { id: 'rep-subcat', name: 'Por subcategoría', dimension: 'service' },
  { id: 'rep-tipologia', name: 'Por tipología', dimension: 'element' },
  { id: 'rep-tecnico', name: 'Por técnico', dimension: 'technician' },
  { id: 'rep-prioridad', name: 'Por prioridad', dimension: 'priority' },
  { id: 'rep-tipo', name: 'Incidencias vs peticiones', dimension: 'type' },
];

/** Presets TABULARES del equipo (reproducen informes de SDP 1:1). */
export const DEFAULT_TABLE_REPORTS: ReportDef[] = [
  {
    id: 'rep-seguimiento-bi',
    name: 'Seguimiento BI',
    dimension: 'area',
    kind: 'table',
    period: 'none',
    // Ámbito base (primero = por defecto = el del informe SDP original: grupo «Técnicos BI»).
    scopes: [
      { label: 'Grupo «Técnicos BI» (= informe SDP)', field: 'group', value: '9207000000690768' },
      { label: 'Grupo «Técnicos BI» (actual)', field: 'group', value: '9207000001963083' },
      { label: 'Área BI — todo el histórico', field: 'area', value: 'ar-bi' },
    ],
    // Columnas con filtro desplegable en la vista (+ rango de fechas de creación).
    filterCols: ['status', 'udf:udf_char128', 'templateName', 'technician', 'udf:udf_char129'],
    columns: [
      { key: 'templateName', label: 'Plantilla' },
      { key: 'requester', label: 'Solicitante' },
      { key: 'udf:udf_char129', label: 'Tipología Ticket' },
      { key: 'subject', label: 'Asunto' },
      { key: 'status', label: 'Estado de solicitud' },
      { key: 'udf:udf_char128', label: 'Estado BI' },
      { key: 'udf:udf_long1', label: 'Prioridad BI' },
      { key: 'technician', label: 'Técnico' },
      { key: 'closureComment', label: 'Comentarios de cierre' },
      { key: 'udf:udf_char122', label: 'Gestión Datos Petición' },
      { key: 'udf:udf_char13', label: 'Impacto en BI' },
      { key: 'udf:udf_char124', label: 'Informe BI Afectado' },
    ],
  },
];
