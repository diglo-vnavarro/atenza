// ============================================================================
// Mappers PUROS: JSON de ServiceDesk Plus (API v3) -> modelo de Atenza.
//
// Son el núcleo del importador y están testeados (test/importer.test.ts) con
// JSON de ejemplo con la forma de la v3, sin necesidad de credenciales ni red.
// El cliente (client.ts) trae los datos; aquí solo se transforman.
// ============================================================================

import type { Template, Sla, TicketType } from '../src/model.js';
import type { TenantData, UiMember, Group } from '../src/data/seed.js';

const PALETTE = ['#4f46e5', '#0f766e', '#b45309', '#0369a1', '#be185d', '#7c3aed', '#15803d', '#4338ca', '#0891b2', '#9333ea'];
const colorAt = (i: number) => PALETTE[i % PALETTE.length]!;

/** Duración SDP {days,hours,minutes} -> minutos. */
export function durationToMins(d: { days?: number; hours?: number; minutes?: number } | number | null | undefined): number {
  if (d == null) return 0;
  if (typeof d === 'number') return d; // ya en minutos
  return (d.days ?? 0) * 1440 + (d.hours ?? 0) * 60 + (d.minutes ?? 0);
}

export interface SdpTemplate { id: string | number; name: string; is_service_template?: boolean; service_category?: unknown; fields?: { name?: string; label?: string }[] }
export function mapTemplate(t: SdpTemplate): Template {
  return {
    id: String(t.id),
    name: t.name,
    type: (t.is_service_template ? 'service_request' : 'incident') as TicketType,
    lifecycleId: null, // el vínculo/estructura del ciclo no viene fiable en v3 -> se asigna aparte
    slaId: null,
    fields: (t.fields ?? []).map((f) => f.name ?? f.label ?? '').filter(Boolean),
  };
}

export interface SdpCategory { id: string | number; name: string }
export function mapCategories(cats: SdpCategory[]): string[] {
  return [...new Set(cats.map((c) => c.name).filter(Boolean))];
}

export interface SdpSla { id: string | number; name: string; response_time?: unknown; resolution_time?: unknown }
export function mapSla(s: SdpSla): Sla {
  return {
    id: String(s.id),
    name: s.name,
    responseMins: durationToMins(s.response_time as never),
    resolveMins: durationToMins(s.resolution_time as never),
  };
}

export interface SdpGroup { id: string | number; name: string }
export function mapGroup(g: SdpGroup): Group {
  return { id: String(g.id), name: g.name };
}

export interface SdpUser { id: string | number; name?: string; first_name?: string; last_name?: string; email_id?: string }
export function mapUser(u: SdpUser, role: 'technician' | 'requester', i: number, corpDomain: string): UiMember {
  const name = u.name ?? [u.first_name, u.last_name].filter(Boolean).join(' ') ?? String(u.id);
  const email = u.email_id ?? '';
  const external = !!email && !email.toLowerCase().endsWith('@' + corpDomain.toLowerCase());
  return { uid: String(u.id), name, email, role, status: 'active', external, color: colorAt(i) };
}

/** Estado SDP -> categoría de temporizador de Atenza (por si se reconstruyen ciclos). */
export interface SdpStatus { id: string | number; name: string; stop_timer?: boolean; in_progress?: boolean }
export function statusCategory(s: SdpStatus): 'in_progress' | 'stop_timer' | 'completed' {
  if (s.in_progress) return 'in_progress';
  if (s.stop_timer) return 'stop_timer';
  return 'completed';
}

export interface SdpRaw {
  instanceName?: string;
  corpDomain?: string;
  templates?: SdpTemplate[];
  categories?: SdpCategory[];
  slas?: SdpSla[];
  groups?: SdpGroup[];
  technicians?: SdpUser[];
  requesters?: SdpUser[];
  priorities?: { name: string }[];
  statuses?: SdpStatus[];
}

/** Snapshot importado, con la forma que consume un tenant de Atenza (+ referencia). */
export interface ImportedSnapshot {
  name: string;
  categories: string[];
  templates: Template[];
  slas: Sla[];
  groups: Group[];
  members: UiMember[];
  reference: { priorities: string[]; statuses: { name: string; category: string }[] };
}

export function mapSnapshot(raw: SdpRaw): ImportedSnapshot {
  const corp = raw.corpDomain ?? 'digloservicer.com';
  const techs = (raw.technicians ?? []).map((u, i) => mapUser(u, 'technician', i, corp));
  const reqs = (raw.requesters ?? []).map((u, i) => mapUser(u, 'requester', i + techs.length, corp));
  return {
    name: raw.instanceName ?? 'Instancia importada',
    categories: mapCategories(raw.categories ?? []),
    templates: (raw.templates ?? []).map(mapTemplate),
    slas: (raw.slas ?? []).map(mapSla),
    groups: (raw.groups ?? []).map(mapGroup),
    members: [...techs, ...reqs],
    reference: {
      priorities: (raw.priorities ?? []).map((p) => p.name),
      statuses: (raw.statuses ?? []).map((s) => ({ name: s.name, category: statusCategory(s) })),
    },
  };
}

export type { TenantData };
