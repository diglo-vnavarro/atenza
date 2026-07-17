// ============================================================================
// Modelo de datos multi-tenant del ITSM propio (PROTOTIPO)
//
//   tenants/{tenantId}
//     ├─ members/{uid}                 pertenencia + rol EN ESTE tenant
//     ├─ tickets/{ticketId}
//     │    ├─ conversations/{id}
//     │    ├─ worklog/{id}
//     │    └─ attachments/{id}
//     ├─ catalog/{id}    slas/{id}    workflows/{id}    groups/{id}    approvals/{id}
//   userTenants/{uid}                  índice: a qué tenants pertenece cada uid
//   platformAdmins/{uid}               superadmin de Diglo (fuera de tenant)
// ============================================================================

/** Rol de una persona DENTRO de un tenant concreto. */
export type Role = 'tenant_admin' | 'technician' | 'requester';

export type MemberStatus = 'active' | 'invited' | 'disabled';

/** Solicitud de ACCESO de alguien que entró sin ficha (no invitado). Vive en la
 *  colección top-level accessRequests/{uid}; el admin la aprueba (crea el miembro)
 *  o la rechaza. Alimenta la bandeja de aprobaciones + la alerta de la campana. */
export interface AccessRequest {
  uid: string;
  email: string;
  name?: string;
  at: number;
  note?: string;
}

export type TicketType = 'incident' | 'service_request';

/** Estados TERMINALES que archivan el ticket (sale de la bandeja en vivo → Archivo). */
export const ARCHIVE_STATUSES = ['Cerrada', 'Cancelada', 'Resuelta'];
export const isArchivedStatus = (status: string | undefined): boolean => !!status && ARCHIVE_STATUSES.includes(status);

/** Documento de pertenencia: tenants/{tenantId}/members/{uid} */
export interface Member {
  uid: string;
  email: string;
  role: Role;
  status: MemberStatus;
  /** true si la persona es externa al dominio corporativo (cliente). */
  external: boolean;
  /** colas de soporte a las que pertenece (solo relevante para técnicos). */
  groupIds?: string[];
}

/** Documento de tenant: tenants/{tenantId} */
export interface Tenant {
  id: string;
  name: string;
  /** clave de portal / ruta, equivalente a lo que Zoho llama la instancia. */
  key: string;
  active: boolean;
}

/** Documento de ticket: tenants/{tenantId}/tickets/{ticketId} */
export interface Ticket {
  type: TicketType;
  subject: string;
  description?: string;
  requesterId: string;
  technicianId: string | null;
  groupId?: string | null;
  category?: string;
  subcategory?: string;
  item?: string;
  priority?: string;
  impact?: string;
  urgency?: string;
  level?: string;
  mode?: string;
  site?: string;
  /** correos a notificar (además del solicitante/técnico); como en SDP «Emails to notify». */
  notifyEmails?: string;
  /** detalles del impacto (SDP «impact_details»); texto libre opcional. */
  impactDetails?: string;
  /** activos / elementos afectados (SDP «assets»); texto libre LEGADO (import). Se
   *  mantiene por compatibilidad; la vinculación viva usa `assetIds`. */
  assets?: string;
  /** ids de activos afectados (módulo CMDB). Sustituye al texto libre `assets`. */
  assetIds?: string[];
  /** archivado = ticket en estado terminal (Cerrada/Cancelada/Resuelta). La bandeja
   *  en vivo solo suscribe archived=false; los archivados se ven en la vista Archivo.
   *  Imprescindible en TODOS los tickets vivos (Firestore no casa el campo ausente). */
  archived?: boolean;
  /** epoch ms de creación (para ordenar el archivo). Deriva de statusHistory[0].from. */
  createdAt?: number;
  /** plantilla/tipología concreta (define ciclo de vida y SLA aplicables). */
  templateId: string;
  /** Modo simplificado: categoría de servicio (eje) y su nombre para mostrar. */
  serviceCategoryId?: string;
  serviceCategory?: string;
  /** estado actual = clave de un estado del ciclo de vida (o texto libre si la plantilla no lleva flujo). */
  status: string;
  slaId?: string | null;
  responseDueAt?: number | null;
  resolveDueAt?: number | null;
  /** historial de estados, para calcular el tiempo que consume SLA. */
  statusHistory?: StatusSegment[];
  /** texto de resolución (pestaña Resolución). */
  resolution?: string;
  /** hilo de conversación (pestaña Conversaciones). */
  comments?: TicketComment[];
  /** subtareas / checklist (pestaña Tareas). */
  tasks?: TicketTask[];
  /** lista de comprobación instanciada desde la plantilla (verificación ligera). */
  checklist?: ChecklistItem[];
  /** registro de tiempo trabajado (pestaña Tiempo). */
  worklog?: WorkEntry[];
  /** solicitudes de aprobación (pestaña Aprobaciones). */
  approvals?: Approval[];
  /** ficheros adjuntos (pestaña Adjuntos). */
  attachments?: Attachment[];
  /** encuesta de satisfacción del solicitante al cierre. */
  survey?: Survey;
  /** valores de campos adicionales (UDF) del formulario, indexados por id de FieldDef. */
  udf?: Record<string, string>;
}

