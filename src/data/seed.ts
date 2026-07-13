// Datos semilla del piloto (local-first). Dos instancias, reflejando la
// realidad de Diglo: una interna completa y un cliente externo (Leasys).
import type { Lifecycle, Template, Sla, Ticket, StatusSegment } from '../model.js';

export interface UiMember {
  uid: string; email: string; name: string; color: string;
  role: 'tenant_admin' | 'technician' | 'requester';
  status: 'active' | 'invited' | 'disabled';
  external: boolean;
  /** ids de grupos de soporte a los que pertenece (perfilado de asignación). */
  groupIds?: string[];
}
export interface Capacity { used: number; cap: number; off?: string }
export interface Group { id: string; name: string }
/** Ticket con su id (en Firestore el id es la clave del documento). */
export type StoredTicket = Ticket & { id: string };
export interface TenantData {
  id: string; name: string; key: string; active: boolean;
  members: UiMember[]; lifecycles: Lifecycle[]; templates: Template[];
  slas: Sla[]; groups: Group[]; tickets: StoredTicket[];
  categories: string[];
  capacity: Record<string, Capacity>; counter: number;
}
export interface DB { tenants: TenantData[]; platformAdmins: string[] }

const T = (id: string, name: string, from: string, to: string) => ({ id, name, from, to });

// Ciclo de vida "RLC - Incidencias" (inspirado en el real de Diglo).
const rlc: Lifecycle = {
  id: 'lc-inc', name: 'RLC - Incidencias', version: '1.0', published: true, type: 'incident',
  states: [
    { key: 'open', label: 'Abierta', stage: 'open', category: 'in_progress', isInitial: true },
    { key: 'assigned', label: 'Asignada', stage: 'open', category: 'in_progress' },
    { key: 'working', label: 'Trabajando', stage: 'open', category: 'in_progress' },
    { key: 'p_user', label: 'Pendiente usuario', stage: 'pending', category: 'stop_timer' },
    { key: 'p_bank', label: 'Pendiente Banco', stage: 'pending', category: 'stop_timer' },
    { key: 'p_third', label: 'Pendiente terceros', stage: 'pending', category: 'stop_timer' },
    { key: 'resolved', label: 'Resuelta', stage: 'resolved', category: 'completed' },
    { key: 'closed', label: 'Cerrada', stage: 'closed', category: 'completed', isTerminal: true },
    { key: 'cancelled', label: 'Cancelada', stage: 'closed', category: 'completed', isTerminal: true },
  ],
  transitions: [
    T('t1', 'Abierta → Asignada', 'open', 'assigned'), T('t2', 'Abierta → Trabajando', 'open', 'working'),
    T('t3', 'Asignada → Trabajando', 'assigned', 'working'),
    T('t4', 'Trabajando → Pendiente usuario', 'working', 'p_user'),
    T('t5', 'Trabajando → Pendiente Banco', 'working', 'p_bank'),
    T('t6', 'Trabajando → Pendiente terceros', 'working', 'p_third'),
    T('t7', 'Pendiente usuario → Trabajando', 'p_user', 'working'),
    T('t8', 'Pendiente Banco → Trabajando', 'p_bank', 'working'),
    T('t9', 'Pendiente terceros → Trabajando', 'p_third', 'working'),
    T('t10', 'Trabajando → Resuelta', 'working', 'resolved'),
    T('t11', 'Resuelta → Cerrada', 'resolved', 'closed'),
    T('t12', 'Resuelta → Trabajando (reapertura)', 'resolved', 'working'),
    T('t13', 'Trabajando → Cancelada', 'working', 'cancelled'),
  ],
};

const leasysLc: Lifecycle = {
  id: 'lc-lea', name: 'Petición de cliente', version: '1.0', published: true, type: 'service_request',
  states: [
    { key: 'received', label: 'Recibida', stage: 'open', category: 'in_progress', isInitial: true },
    { key: 'working', label: 'En gestión', stage: 'open', category: 'in_progress' },
    { key: 'waiting', label: 'Esperando al cliente', stage: 'pending', category: 'stop_timer' },
    { key: 'resolved', label: 'Resuelta', stage: 'resolved', category: 'completed' },
    { key: 'closed', label: 'Cerrada', stage: 'closed', category: 'completed', isTerminal: true },
  ],
  transitions: [
    T('l1', 'Recibida → En gestión', 'received', 'working'),
    T('l2', 'En gestión → Esperando al cliente', 'working', 'waiting'),
    T('l3', 'Esperando al cliente → En gestión', 'waiting', 'working'),
    T('l4', 'En gestión → Resuelta', 'working', 'resolved'),
    T('l5', 'Resuelta → Cerrada', 'resolved', 'closed'),
    T('l6', 'Resuelta → En gestión', 'resolved', 'working'),
  ],
};

