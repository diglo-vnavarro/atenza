// Datos semilla del piloto (local-first). Dos instancias, reflejando la
// realidad de Diglo: una interna completa y un cliente externo (Leasys).
import type { Lifecycle, Template, Sla, Ticket, StatusSegment, StatusDef, NotifRule, AppNotification } from '../model.js';

// Reglas de notificación por defecto (evento → canal por destinatario).
const S = { screen: true }, SM = { screen: true, mail: true }, X = {};
export const DEFAULT_NOTIF_RULES: NotifRule[] = [
  { event: 'created', requester: SM, technician: S, group: S },
  { event: 'assigned', requester: X, technician: SM, group: X },
  { event: 'status', requester: S, technician: S, group: X },
  { event: 'resolved', requester: SM, technician: X, group: X },
  { event: 'comment', requester: SM, technician: S, group: X },
  { event: 'internal_note', requester: X, technician: S, group: S },
  { event: 'sla_breach', requester: X, technician: SM, group: SM },
];

// Catálogos de valores del "customizer" de SDP (nombre + color opcional).
export interface PickVal { name: string; color?: string }
export interface Picklists { priority: PickVal[]; impact: PickVal[]; urgency: PickVal[]; level: PickVal[]; mode: PickVal[]; requestType: PickVal[]; taskType: PickVal[] }
export const SDP_PICKLISTS: Picklists = {
  priority: [
    { name: 'Critica', color: '#0d9696' }, { name: 'Alta', color: '#ff0000' }, { name: 'Importante', color: '#8f23eb' },
    { name: 'Media', color: '#0c8e48' }, { name: 'Baja', color: '#666666' },
  ],
  impact: [{ name: 'Afecta a usuario' }, { name: 'Afecta a un grupo' }, { name: 'Afecta a departamento' }, { name: 'Afecta a negocio' }],
  urgency: [{ name: 'Bajo' }, { name: 'Normal' }, { name: 'Alta' }, { name: 'Urgente' }],
  level: [{ name: 'Nivel 1' }, { name: 'Nivel 2' }, { name: 'Nivel 3' }, { name: 'Nivel 4' }],
  mode: [{ name: 'E-Mail' }, { name: 'Formulario Web' }, { name: 'Llamada telefonica' }, { name: 'Mobile Application' }],
  requestType: [{ name: 'Incidencia' }, { name: 'Peticion de servicio' }, { name: 'Solicitud de información' }],
  taskType: [
    { name: 'BI', color: '#955d0f' }, { name: 'Implementation', color: '#999900' }, { name: 'Install/UnInstall', color: '#666666' },
    { name: 'Interno', color: '#f02a2a' }, { name: 'Maintenance', color: '#ff6600' }, { name: 'NPL', color: '#697cf8' },
    { name: 'PD / Operaciones', color: '#4047ff' }, { name: 'Planning', color: '#ff66cc' }, { name: 'Release', color: '#00ff00' },
    { name: 'REO', color: '#f78718' }, { name: 'Replacement/Repair', color: '#ffff00' }, { name: 'Testing', color: '#990000' },
    { name: 'Troubleshooting', color: '#00ffcc' },
  ],
};