/** Encuesta de satisfacción (CSAT): valoración 1–5 del solicitante al resolverse. */
export interface Survey { rating: number; comment?: string; at: number }

/** Fichero adjunto. En la nube vive en Storage (`path`+`url`); en local va inline
 *  como data URL (`dataUrl`) para que la demo funcione sin backend. */
export interface Attachment {
  id: string;
  name: string;
  size: number;
  contentType?: string;
  path?: string;
  url?: string;
  dataUrl?: string;
  uploadedBy: string;
  uploadedByName: string;
  at: number;
}

/** Respuesta predefinida (texto reutilizable que el técnico inserta en el hilo). */
export interface ReplyTemplate { id: string; title: string; body: string }

export interface TicketComment { author: string; authorName: string; at: number; text: string; internal?: boolean }
export interface TicketTask { id: string; text: string; done: boolean; assigneeUid?: string | null; dueAt?: number | null; type?: string; estimatedHours?: number }
/** Tarea predefinida de una plantilla: se instancia como TicketTask al crear el
 *  ticket (checklist estándar de la tipología, como en SDP). */
export interface TaskTemplate { id: string; text: string; type?: string; estimatedHours?: number }
/** Nivel de aprobación predefinido de una plantilla: se instancia como Approval(s)
 *  al crear el ticket. `rule` = basta con uno (any) o deben aprobar todos (all). */
export interface ApprovalLevelDef { id: string; name: string; approverUids: string[]; rule: 'any' | 'all' }
/** Ítem de lista de comprobación predefinido de una plantilla (verificación ligera). */
export interface ChecklistItemDef { id: string; text: string }
/** Ítem de lista de comprobación instanciado en un ticket. */
export interface ChecklistItem { id: string; text: string; done: boolean; by?: string; at?: number }
/** Registro de tiempo trabajado en un ticket (alimenta la capacidad del técnico). */
export interface WorkEntry { id: string; techUid: string; techName: string; mins: number; at: number; note?: string }

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'waiting';
/** Solicitud de aprobación a una persona concreta (como SDP: nivel de aprobación con aprobadores). */
export interface Approval {
  id: string;
  approverUid: string;
  approverName: string;
  status: ApprovalStatus;
  requestedBy: string;
  requestedByName: string;
  requestedAt: number;
  /** motivo de la solicitud. */
  note?: string;
  decidedAt?: number;
  /** comentario de la decisión (aprobar/rechazar). */
  comment?: string;
  /** nivel de aprobación (1..n) cuando procede de la config de la plantilla. */
  level?: number;
}

