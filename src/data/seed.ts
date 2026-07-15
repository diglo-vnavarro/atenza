// Datos semilla del piloto (local-first). Dos instancias, reflejando la
// realidad de Diglo: una interna completa y un cliente externo (Leasys).
import type { Lifecycle, Template, Sla, Ticket, StatusSegment, StatusDef, NotifRule, AppNotification, ReplyTemplate, FieldDef } from '../model.js';

// Catálogo de campos adicionales (ad-hoc) de ejemplo para diglo-it.
export const DEFAULT_CUSTOM_FIELDS: FieldDef[] = [
  { id: 'cf-tel', label: 'Teléfono de contacto', type: 'text', requesterVisible: true },
  { id: 'cf-ubi', label: 'Ubicación / planta', type: 'text', requesterVisible: true },
  { id: 'cf-activo', label: 'Nº de activo (CI)', type: 'text', requesterVisible: false },
  { id: 'cf-cliente', label: 'Cliente afectado', type: 'select', requesterVisible: true },
];
import type { ClosureRules } from '../closure.js';
import { DEFAULT_CLOSURE_RULES } from '../closure.js';
import type { BusinessRule } from '../rules.js';
import type { FormRule } from '../formrules.js';
import { madridHolidayDates } from '../holidays.js';
import type { Webhook } from '../webhooks.js';
import type { KbArticle } from '../kb.js';
import type { Announcement } from '../announce.js';
import type { AuditEntry } from '../audit.js';

export const DEFAULT_ANNOUNCEMENTS: Announcement[] = [
  { id: 'an-mant', title: 'Mantenimiento de la VPN el sábado', body: 'El sábado de 08:00 a 10:00 la VPN estará en mantenimiento. Puede haber cortes breves de acceso remoto.', audience: 'all', authorName: 'Vicente Navarro', at: 1_781_500_000_000 },
];

// Base de conocimiento de ejemplo (diglo-it).
const T0 = 1_781_000_000_000;
export const DEFAULT_KB_ARTICLES: KbArticle[] = [
  { id: 'kb-vpn', title: 'Cómo conectarse a la VPN corporativa', category: 'Redes', tags: ['vpn', 'acceso remoto'], status: 'published', authorName: 'Elena Andrés', createdAt: T0, updatedAt: T0, views: 42,
    body: 'Abre el cliente FortiClient, selecciona el perfil «Diglo», introduce tu usuario de dominio y pulsa Conectar. Si falla, comprueba que tienes conexión a internet y que tu contraseña de dominio no ha caducado.' },
  { id: 'kb-pwd', title: 'Restablecer la contraseña de dominio', category: 'Cuentas', tags: ['contraseña', 'acceso'], status: 'published', authorName: 'Óscar Igualada', createdAt: T0, updatedAt: T0, views: 118,
    body: 'Desde el portal de autoservicio, pulsa «He olvidado mi contraseña» e sigue los pasos. La nueva contraseña debe tener 12+ caracteres, mayúsculas, minúsculas y un número.' },
  { id: 'kb-firma', title: 'Configurar la firma de correo', category: 'Correo', tags: ['firma', 'outlook'], status: 'draft', authorName: 'Sergio Frías', createdAt: T0, updatedAt: T0,
    body: 'Borrador: pasos para poner la firma corporativa en Outlook y Gmail. (Pendiente de revisión.)' },
];

// Regla de negocio de ejemplo (diglo-it): enruta las incidencias de Redes al
// grupo Redes al crearlas. El admin la edita/añade en Automatización.
export const DEFAULT_BUSINESS_RULES: BusinessRule[] = [
  { id: 'br-redes', name: 'Incidencias de Redes → grupo Redes', enabled: true, match: 'all',
    conditions: [{ field: 'category', op: 'contains', value: 'Red' }], actions: [{ type: 'setGroup', value: 'g-red' }] },
];

// Reglas del formulario por defecto (demo sobre la plantilla de incidencia):
// si el usuario es VIP, el Nº de activo pasa a obligatorio.
export const DEFAULT_FORM_RULES: FormRule[] = [
  // Clásico: por plantilla.
  { id: 'fr-vip', name: 'Nº de activo obligatorio para usuarios VIP', enabled: true, templateIds: ['tpl-inc'], scope: 'both', match: 'all',
    conditions: [{ fieldId: 'fd-vip', op: 'eq', value: 'true' }], actions: [{ type: 'mandatory', fieldId: 'fd-asset' }] },
  // Simplificado: por categoría de servicio (demo sobre «BI / Datos»).
  { id: 'fr-bi', name: 'Periodicidad obligatoria si se indica informe', enabled: true, templateIds: [], serviceCategoryIds: ['sc-bi'], scope: 'both', match: 'all',
    conditions: [{ fieldId: 'cf-inf', op: 'notempty' }], actions: [{ type: 'mandatory', fieldId: 'cf-per' }] },
];