// Catálogo de los 15 estados reales de SDP (nombre · temporizador · color).
export const SDP_STATUSES: StatusDef[] = [
  { name: 'Abierta', timer: 'in_progress', color: '#4bb11d', description: 'Solicitud abierta' },
  { name: 'Asignado', timer: 'in_progress', color: '#4bb11d', description: 'Asignada a un técnico' },
  { name: 'Trabajando', timer: 'in_progress', color: '#f40080' },
  { name: 'En Proceso IT', timer: 'in_progress', color: '#5f149f' },
  { name: 'En espera', timer: 'stop_timer', color: '#4047ff', description: 'Solicitud en espera' },
  { name: 'Pendiente Aprobación', timer: 'stop_timer', color: '#ff80bf' },
  { name: 'Pendiente Banco', timer: 'stop_timer', color: '#f78718' },
  { name: 'Pendiente de terceros', timer: 'stop_timer', color: '#697cf8' },
  { name: 'Pendiente PFS', timer: 'stop_timer', color: '#cb6500' },
  { name: 'Pendiente Usuario', timer: 'stop_timer', color: '#3bb4ff' },
  { name: 'Planificado', timer: 'stop_timer', color: '#e036d5' },
  { name: 'Recurrente', timer: 'stop_timer', color: '#4a0564' },
  { name: 'Resuelta', timer: 'completed', color: '#00b050' },
  { name: 'Cerrada', timer: 'completed', color: '#83cb10' },
  { name: 'Cancelada', timer: 'completed', color: '#f02a2a' },
];

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
/** Jerarquía Categoría › Subcategoría › Artículo (como SDP). */
export interface CatSub { name: string; items: string[] }
export interface CatNode { name: string; subs: CatSub[] }
/** Ticket con su id (en Firestore el id es la clave del documento). */
export type StoredTicket = Ticket & { id: string };
export interface TenantData {
  id: string; name: string; key: string; active: boolean;
  members: UiMember[]; lifecycles: Lifecycle[]; templates: Template[];
  slas: Sla[]; groups: Group[]; tickets: StoredTicket[];
  /** lista plana (compat); se deriva de categoryTree cuando existe. */
  categories: string[];
  /** árbol Categoría › Subcategoría › Artículo. */
  categoryTree?: CatNode[];
  /** catálogo de estados reales (nombre · temporizador · color). */
  statuses?: StatusDef[];
  /** catálogos de valores (prioridad, impacto, urgencia, nivel, modo, tipos). */
  picklists?: Picklists;
  /** reglas de notificación (evento → canal por destinatario). */
  notifRules?: NotifRule[];
  /** avisos en pantalla (por destinatario); en la nube es una colección. */
  notifications?: AppNotification[];
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
const IT_CAT_TREE: CatNode[] = [
  { name: 'Aplicaciones', subs: [
    { name: 'Google Workspace', items: ['Calendar', 'Docs', 'Drive', 'Gmail', 'Meet', 'Sheets'] },
    { name: 'Microsoft Office', items: ['Word', 'Excel', 'Outlook', 'Teams'] },
    { name: 'Herramientas de negocio', items: ['CRM', 'ERP'] },
  ] },
  { name: 'Correo Electrónico', subs: [{ name: 'Buzones', items: ['Alta', 'Baja', 'Buzón compartido'] }, { name: 'Distribución', items: ['Listas'] }] },
  { name: 'Hardware', subs: [{ name: 'Equipo', items: ['Portátil', 'Sobremesa', 'Móvil'] }, { name: 'Periféricos', items: ['Monitor', 'Teclado', 'Impresora'] }] },
  { name: 'Redes', subs: [{ name: 'VPN', items: ['Acceso', 'Caída'] }, { name: 'WiFi', items: ['Cobertura'] }] },
  { name: 'Reclamaciones de Clientes', subs: [{ name: 'REO', items: ['Alta', 'Seguimiento'] }, { name: 'Recovery', items: ['Gestión'] }] },
];
const LEASYS_CAT_TREE: CatNode[] = [
  { name: 'Portal', subs: [{ name: 'Acceso', items: ['Alta usuario', 'Reset contraseña'] }, { name: 'Incidencias', items: ['Error de carga'] }] },
  { name: 'Facturación', subs: [{ name: 'Facturas', items: ['Duplicado', 'Rectificación'] }] },
  { name: 'Contratos', subs: [{ name: 'Alta', items: ['Nuevo contrato'] }, { name: 'Modificación', items: ['Cambio de datos'] }] },
];

const itSlas: Sla[] = [
  { id: 'sla-high', name: 'Alta (High)', responseMins: 30, resolveMins: 120 },
  { id: 'sla-med', name: 'Media (Medium)', responseMins: 60, resolveMins: 360 },
  { id: 'sla-low', name: 'Baja (Low)', responseMins: 240, resolveMins: 2880 },
];
export const SLA_BY_PRIORITY: Record<string, string> = { Critica: 'sla-high', Alta: 'sla-high', Importante: 'sla-med', Media: 'sla-med', Baja: 'sla-low' };

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
    categories: IT_CATEGORIES, categoryTree: IT_CAT_TREE, statuses: SDP_STATUSES, picklists: SDP_PICKLISTS, notifRules: DEFAULT_NOTIF_RULES, notifications: [],
    capacity: {
      'u-elena': { used: 34, cap: 40 }, 'u-oscar': { used: 41, cap: 40 },
      'u-sergio': { used: 19, cap: 40 }, 'u-bea': { used: 0, cap: 40, off: 'Vacaciones' },
      'u-admin': { used: 30, cap: 40 },
    },
    counter: 2042,
    tickets: [
      { type: 'incident', subject: 'VPN caída en la oficina de Madrid', description: 'Varios usuarios no pueden conectar a la VPN desde esta mañana.', requesterId: 'u-laura', technicianId: null, groupId: 'g-red', category: 'Red', priority: 'Alta', impact: 'Afecta a departamento', urgency: 'Alta', mode: 'Llamada telefonica', templateId: 'tpl-inc', status: 'open', slaId: 'sla-high', statusHistory: [seg('open', 90, null, now)] },
      { type: 'incident', subject: 'Portátil no arranca tras actualización', description: 'Pantalla azul tras la actualización de Windows.', requesterId: 'u-laura', technicianId: 'u-elena', groupId: 'g-n1', category: 'Hardware', priority: 'Media', impact: 'Afecta a usuario', urgency: 'Normal', mode: 'Formulario Web', templateId: 'tpl-inc', status: 'p_user', slaId: 'sla-med', statusHistory: [seg('open', 300, 260, now), seg('working', 260, 180, now), seg('p_user', 180, null, now)] },
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
    categories: LEASYS_CATEGORIES, categoryTree: LEASYS_CAT_TREE, statuses: SDP_STATUSES, picklists: SDP_PICKLISTS, notifRules: DEFAULT_NOTIF_RULES, notifications: [],
    capacity: { 'u-javier': { used: 24, cap: 40 }, 'u-marta': { used: 36, cap: 40 } },
    counter: 75,
    tickets: [
      { type: 'service_request', subject: 'Cambio de datos de facturación', description: 'Actualizar CIF y dirección fiscal.', requesterId: 'u-cli', technicianId: 'u-javier', groupId: 'g-lea', category: 'Facturación', priority: 'Media', impact: 'Afecta a usuario', urgency: 'Normal', mode: 'E-Mail', templateId: 'tpl-lea', status: 'working', slaId: 'sla-med', statusHistory: [seg('received', 200, 160, now), seg('working', 160, null, now)] } as Ticket,
    ].map((t) => ({ ...t, id: 'SR-0071' })),
  };

  return { tenants: [it, leasys], platformAdmins: ['u-admin'] };
}