// ---------------------------------------------------------------------------
// Ciclos de vida y SLA
//
// Diseño alineado con lo observado en ServiceDesk Plus:
//   - Hay varias TIPOLOGÍAS (incidencia, solicitud de servicio); cada plantilla
//     puede llevar un ciclo de vida (flujo con transiciones) o NO llevarlo
//     (estado libre).
//   - No todos los estados consumen SLA: un estado marcado `stopsSlaClock`
//     (p. ej. "En espera del usuario") PAUSA el reloj de SLA.
// ---------------------------------------------------------------------------

/** Fase macro del ticket, para agrupar estados e informes. */
export type Stage = 'open' | 'pending' | 'resolved' | 'closed';

/**
 * Categoría de temporizador de un estado — mismo concepto que ServiceDesk Plus
 * (leyenda "En curso / Detener temporizador / Completado"):
 *   - in_progress: el reloj de SLA CORRE (consume).
 *   - stop_timer:  el reloj se PAUSA (p. ej. "Pendiente del usuario", "Pendiente Banco").
 *   - completed:   trabajo terminado (Resuelta/Cerrada/Cancelada); el reloj no corre.
 * Es más fiel que un simple booleano: distingue "en pausa" de "completado".
 */
export type SlaCategory = 'in_progress' | 'stop_timer' | 'completed';

export interface LifecycleState {
  key: string;
  label: string;
  stage: Stage;
  category: SlaCategory;
  /** estado inicial al crear el ticket. */
  isInitial?: boolean;
  /** estado final: no admite más transiciones (p. ej. Cerrada). Ojo: "completed"
   *  no implica terminal — "Resuelta" está completada pero puede reabrirse. */
  isTerminal?: boolean;
}

/** Transición con identidad y nombre (como en SDP: "Abierta -TO- En espera"). */
export interface Transition {
  id: string;
  name: string;
  from: string;
  to: string;
}

export interface Lifecycle {
  id: string;
  name: string;
  /** los ciclos se versionan y se publican (borrador → publicado). */
  version: string;
  published: boolean;
  /** para qué tipología aplica. Un mismo ciclo puede reutilizarse en varias plantillas. */
  type: TicketType;
  states: LifecycleState[];
  transitions: Transition[];
}

export interface Template {
  id: string;
  type: TicketType;
  name: string;
  /** null = plantilla SIN flujo (estado libre, sin transiciones forzadas). */
  lifecycleId: string | null;
  slaId: string | null;
  /** etiquetas de campos (compat; se deriva de fieldDefs cuando existe). */
  fields: string[];
  /** definición completa de campos del formulario (constructor de formularios). */
  fieldDefs?: FieldDef[];
  /** tareas predefinidas: se instancian como checklist del ticket al crearlo. */
  taskTemplates?: TaskTemplate[];
  /** niveles de aprobación predefinidos: se instancian como aprobaciones al crear. */
  approvalLevels?: ApprovalLevelDef[];
  /** lista de comprobación predefinida: se instancia en el ticket al crear. */
  checklist?: ChecklistItemDef[];
  /** si true, no se puede resolver/cerrar hasta completar la lista de comprobación. */
  checklistGate?: boolean;
  /** agrupación del catálogo de creación (categoría de servicio de SDP). */
  group?: string;
  /** ¿visible para el solicitante en el catálogo de autoservicio? (false = solo staff). */
  showToRequester?: boolean;
  /** grupos de usuarios que pueden ver/usar la plantilla (vacío = todos). */
  userGroups?: string[];
}

/** Estado real del catálogo del tenant (los 15 de SDP): nombre + categoría de
 *  temporizador (consume/pausa/completado) + color. Fuente de verdad del SLA y del
 *  color/etiqueta que se muestra; el ciclo de vida gobierna las transiciones. */
export interface StatusDef {
  name: string;
  timer: SlaCategory;
  color: string;
  description?: string;
}