// Respuestas predefinidas por defecto (el admin las edita).
export const DEFAULT_REPLY_TEMPLATES: ReplyTemplate[] = [
  { id: 'rt-recibida', title: 'Solicitud recibida', body: 'Hemos recibido tu solicitud y la estamos revisando. Te mantendremos informado.' },
  { id: 'rt-info', title: 'Solicitar más información', body: 'Para poder avanzar necesitamos algún dato más. ¿Podrías indicarnos los pasos para reproducir el problema?' },
  { id: 'rt-resuelta', title: 'Solicitud resuelta', body: 'Hemos resuelto tu solicitud. Si el problema persiste, responde a este mensaje y la reabriremos.' },
];

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

// Roles y capacidades. Cada rol mapea a un NIVEL BASE (el que gobierna las reglas
// de Firestore: admin/técnico/solicitante) + capacidades de app (gobiernan la UI).
export type RoleBase = 'tenant_admin' | 'technician' | 'requester';
export type Cap = 'viewAllTickets' | 'assign' | 'changeStatus' | 'close' | 'manageConfig' | 'manageUsers' | 'viewReports';
export const CAP_LIST: [Cap, string][] = [
  ['viewAllTickets', 'Ver todas las solicitudes'], ['assign', 'Asignar técnico'], ['changeStatus', 'Cambiar estado'],
  ['close', 'Cerrar / resolver'], ['viewReports', 'Ver panel / informes'], ['manageUsers', 'Gestionar usuarios'],
  ['manageConfig', 'Administrar configuración'],
];
export const DEFAULT_CAPS: Record<RoleBase, Cap[]> = {
  tenant_admin: CAP_LIST.map((c) => c[0]),
  technician: ['viewAllTickets', 'assign', 'changeStatus', 'close', 'viewReports'],
  requester: [],
};
export interface RoleDef { name: string; base: RoleBase; caps?: Cap[] }

/** Capacidades EFECTIVAS de un miembro = caps del rol nombrado (si las define),
 *  si no, las por defecto de su nivel base. Se denormalizan al doc del miembro
 *  para que firestore.rules las pueda enforcar. */
export function memberCaps(m: { role: RoleBase; roleName?: string }, roles: RoleDef[] | undefined): Cap[] {
  const rd = m.roleName ? (roles ?? []).find((r) => r.name === m.roleName) : undefined;
  return rd?.caps ?? DEFAULT_CAPS[rd?.base ?? m.role];
}
const ROLE_BASE: Record<string, RoleBase> = { SDAdmin: 'tenant_admin', SDSiteAdmin: 'tenant_admin', HelpdeskConfig: 'tenant_admin', SDGuest: 'requester' };
export const SDP_ROLES: RoleDef[] = ['AnnouncementConfig', 'AssetConfig', 'ContractConfig', 'HelpdeskConfig', 'PurchaseConfig', 'RolTecnicosReclamaciones', 'SDAdmin', 'SDAssetAuditAdmin', 'SDAssetAuditor', 'SDAssetManager', 'SDCo-ordinator', 'SDGuest', 'SDMaintenanceManager', 'SDRemoteControl', 'SDReport', 'SDSiteAdmin', 'Técnicos externos']
  .map((name) => ({ name, base: ROLE_BASE[name] ?? 'technician' }));

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