// Segundo ciclo (Solicitudes de servicio con aprobación) para el tenant IT.
const srLc: Lifecycle = {
  id: 'lc-sr', name: 'Solicitud con aprobación', version: '1.0', published: true, type: 'service_request',
  states: [
    { key: 'new', label: 'Nueva', stage: 'open', category: 'in_progress', isInitial: true },
    { key: 'approval', label: 'En aprobación', stage: 'pending', category: 'stop_timer' },
    { key: 'working', label: 'En gestión', stage: 'open', category: 'in_progress' },
    { key: 'on_hold', label: 'En espera', stage: 'pending', category: 'stop_timer' },
    { key: 'delivered', label: 'Entregada', stage: 'resolved', category: 'completed' },
    { key: 'closed', label: 'Cerrada', stage: 'closed', category: 'completed', isTerminal: true },
  ],
  transitions: [
    T('s1', 'Nueva → En aprobación', 'new', 'approval'),
    T('s2', 'En aprobación → En gestión', 'approval', 'working'),
    T('s3', 'En aprobación → Cerrada (rechazo)', 'approval', 'closed'),
    T('s4', 'En gestión → En espera', 'working', 'on_hold'),
    T('s5', 'En espera → En gestión', 'on_hold', 'working'),
    T('s6', 'En gestión → Entregada', 'working', 'delivered'),
    T('s7', 'Entregada → Cerrada', 'delivered', 'closed'),
    T('s8', 'Entregada → En gestión', 'delivered', 'working'),
  ],
};

// Dos flujos reales adicionales detectados en SDP (esqueleto; internos exactos = canvas no rascable).
const iamLc: Lifecycle = {
  id: 'lc-alta', name: 'Alta de usuarios internos', version: '1.0', published: true, type: 'service_request',
  states: [
    { key: 'requested', label: 'Solicitada', stage: 'open', category: 'in_progress', isInitial: true },
    { key: 'approval', label: 'En aprobación', stage: 'pending', category: 'stop_timer' },
    { key: 'provisioning', label: 'Provisionando', stage: 'open', category: 'in_progress' },
    { key: 'delivered', label: 'Entregada', stage: 'resolved', category: 'completed' },
    { key: 'closed', label: 'Cerrada', stage: 'closed', category: 'completed', isTerminal: true },
  ],
  transitions: [
    T('a1', 'Solicitada → En aprobación', 'requested', 'approval'),
    T('a2', 'En aprobación → Provisionando', 'approval', 'provisioning'),
    T('a3', 'En aprobación → Cerrada (rechazo)', 'approval', 'closed'),
    T('a4', 'Provisionando → Entregada', 'provisioning', 'delivered'),
    T('a5', 'Entregada → Cerrada', 'delivered', 'closed'),
  ],
};
const opsLc: Lifecycle = {
  id: 'lc-ops', name: 'Operaciones - Liquidaciones Informativas Deuda', version: '1.0', published: true, type: 'service_request',
  states: [
    { key: 'received', label: 'Recibida', stage: 'open', category: 'in_progress', isInitial: true },
    { key: 'processing', label: 'En proceso', stage: 'open', category: 'in_progress' },
    { key: 'pending_data', label: 'Pendiente de datos', stage: 'pending', category: 'stop_timer' },
    { key: 'settled', label: 'Liquidada', stage: 'resolved', category: 'completed' },
    { key: 'closed', label: 'Cerrada', stage: 'closed', category: 'completed', isTerminal: true },
  ],
  transitions: [
    T('o1', 'Recibida → En proceso', 'received', 'processing'),
    T('o2', 'En proceso → Pendiente de datos', 'processing', 'pending_data'),
    T('o3', 'Pendiente de datos → En proceso', 'pending_data', 'processing'),
    T('o4', 'En proceso → Liquidada', 'processing', 'settled'),
    T('o5', 'Liquidada → Cerrada', 'settled', 'closed'),
  ],
};

const IT_CATEGORIES = ['Aplicaciones', 'Arquitectura', 'Comunicaciones', 'Correo Electrónico', 'Datos', 'Dispositivos', 'General', 'Hardware', 'Internet', 'Microsoft Office', 'Móviles', 'Operaciones', 'Reclamaciones de Clientes', 'Redes', 'VDI'];
const LEASYS_CATEGORIES = ['Portal', 'Facturación', 'Contratos', 'Firma electrónica', 'Avisos', 'General'];

const itSlas: Sla[] = [
  { id: 'sla-high', name: 'Alta (High)', responseMins: 30, resolveMins: 120 },
  { id: 'sla-med', name: 'Media (Medium)', responseMins: 60, resolveMins: 360 },
  { id: 'sla-low', name: 'Baja (Low)', responseMins: 240, resolveMins: 2880 },
];
export const SLA_BY_PRIORITY: Record<string, string> = { high: 'sla-high', medium: 'sla-med', low: 'sla-low' };

const MIN = 60000;
const seg = (state: string, agoMinFrom: number, agoMinTo: number | null, now: number): StatusSegment =>
  ({ state, from: now - agoMinFrom * MIN, to: agoMinTo == null ? null : now - agoMinTo * MIN });