// ---------------------------------------------------------------------------
// Reglas de notificación: qué avisos se emiten en cada evento del ticket, por
// qué canal (pantalla / correo) y a quién (solicitante / técnico / grupo).
// ---------------------------------------------------------------------------
export type NotifEvent = 'created' | 'assigned' | 'status' | 'resolved' | 'comment' | 'internal_note' | 'sla_breach' | 'approval';
export interface NotifChannel { screen?: boolean; mail?: boolean }
export interface NotifRule {
  event: NotifEvent;
  requester: NotifChannel;
  technician: NotifChannel;
  group: NotifChannel;
}
/** Aviso en pantalla generado para un destinatario concreto (colección notifications). */
export interface AppNotification {
  id: string;
  at: number;
  event: NotifEvent;
  ticketId: string;
  subject: string;
  forUid: string;
  text: string;
  read?: boolean;
}

export type FieldType = 'text' | 'textarea' | 'select' | 'bool' | 'date' | 'number' | 'person' | 'attachment' | 'reference';
export interface FieldDef {
  id: string;
  label: string;
  type: FieldType;
  /** obligatorio al crear/resolver. */
  mandatory?: boolean;
  /** visible/editable para el solicitante (si no, solo lo ve el técnico). */
  requesterVisible?: boolean;
  /** maquetación del formulario: sección, columna (1=izq, 2=der) y ancho completo. */
  section?: string;
  col?: 1 | 2;
  full?: boolean;
  /** opciones para type 'select' (si faltan, se renderiza como texto libre). */
  options?: string[];
}

export interface Sla {
  id: string;
  name: string;
  /** objetivos en minutos de tiempo que consume SLA (no reloj de pared). */
  responseMins: number;
  resolveMins: number;
  businessHoursId?: string;
}

/** Tramo de permanencia en un estado. `to` null = tramo aún abierto. */
export interface StatusSegment {
  state: string;
  from: number; // epoch ms
  to: number | null;
}

// ============================================================================
// Activos / CMDB — inventario vivo y editable (módulo D). Cada activo vive en
// tenants/{tid}/assets/{id}. Se puede asignar a un miembro y vincular a tickets.
// ============================================================================
export type AssetStatus = 'in_use' | 'in_stock' | 'repair' | 'retired' | 'lost';
/** Estados del activo (clave · etiqueta · color de token). */
export const ASSET_STATUS: { key: AssetStatus; label: string; color: string }[] = [
  { key: 'in_use', label: 'En uso', color: 'var(--ok)' },
  { key: 'in_stock', label: 'En stock', color: 'var(--accent)' },
  { key: 'repair', label: 'En reparación', color: 'var(--warn)' },
  { key: 'retired', label: 'Retirado', color: 'var(--ink-faint)' },
  { key: 'lost', label: 'Extraviado', color: 'var(--crit)' },
];
export const assetStatusView = (s: string | undefined) => ASSET_STATUS.find((x) => x.key === s) ?? { key: 'in_stock' as AssetStatus, label: s || '—', color: 'var(--ink-soft)' };
/** Tipos de producto (categoría del activo). */
export const ASSET_TYPES = ['Portátil', 'Sobremesa', 'Monitor', 'Móvil', 'Tablet', 'Servidor', 'Impresora', 'Red', 'Periférico', 'Licencia SW', 'Otro'];

export interface Asset {
  id: string;
  name: string;
  /** etiqueta / asset tag (código de inventario). */
  tag?: string;
  /** tipo de producto (uno de ASSET_TYPES, o libre). */
  productType?: string;
  /** número de serie. */
  serial?: string;
  status: AssetStatus;
  /** uid del miembro al que está asignado (o null = sin asignar). */
  assignedTo?: string | null;
  site?: string;
  department?: string;
  /** fabricante. */
  vendor?: string;
  model?: string;
  purchaseDate?: number | null; // epoch ms
  warrantyUntil?: number | null; // epoch ms
  cost?: number | null;
  notes?: string;
  createdAt?: number;
  /** historial de cambios relevantes (alta · cambio de estado · asignación). */
  history?: AssetEvent[];
}

/** Evento del historial de un activo. `from`/`to` guardan claves/uids según el tipo. */
export interface AssetEvent {
  at: number; // epoch ms
  kind: 'create' | 'status' | 'assign';
  from?: string | null;
  to?: string | null;
}