// Calendario laboral: días de la semana trabajados (0=Dom … 6=Sáb) + franja
// horaria + festivos (fechas ISO YYYY-MM-DD). El SLA solo consume dentro de esta
// franja los días laborables (ver sla.ts).
export interface BusinessHours { days: number[]; start: string; end: string }
export const DEFAULT_BUSINESS_HOURS: BusinessHours = { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' };
// Festivos REALES de Madrid (nacionales + Comunidad + capital), calculados con la
// lógica portada de OrganiZate (Pascua incluida) para el rango vigente.
export const DEFAULT_HOLIDAYS: string[] = madridHolidayDates([2025, 2026, 2027]);

// Matriz de prioridades: Impacto × Urgencia → Prioridad. Por defecto se calcula
// por "banda" (a mayor impacto+urgencia, mayor prioridad); el admin la edita.
export type PriorityMatrix = Record<string, Record<string, string>>;
function buildPriorityMatrix(): PriorityMatrix {
  const imp = ['Afecta a usuario', 'Afecta a un grupo', 'Afecta a departamento', 'Afecta a negocio'];
  const urg = ['Bajo', 'Normal', 'Alta', 'Urgente'];
  const band = ['Baja', 'Baja', 'Media', 'Importante', 'Alta', 'Critica', 'Critica'];
  const m: PriorityMatrix = {};
  imp.forEach((iN, ii) => { m[iN] = {}; urg.forEach((uN, ui) => { m[iN]![uN] = band[ii + ui]!; }); });
  return m;
}
export const DEFAULT_PRIORITY_MATRIX = buildPriorityMatrix();

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
  /** grupos de usuarios (perfilado de catálogo: qué plantillas ve). */
  userGroups?: string[];
  /** rol granular (nombre del catálogo de roles del tenant); role sigue siendo el nivel base. */
  roleName?: string;
  /** capacidades DENORMALIZADAS del rol, para que las reglas de servidor las enforcen
   *  (se re-derivan al cambiar el rol del miembro o la config de roles). */
  caps?: Cap[];
  /** datos maestros del solicitante. */
  site?: string;
  department?: string;
  /** traspaso escalonado: true = habilitado para trabajar en Atenza (si no, sigue en SDP).
   *  En la fase de convivencia es informativo/preparatorio; gobierna el corte cuando llegue. */
  enabled?: boolean;
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
  /** matriz Impacto × Urgencia → Prioridad. */
  priorityMatrix?: PriorityMatrix;
  /** calendario laboral (para el SLA por horario) + festivos. */
  businessHours?: BusinessHours;
  holidays?: string[];
  /** datos maestros: sedes y departamentos (nombres). */
  sites?: string[];
  departments?: string[];
  /** grupos de usuarios (para el ACL de catálogo). */
  userGroups?: string[];
  /** catálogo de roles (nombre → nivel base + capacidades). */
  roles?: RoleDef[];
  /** reglas de notificación (evento → canal por destinatario). */
  notifRules?: NotifRule[];
  /** avisos en pantalla (por destinatario); en la nube es una colección. */
  notifications?: AppNotification[];
  /** reglas de cierre (requisitos para pasar a Resuelta/Cerrada). */
  closureRules?: ClosureRules;
  /** respuestas predefinidas (para insertar en el hilo). */
  replyTemplates?: ReplyTemplate[];
  /** reglas de negocio (condición → acción al crear el ticket). */
  businessRules?: BusinessRule[];
  /** reglas del formulario (mostrar/ocultar/obligar campos según valores). */
  formRules?: FormRule[];
  /** webhooks salientes (activadores hacia terceros). */
  webhooks?: Webhook[];
  /** base de conocimiento (Soluciones). */
  kbArticles?: KbArticle[];
  /** catálogo de campos adicionales (ad-hoc) del tenant, reutilizables en formularios. */
  customFields?: FieldDef[];
  /** icono (emoji) por categoría de servicio (para el catálogo de «Nueva solicitud»). */
  serviceCategoryIcons?: Record<string, string>;
  /** ids de grupos de soporte cuyas tareas se sincronizan con OrganiZate (carga). */
  organizateGroupIds?: string[];
  /** anuncios globales (banner). */
  announcements?: Announcement[];
  /** registro de auditoría (append-only; en la nube es subcolección). */
  audit?: AuditEntry[];
  /** recepción de correo entrante activada (por instancia). false/undefined = inerte. */
  inboundEnabled?: boolean;
  /** MODO SIMPLIFICADO (2ª versión): catálogo de categorías de servicio como eje
   *  (1 plantilla + Tipo + Categoría). Convive con las plantillas clásicas. */
  serviceCategories?: ServiceCategoryDef[];
  /** modo de operación de la instancia. 'classic' = plantillas SDP (por defecto);
   *  'simplified' = 1 plantilla + categoría-eje. Conmutable; mismo backend. */
  operationMode?: 'classic' | 'simplified';
  capacity: Record<string, Capacity>; counter: number;
}
export interface DB { tenants: TenantData[]; platformAdmins: string[] }

