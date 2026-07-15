// ============================================================================
// Lógica de autorización — espejo EN TYPESCRIPT de firestore.rules.
//
// Sirve para dos cosas:
//   1. Validar el MODELO de permisos con tests puros y rápidos (sin emulador).
//   2. Documentar, en un solo sitio legible, quién puede hacer qué.
//
// Las reglas de Firestore (firestore.rules) son la frontera de seguridad real;
// este fichero debe mantenerse alineado con ellas. El test de emulador
// (test/rules.emulator.ts) confirma que el fichero .rules implementa fielmente
// esta misma matriz.
// ============================================================================

import type { Role, MemberStatus, TicketType } from './model.js';

export interface Membership {
  role: Role;
  status: MemberStatus;
  /** capacidades denormalizadas del rol (opcional). Si faltan, se cae al nivel base. */
  caps?: string[];
}

/** Sujeto autenticado y sus pertenencias por tenant. */
export interface User {
  uid: string;
  platformAdmin?: boolean;
  /** tenantId -> pertenencia. Ausente = no es miembro de ese tenant. */
  memberships: Record<string, Membership>;
}

export interface TicketDoc {
  type: TicketType;
  requesterId: string;
  technicianId: string | null;
}

// ---- pertenencia y rol ------------------------------------------------------

export function isMember(u: User | null, tid: string): boolean {
  if (!u) return false;
  const m = u.memberships[tid];
  return !!m && m.status === 'active';
}

export function roleIn(u: User | null, tid: string): Role | null {
  if (!u) return null;
  const m = u.memberships[tid];
  return m && m.status === 'active' ? m.role : null;
}

export function isAdmin(u: User | null, tid: string): boolean {
  return roleIn(u, tid) === 'tenant_admin';
}

/** "Técnico" incluye a tenant_admin (superconjunto operativo sobre tickets). */
export function isTech(u: User | null, tid: string): boolean {
  const r = roleIn(u, tid);
  return r === 'technician' || r === 'tenant_admin';
}

export function isRequester(u: User | null, tid: string): boolean {
  return roleIn(u, tid) === 'requester';
}

export function isPlatformAdmin(u: User | null): boolean {
  return !!u?.platformAdmin;
}

/**
 * ¿Tiene el miembro esta capacidad? Si el documento trae `caps` (denormalizadas
 * del rol), se consultan; si NO las trae (miembros previos / seed), se cae al
 * nivel base: solo `tenant_admin` tiene capacidades de gestión. Este fallback
 * garantiza que endurecer las reglas NO bloquea a los administradores actuales.
 */
export function hasCap(u: User | null, tid: string, cap: string): boolean {
  if (!u) return false;
  const m = u.memberships[tid];
  if (!m || m.status !== 'active') return false;
  if (m.caps) return m.caps.includes(cap);
  return m.role === 'tenant_admin';
}

// ---- tenant -----------------------------------------------------------------

export function canReadTenant(u: User | null, tid: string): boolean {
  return isMember(u, tid) || isPlatformAdmin(u);
}

export function canUpdateTenant(u: User | null, tid: string): boolean {
  return hasCap(u, tid, 'manageConfig') || isPlatformAdmin(u);
}

export function canCreateTenant(u: User | null): boolean {
  return isPlatformAdmin(u);
}

// ---- miembros ---------------------------------------------------------------

export function canReadMember(u: User | null, tid: string): boolean {
  return isMember(u, tid) || isPlatformAdmin(u);
}

export function canManageMembers(u: User | null, tid: string): boolean {
  return hasCap(u, tid, 'manageUsers') || isPlatformAdmin(u);
}

// ---- tickets ----------------------------------------------------------------

export function canGetTicket(u: User | null, tid: string, t: TicketDoc): boolean {
  if (isPlatformAdmin(u)) return true;
  if (isTech(u, tid)) return true;
  return isMember(u, tid) && t.requesterId === u!.uid;
}

/** Listado libre: solo técnico/admin (ver limitación de `list` en las reglas). */
export function canListTickets(u: User | null, tid: string): boolean {
  return isTech(u, tid) || isPlatformAdmin(u);
}

export function canCreateTicket(u: User | null, tid: string, data: TicketDoc): boolean {
  if (!isMember(u, tid)) return false;
  if (data.type !== 'incident' && data.type !== 'service_request') return false;
  // El solicitante solo crea a su nombre; técnico/admin, en nombre de quien sea.
  return isTech(u, tid) || data.requesterId === u!.uid;
}

export function canUpdateTicket(
  u: User | null,
  tid: string,
  existing: TicketDoc,
  updated: TicketDoc,
): boolean {
  if (isTech(u, tid)) return true;
  // El solicitante: solo su ticket y sin tocar la asignación.
  return (
    isRequester(u, tid) &&
    existing.requesterId === u!.uid &&
    updated.requesterId === existing.requesterId &&
    updated.technicianId === existing.technicianId
  );
}

export function canDeleteTicket(u: User | null, tid: string): boolean {
  return isAdmin(u, tid) || isPlatformAdmin(u);
}

// ---- configuración del tenant ----------------------------------------------

export function canReadConfig(u: User | null, tid: string): boolean {
  return isMember(u, tid) || isPlatformAdmin(u);
}

export function canWriteConfig(u: User | null, tid: string): boolean {
  return hasCap(u, tid, 'manageConfig') || isPlatformAdmin(u);
}
