// Webhooks salientes (activadores hacia terceros: Slack/Teams/n8n…). Puro para la
// selección; el POST lo hace el store (fetch best-effort no-cors) en cada evento.
// En producción el disparo debería moverse a una Cloud Function sobre triggers de
// Firestore; en el piloto se dispara desde el cliente (mejor esfuerzo).
import type { NotifEvent } from './model.js';

export interface Webhook {
  id: string;
  name: string;
  enabled: boolean;
  url: string;
  events: NotifEvent[];
}

export interface WebhookPayload {
  event: NotifEvent;
  ticketId: string;
  subject: string;
  at: number;
  tenant: string;
}

/** Webhooks habilitados, con URL y suscritos a este evento. */
export function webhooksFor(hooks: Webhook[] | undefined, event: NotifEvent): Webhook[] {
  return (hooks ?? []).filter((h) => h.enabled && !!h.url && h.events.includes(event));
}