/** Categoría de servicio (Modo simplificado): el eje del sistema. Define qué tipos
 *  admite y su ciclo por tipo, quién la ve (permiso por grupo) y sus campos propios
 *  (se muestran en la sección «Campos de la categoría» de la plantilla única). */
export interface ServiceCategoryDef {
  id: string;
  name: string;
  /** presencia de la clave = tipo permitido; lifecycleId null = sin flujo (estado libre). */
  incident?: { lifecycleId: string | null };
  service_request?: { lifecycleId: string | null };
  /** grupos de usuario con acceso (vacío/ausente = todos la ven). */
  userGroups?: string[];
  /** campos específicos de la categoría (además de los comunes de la plantilla). */
  fields?: FieldDef[];
  /** icono (emoji) para el catálogo. */
  icon?: string;
}

// Campo de categoría (helper): sección «Campos de la categoría», visible al solicitante.
const scf = (id: string, label: string, type: FieldDef['type'], mandatory = false, col: 1 | 2 = 1): FieldDef =>
  ({ id, label, type, mandatory, requesterVisible: true, section: 'Campos de la categoría', col });

// Mapa aprobado (Opción A): categorías al grano, ciclo por tipo, permisos por grupo,
// campos propios. Ids de ciclo del seed: lc-inc (incidencia), lc-sr (con aprobación),
// lc-alta (usuarios), lc-ops (operaciones); null = sin flujo (estado libre).
export const DEFAULT_SERVICE_CATEGORIES: ServiceCategoryDef[] = [
  { id: 'sc-inc', name: 'Incidencias generales', icon: '🛠️', incident: { lifecycleId: 'lc-inc' },
    fields: [scf('cf-app', 'Aplicación afectada', 'text', false, 1), scf('cf-repro', '¿Reproducible?', 'bool', false, 2)] },
  { id: 'sc-reclam', name: 'Reclamaciones de clientes', icon: '📣', incident: { lifecycleId: 'lc-inc' }, userGroups: ['UsuariosReclamaciones'],
    fields: [scf('cf-exp', 'Nº de expediente', 'text', true, 1), scf('cf-cli', 'Cliente', 'text', false, 2)] },
  { id: 'sc-recovery', name: 'Recovery', icon: '🔧', incident: { lifecycleId: 'lc-inc' }, service_request: { lifecycleId: null },
    fields: [scf('cf-sys', 'Sistema', 'text', false, 1)] },
  { id: 'sc-bi', name: 'BI / Datos', icon: '📊', incident: { lifecycleId: 'lc-inc' }, service_request: { lifecycleId: null }, userGroups: ['Usuarios  BI'],
    fields: [scf('cf-inf', 'Informe / vista', 'text', false, 1), scf('cf-per', 'Periodicidad', 'select', false, 2)] },
  { id: 'sc-pd', name: 'PD', icon: '🗂️', incident: { lifecycleId: 'lc-inc' }, service_request: { lifecycleId: null }, userGroups: ['Usuarios PD'],
    fields: [scf('cf-mod', 'Módulo PD', 'text', false, 1)] },
  { id: 'sc-gemini', name: 'AI · Gemini', icon: '✨', incident: { lifecycleId: 'lc-inc' }, service_request: { lifecycleId: null },
    fields: [scf('cf-uso', 'Caso de uso', 'textarea', false, 1)] },
  { id: 'sc-informes', name: 'Informes (Looker/Google)', icon: '📈', service_request: { lifecycleId: null },
    fields: [scf('cf-panel', 'Panel / vista', 'text', false, 1)] },
  { id: 'sc-alta', name: 'Alta de usuario', icon: '👤', service_request: { lifecycleId: 'lc-alta' }, userGroups: ['Usuarios RRHH'],
    fields: [scf('cf-nom', 'Nombre', 'text', true, 1), scf('cf-ape', 'Apellidos', 'text', true, 2), scf('cf-nif', 'NIF/CIF', 'text', true, 1), scf('cf-dep', 'Departamento', 'select', true, 2), scf('cf-inc2', 'Fecha de incorporación', 'date', true, 1)] },
  { id: 'sc-baja', name: 'Baja de usuario', icon: '🚪', service_request: { lifecycleId: 'lc-alta' }, userGroups: ['Usuarios RRHH'],
    fields: [scf('cf-usr', 'Usuario a dar de baja', 'person', true, 1), scf('cf-fbaja', 'Fecha de baja', 'date', true, 2), scf('cf-equip', 'Equipamiento a devolver', 'text', false, 1)] },
  { id: 'sc-modif', name: 'Modificación / alta externos', icon: '👥', service_request: { lifecycleId: 'lc-alta' },
    fields: [scf('cf-usr2', 'Usuario', 'person', true, 1), scf('cf-cambio', 'Cambio solicitado', 'textarea', true, 1)] },
  { id: 'sc-pet', name: 'Peticiones generales', icon: '📥', service_request: { lifecycleId: null },
    fields: [scf('cf-det', 'Detalle de la petición', 'textarea', false, 1)] },
  { id: 'sc-waiver', name: 'Waiver', icon: '📝', service_request: { lifecycleId: 'lc-sr' },
    fields: [scf('cf-just', 'Justificación', 'textarea', true, 1), scf('cf-coste', 'Coste estimado', 'number', false, 2)] },
  { id: 'sc-ops', name: 'Operaciones · Liquidaciones deuda', icon: '💶', service_request: { lifecycleId: 'lc-ops' }, userGroups: ['Usuarios Operaciones'],
    fields: [scf('cf-ope', 'Expediente', 'text', true, 1), scf('cf-imp', 'Importe', 'number', false, 2)] },
  { id: 'sc-reo', name: 'Tareas REO', icon: '🏠', incident: { lifecycleId: 'lc-inc' }, service_request: { lifecycleId: null } },
  { id: 'sc-seg', name: 'Seguimiento Infoser/Diglo', icon: '🔎', service_request: { lifecycleId: null }, userGroups: ['Infoser'] },
];

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

