// Sujetos de prueba compartidos. Dos tenants: 'diglo-it' (interno) y
// 'leasys' (cliente externo), reflejando las 2 instancias reales de Zoho.
import type { User } from '../src/access.js';
import type { TicketDoc } from '../src/access.js';

export const IT = 'diglo-it';
export const LEASYS = 'leasys';

export const adminIT: User = {
  uid: 'u-admin-it',
  memberships: { [IT]: { role: 'tenant_admin', status: 'active' } },
};

export const techIT: User = {
  uid: 'u-tech-it',
  memberships: { [IT]: { role: 'technician', status: 'active' } },
};

export const reqIT1: User = {
  uid: 'u-req-it-1',
  memberships: { [IT]: { role: 'requester', status: 'active' } },
};

export const reqIT2: User = {
  uid: 'u-req-it-2',
  memberships: { [IT]: { role: 'requester', status: 'active' } },
};

// Técnico del cliente Leasys, con correo EXTERNO al dominio corporativo.
// El modelo no mira el dominio: basta con ser miembro del tenant.
export const techLeasysExternal: User = {
  uid: 'u-tech-leasys',
  memberships: { [LEASYS]: { role: 'technician', status: 'active' } },
};

// Solicitante externo (cliente final de Leasys).
export const reqLeasysExternal: User = {
  uid: 'u-req-leasys',
  memberships: { [LEASYS]: { role: 'requester', status: 'active' } },
};

// Miembro invitado pero aún no activo: NO debe tener acceso.
export const invitedIT: User = {
  uid: 'u-invited-it',
  memberships: { [IT]: { role: 'technician', status: 'invited' } },
};

// Persona sin ninguna pertenencia.
export const outsider: User = { uid: 'u-outsider', memberships: {} };

// Superadmin de plataforma (Diglo).
export const platform: User = { uid: 'u-platform', platformAdmin: true, memberships: {} };

// Tickets de ejemplo en el tenant IT.
export const ticketOfReq1: TicketDoc = {
  type: 'incident',
  requesterId: reqIT1.uid,
  technicianId: techIT.uid,
};

export const ticketOfReq2: TicketDoc = {
  type: 'service_request',
  requesterId: reqIT2.uid,
  technicianId: null,
};
