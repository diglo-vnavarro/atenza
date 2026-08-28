// M2 — Motor de INFORMES (puro y testeable). Agrega tickets por una dimensión, dentro de un
// periodo y con filtros opcionales. Reutilizado por la vista «Informes» (on-demand) y, a futuro,
// por el job programado (semanal) que renderiza + envía por email.
import type { Ticket, TicketType } from './model.js';

export type ReportDimension = 'area' | 'service' | 'group' | 'status' | 'priority' | 'technician' | 'type' | 'serviceCategory';
export interface ReportFilter { field: ReportDimension; value: string }
export interface ReportDef { id: string; name: string; dimension: ReportDimension; filters?: ReportFilter[] }
export interface ReportRow { key: string; count: number; pct: number }
export interface ReportResult { def: ReportDef; from: number; to: number; total: number; rows: ReportRow[] }

const NONE = '—';
/** Valor de la dimensión para un ticket (id/valor crudo; el nombre lo resuelve la UI). */
export function dimValue(t: Ticket, dim: ReportDimension): string {
  switch (dim) {
    case 'area': return t.area || NONE;
    case 'service': return t.service || NONE;
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
  { id: 'rep-tecnico', name: 'Por técnico', dimension: 'technician' },
  { id: 'rep-prioridad', name: 'Por prioridad', dimension: 'priority' },
  { id: 'rep-tipo', name: 'Incidencias vs peticiones', dimension: 'type' },
];