const IT_USER_GROUPS = ['Todos los empleados', 'Operaciones', 'Recuperaciones', 'REO', 'Dirección', 'Externos'];
const IT_SITES = ['Madrid - Sede central', 'Barcelona', 'Valencia', 'Remoto'];
const IT_DEPARTMENTS = ['Tecnología', 'Operaciones', 'Recuperaciones', 'REO', 'Riesgos', 'RRHH', 'Finanzas', 'Legal'];
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
      { uid: 'u-admin', email: 'vnavarro@digloservicer.com', name: 'Vicente Navarro', color: '#4f46e5', role: 'tenant_admin', status: 'active', external: false, roleName: 'SDAdmin', groupIds: ['g-n1', 'g-red'], site: 'Madrid - Sede central', department: 'Sistemas', userGroups: ['Todos los empleados'], enabled: true },
      { uid: 'u-elena', email: 'eandres@digloservicer.com', name: 'Elena Andrés', color: '#0f766e', role: 'technician', status: 'active', external: false, roleName: 'SDCo-ordinator', groupIds: ['g-n1'], site: 'Madrid - Sede central', department: 'Soporte a usuarios', userGroups: ['Todos los empleados'], enabled: true },
      { uid: 'u-oscar', email: 'oigualada@digloservicer.com', name: 'Óscar Igualada', color: '#b45309', role: 'technician', status: 'active', external: false, roleName: 'SDCo-ordinator', groupIds: ['g-n2'], site: 'Barcelona', department: 'Soporte a usuarios' },
      { uid: 'u-sergio', email: 'sfrias@digloservicer.com', name: 'Sergio Frías', color: '#0369a1', role: 'technician', status: 'active', external: false, roleName: 'SDCo-ordinator', groupIds: ['g-red'], site: 'Madrid - Sede central', department: 'Redes y Comunicaciones' },
      { uid: 'u-bea', email: 'bcabado@digloservicer.com', name: 'Beatriz Cabado', color: '#be185d', role: 'technician', status: 'active', external: false, roleName: 'SDCo-ordinator', groupIds: ['g-n1', 'g-n2'], site: 'Valencia', department: 'Soporte a usuarios' },
      { uid: 'u-laura', email: 'laura.gomez@digloservicer.com', name: 'Laura Gómez', color: '#7c3aed', role: 'requester', status: 'active', external: false, site: 'Madrid - Sede central', department: 'Operaciones', userGroups: ['Todos los empleados', 'Operaciones'] },
    ],
    lifecycles: [rlc, srLc, iamLc, opsLc], templates: [
      { id: 'tpl-inc', type: 'incident', name: 'Incidencia', lifecycleId: 'lc-inc', slaId: null, fields: ['subject', 'description', 'category', 'priority', 'impact'],
        fieldDefs: [
          { id: 'fd-req', label: 'Solicitante', type: 'person', mandatory: true, requesterVisible: true, section: 'Detalles del solicitante', col: 1 },
          { id: 'fd-site', label: 'Sede', type: 'select', requesterVisible: true, section: 'Detalles del solicitante', col: 2 },
          { id: 'fd-subj', label: 'Asunto', type: 'text', mandatory: true, requesterVisible: true, section: 'Detalles de la solicitud', col: 1, full: true },
          { id: 'fd-cat', label: 'Categoría', type: 'select', mandatory: true, requesterVisible: true, section: 'Detalles de la solicitud', col: 1 },
          { id: 'fd-pri', label: 'Prioridad', type: 'select', mandatory: true, requesterVisible: true, section: 'Detalles de la solicitud', col: 2 },
          { id: 'fd-imp', label: 'Impacto', type: 'select', requesterVisible: true, section: 'Detalles de la solicitud', col: 1 },
          { id: 'fd-urg', label: 'Urgencia', type: 'select', requesterVisible: true, section: 'Detalles de la solicitud', col: 2 },
          { id: 'fd-desc', label: 'Descripción', type: 'textarea', mandatory: true, requesterVisible: true, section: 'Detalles de la solicitud', full: true },
          { id: 'fd-asset', label: 'Nº de activo', type: 'text', requesterVisible: true, section: 'Información adicional', col: 1 },
          { id: 'fd-vip', label: 'Usuario VIP', type: 'bool', requesterVisible: false, section: 'Información adicional', full: true },
        ],
        taskTemplates: [
          { id: 'tt-diag', text: 'Diagnóstico inicial' },
          { id: 'tt-fix', text: 'Aplicar solución' },
          { id: 'tt-verify', text: 'Verificar con el usuario', type: 'Seguimiento' },
        ],
        checklist: [
          { id: 'ck-doc', text: 'Solución documentada en el ticket' },
          { id: 'ck-user', text: 'Usuario notificado de la resolución' },
        ], checklistGate: true },
      { id: 'tpl-sr', type: 'service_request', name: 'Solicitud de servicio', lifecycleId: 'lc-sr', slaId: null, fields: ['subject', 'description', 'category', 'priority'],
        approvalLevels: [
          { id: 'al-resp', name: 'Visto bueno del responsable', approverUids: ['u-admin'], rule: 'any' },
          { id: 'al-dir', name: 'Aprobación de dirección', approverUids: ['u-elena'], rule: 'all' },
        ] },
    ], slas: itSlas,
    groups: [{ id: 'g-n1', name: 'Soporte N1' }, { id: 'g-n2', name: 'Soporte N2' }, { id: 'g-red', name: 'Redes' }],
    categories: IT_CATEGORIES, categoryTree: IT_CAT_TREE, statuses: SDP_STATUSES, picklists: SDP_PICKLISTS, priorityMatrix: DEFAULT_PRIORITY_MATRIX, businessHours: DEFAULT_BUSINESS_HOURS, holidays: DEFAULT_HOLIDAYS, sites: IT_SITES, departments: IT_DEPARTMENTS, userGroups: IT_USER_GROUPS, roles: SDP_ROLES, notifRules: DEFAULT_NOTIF_RULES, notifications: [], closureRules: DEFAULT_CLOSURE_RULES, replyTemplates: DEFAULT_REPLY_TEMPLATES, businessRules: DEFAULT_BUSINESS_RULES, formRules: DEFAULT_FORM_RULES, webhooks: [], kbArticles: DEFAULT_KB_ARTICLES, announcements: DEFAULT_ANNOUNCEMENTS, customFields: DEFAULT_CUSTOM_FIELDS,
    serviceCategoryIcons: { 'Incidencias': '🛠️', 'Solicitudes de servicio': '📥' },
    organizateGroupIds: ['g-n1'],
    serviceCategories: DEFAULT_SERVICE_CATEGORIES, operationMode: 'classic',
    capacity: {
      'u-elena': { used: 34, cap: 40 }, 'u-oscar': { used: 41, cap: 40 },
      'u-sergio': { used: 19, cap: 40 }, 'u-bea': { used: 0, cap: 40, off: 'Vacaciones' },
      'u-admin': { used: 30, cap: 40 },
    },
    counter: 2042,
    tickets: [
      { type: 'incident', subject: 'VPN caída en la oficina de Madrid', description: 'Varios usuarios no pueden conectar a la VPN desde esta mañana.', requesterId: 'u-laura', technicianId: null, groupId: 'g-red', category: 'Red', priority: 'Alta', impact: 'Afecta a departamento', urgency: 'Alta', mode: 'Llamada telefonica', site: 'Madrid - Sede central', templateId: 'tpl-inc', status: 'open', slaId: 'sla-high', statusHistory: [seg('open', 90, null, now)] },
      { type: 'incident', subject: 'Portátil no arranca tras actualización', description: 'Pantalla azul tras la actualización de Windows.', requesterId: 'u-laura', technicianId: 'u-elena', groupId: 'g-n1', category: 'Hardware', priority: 'Media', impact: 'Afecta a usuario', urgency: 'Normal', mode: 'Formulario Web', templateId: 'tpl-inc', status: 'p_user', slaId: 'sla-med', statusHistory: [seg('open', 300, 260, now), seg('working', 260, 180, now), seg('p_user', 180, null, now)] },
    ].map((t, i) => ({ ...t, id: 'INC-' + (2039 + i) } as Ticket & { id: string })),
  };

  const leasys: TenantData = {
    id: 'leasys', name: 'Diglo Leasys', key: 'leasys', active: true,
    members: [
      { uid: 'u-javier', email: 'jquesada@digloservicer.com', name: 'Javier Quesada', color: '#15803d', role: 'tenant_admin', status: 'active', external: false, roleName: 'SDAdmin', groupIds: ['g-lea'], site: 'Sede Leasys', department: 'Portal', userGroups: ['Gestores'], enabled: true },
      { uid: 'u-marta', email: 'marta@leasys.com', name: 'Marta Ruiz', color: '#4338ca', role: 'technician', status: 'active', external: true, roleName: 'SDCo-ordinator', groupIds: ['g-lea'], site: 'Remoto', department: 'Facturación', userGroups: ['Gestores'] },
      { uid: 'u-cli', email: 'cliente@leasys.com', name: 'Cliente Leasys', color: '#64748b', role: 'requester', status: 'active', external: true, site: 'Remoto', department: 'Contratos', userGroups: ['Clientes Leasys'] },
    ],
    lifecycles: [leasysLc], templates: [
      { id: 'tpl-lea', type: 'service_request', name: 'Petición de cliente', lifecycleId: 'lc-lea', slaId: null, fields: ['subject', 'description', 'priority'] },
    ], slas: itSlas,
    groups: [{ id: 'g-lea', name: 'Atención Leasys' }],
    categories: LEASYS_CATEGORIES, categoryTree: LEASYS_CAT_TREE, statuses: SDP_STATUSES, picklists: SDP_PICKLISTS, priorityMatrix: DEFAULT_PRIORITY_MATRIX, businessHours: DEFAULT_BUSINESS_HOURS, holidays: DEFAULT_HOLIDAYS, sites: ['Sede Leasys', 'Remoto'], departments: ['Portal', 'Facturación', 'Contratos'], userGroups: ['Clientes Leasys', 'Gestores'], roles: SDP_ROLES, notifRules: DEFAULT_NOTIF_RULES, notifications: [], closureRules: DEFAULT_CLOSURE_RULES, replyTemplates: DEFAULT_REPLY_TEMPLATES, businessRules: [], webhooks: [], kbArticles: [], announcements: [], customFields: [],
    capacity: { 'u-javier': { used: 24, cap: 40 }, 'u-marta': { used: 36, cap: 40 } },
    counter: 75,
    tickets: [
      { type: 'service_request', subject: 'Cambio de datos de facturación', description: 'Actualizar CIF y dirección fiscal.', requesterId: 'u-cli', technicianId: 'u-javier', groupId: 'g-lea', category: 'Facturación', priority: 'Media', impact: 'Afecta a usuario', urgency: 'Normal', mode: 'E-Mail', templateId: 'tpl-lea', status: 'working', slaId: 'sla-med', statusHistory: [seg('received', 200, 160, now), seg('working', 160, null, now)] } as Ticket,
    ].map((t) => ({ ...t, id: 'SR-0071' })),
  };

  return { tenants: [it, leasys], platformAdmins: ['u-admin'] };
}
