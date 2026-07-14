// Correo entrante → ticket (parser PURO y testeable). Detecta si el correo es una
// RESPUESTA a un ticket existente (id en el asunto, p. ej. "[INC-2039]") o uno
// NUEVO, y normaliza asunto/cuerpo. El transporte real (Cloud Function / Inbound
// Parse) y la ingesta (store.createFromEmail) usan esta función.
//
// IMPORTANTE: construir esto NO conecta ningún buzón. La recepción real se activa
// por instancia (interruptor `inboundEnabled` + redirigir el buzón) en el corte.

export interface InboundEmail { from: string; subject: string; body: string }
export interface ParsedInbound {
  /** id de ticket si es respuesta a uno existente (INC-1234 / SR-1234). */
  replyToId: string | null;
  /** asunto limpio (sin "Re:" ni el tag [ID]). */
  subject: string;
  body: string;
  fromEmail: string;
}

const ID_RE = /\b((?:INC|SR|REQ)-\d{2,})\b/i;

export function parseInbound(email: InboundEmail): ParsedInbound {
  const rawSubject = (email.subject ?? '').trim();
  const idMatch = rawSubject.match(ID_RE);
  const replyToId = idMatch ? idMatch[1]!.toUpperCase() : null;
  // quita el tag [INC-1234] o INC-1234 y los prefijos Re:/RE:/Rv:/Fwd:
  let subject = rawSubject
    .replace(/\[[^\]]*(?:INC|SR|REQ)-\d+[^\]]*\]/gi, '')
    .replace(ID_RE, '')
    .replace(/^(?:\s*(re|rv|fwd|fw)\s*:\s*)+/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!subject) subject = replyToId ? `Respuesta a ${replyToId}` : 'Solicitud por correo';
  return { replyToId, subject, body: (email.body ?? '').trim(), fromEmail: (email.from ?? '').trim().toLowerCase() };
}