export function makeSeed(now: number): DB {
  const it: TenantData = {
    id: 'diglo-it', name: 'Diglo ITSM', key: 'itdesk', active: true,
    members: [
      { uid: 'u-admin', email: 'vnavarro@digloservicer.com', name: 'Vicente Navarro', color: '#4f46e5', role: 'tenant_admin', status: 'active', external: false },
      { uid: 'u-elena', email: 'eandres@digloservicer.com', name: 'Elena Andrés', color: '#0f766e', role: 'technician', status: 'active', external: false },
      { uid: 'u-oscar', email: 'oigualada@digloservicer.com', name: 'Óscar Igualada', color: '#b45309', role: 'technician', status: 'active', external: false },
      { uid: 'u-sergio', email: 'sfrias@digloservicer.com', name: 'Sergio Frías', color: '#0369a1', role: 'technician', status: 'active', external: false },
      { uid: 'u-bea', email: 'bcabado@digloservicer.com', name: 'Beatriz Cabado', color: '#be185d', role: 'technician', status: 'active', external: false },
      { uid: 'u-laura', email: 'laura.gomez@digloservicer.com', name: 'Laura Gómez', color: '#7c3aed', role: 'requester', status: 'active', external: false },
    ],
    lifecycles: [rlc, srLc, iamLc, opsLc], templates: [
      { id: 'tpl-inc', type: 'incident', name: 'Incidencia', lifecycleId: 'lc-inc', slaId: null, fields: ['subject', 'description', 'category', 'priority', 'impact'] },
      { id: 'tpl-sr', type: 'service_request', name: 'Solicitud de servicio', lifecycleId: 'lc-sr', slaId: null, fields: ['subject', 'description', 'category', 'priority'] },
    ], slas: itSlas,
    groups: [{ id: 'g-n1', name: 'Soporte N1' }, { id: 'g-n2', name: 'Soporte N2' }, { id: 'g-red', name: 'Redes' }],
    categories: IT_CATEGORIES,
    capacity: {
      'u-elena': { used: 34, cap: 40 }, 'u-oscar': { used: 41, cap: 40 },
      'u-sergio': { used: 19, cap: 40 }, 'u-bea': { used: 0, cap: 40, off: 'Vacaciones' },
      'u-admin': { used: 30, cap: 40 },
    },
    counter: 2042,
    tickets: [
      { type: 'incident', subject: 'VPN caída en la oficina de Madrid', description: 'Varios usuarios no pueden conectar a la VPN desde esta mañana.', requesterId: 'u-laura', technicianId: null, groupId: 'g-red', category: 'Red', priority: 'high', impact: 'department', templateId: 'tpl-inc', status: 'open', slaId: 'sla-high', statusHistory: [seg('open', 90, null, now)] },
      { type: 'incident', subject: 'Portátil no arranca tras actualización', description: 'Pantalla azul tras la actualización de Windows.', requesterId: 'u-laura', technicianId: 'u-elena', groupId: 'g-n1', category: 'Hardware', priority: 'medium', impact: 'user', templateId: 'tpl-inc', status: 'p_user', slaId: 'sla-med', statusHistory: [seg('open', 300, 260, now), seg('working', 260, 180, now), seg('p_user', 180, null, now)] },
    ].map((t, i) => ({ ...t, id: 'INC-' + (2039 + i) } as Ticket & { id: string })),
  };

  const leasys: TenantData = {
    id: 'leasys', name: 'Diglo Leasys', key: 'leasys', active: true,
    members: [
      { uid: 'u-javier', email: 'jquesada@digloservicer.com', name: 'Javier Quesada', color: '#15803d', role: 'tenant_admin', status: 'active', external: false },
      { uid: 'u-marta', email: 'marta@leasys.com', name: 'Marta Ruiz', color: '#4338ca', role: 'technician', status: 'active', external: true },
      { uid: 'u-cli', email: 'cliente@leasys.com', name: 'Cliente Leasys', color: '#64748b', role: 'requester', status: 'active', external: true },
    ],
    lifecycles: [leasysLc], templates: [
      { id: 'tpl-lea', type: 'service_request', name: 'Petición de cliente', lifecycleId: 'lc-lea', slaId: null, fields: ['subject', 'description', 'priority'] },
    ], slas: itSlas,
    groups: [{ id: 'g-lea', name: 'Atención Leasys' }],
    categories: LEASYS_CATEGORIES,
    capacity: { 'u-javier': { used: 24, cap: 40 }, 'u-marta': { used: 36, cap: 40 } },
    counter: 75,
    tickets: [
      { type: 'service_request', subject: 'Cambio de datos de facturación', description: 'Actualizar CIF y dirección fiscal.', requesterId: 'u-cli', technicianId: 'u-javier', groupId: 'g-lea', category: 'Facturación', priority: 'medium', impact: 'user', templateId: 'tpl-lea', status: 'working', slaId: 'sla-med', statusHistory: [seg('received', 200, 160, now), seg('working', 160, null, now)] } as Ticket,
    ].map((t) => ({ ...t, id: 'SR-0071' })),
  };

  return { tenants: [it, leasys], platformAdmins: ['u-admin'] };
}
