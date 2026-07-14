// Registro de auditoría: traza append-only de acciones relevantes (quién, cuándo,
// qué). En la nube vive en la subcolección tenants/{tid}/audit; en local, en un
// array acotado. Tipos + etiquetas; el registro lo escribe el store.
export interface AuditEntry {
  id: string;
  at: number;
  actorUid: string;
  actorName: string;
  /** slug de acción, p. ej. 'ticket.status'. */
  action: string;
  /** id del objeto afectado (ticket, miembro…). */
  target?: string;
  /** resumen legible de lo ocurrido. */
  summary: string;
}

export const AUDIT_LABELS: Record<string, string> = {
  'ticket.create': 'Solicitud creada',
  'ticket.assign': 'Técnico asignado',
  'ticket.status': 'Cambio de estado',
  'ticket.resolve': 'Solicitud resuelta',
  'approval.decide': 'Aprobación decidida',
  'member.enable': 'Habilitación en Atenza',
  'kb.publish': 'Solución publicada',
  'config.change': 'Cambio de configuración',
};

export const auditLabel = (action: string): string => AUDIT_LABELS[action] ?? action;
