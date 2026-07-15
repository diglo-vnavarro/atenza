// Tests puros de la matriz de autorización multi-tenant.
// Corren SIN emulador ni Java: `npm test`.
import { describe, it, expect } from 'vitest';
import {
  canReadTenant, canUpdateTenant, canCreateTenant,
  canManageMembers, canReadMember,
  canGetTicket, canListTickets, canCreateTicket, canUpdateTicket, canDeleteTicket,
  canReadConfig, canWriteConfig, hasCap, type User,
} from '../src/access.js';
import type { Role } from '../src/model.js';
import {
  IT, LEASYS,
  adminIT, techIT, reqIT1, reqIT2,
  techLeasysExternal, reqLeasysExternal,
  invitedIT, outsider, platform,
  ticketOfReq1, ticketOfReq2,
} from './fixtures.js';

describe('aislamiento entre tenants', () => {
  it('un técnico de IT NO ve nada del tenant Leasys', () => {
    expect(canReadTenant(techIT, LEASYS)).toBe(false);
    expect(canGetTicket(techIT, LEASYS, ticketOfReq1)).toBe(false);
    expect(canReadConfig(techIT, LEASYS)).toBe(false);
    expect(canWriteConfig(techIT, LEASYS)).toBe(false);
  });

  it('un técnico de Leasys NO ve nada del tenant IT', () => {
    expect(canReadTenant(techLeasysExternal, IT)).toBe(false);
    expect(canGetTicket(techLeasysExternal, IT, ticketOfReq1)).toBe(false);
    expect(canListTickets(techLeasysExternal, IT)).toBe(false);
  });
});

describe('roles dentro del tenant', () => {
  it('técnico y admin ven cualquier ticket del tenant', () => {
    expect(canGetTicket(techIT, IT, ticketOfReq1)).toBe(true);
    expect(canGetTicket(techIT, IT, ticketOfReq2)).toBe(true);
    expect(canGetTicket(adminIT, IT, ticketOfReq2)).toBe(true);
    expect(canListTickets(techIT, IT)).toBe(true);
  });

  it('el solicitante solo ve SUS tickets', () => {
    expect(canGetTicket(reqIT1, IT, ticketOfReq1)).toBe(true);
    expect(canGetTicket(reqIT1, IT, ticketOfReq2)).toBe(false); // ticket de otro
    expect(canListTickets(reqIT1, IT)).toBe(false); // sin listado libre
  });

  it('crear: el solicitante solo a su nombre; el técnico en nombre de otro', () => {
    expect(canCreateTicket(reqIT1, IT, ticketOfReq1)).toBe(true);
    expect(canCreateTicket(reqIT1, IT, ticketOfReq2)).toBe(false); // requesterId de otro
    expect(canCreateTicket(techIT, IT, ticketOfReq2)).toBe(true); // en nombre de reqIT2
  });

  it('crear: rechaza tipos de ticket no válidos', () => {
    const bad = { ...ticketOfReq1, type: 'question' as never };
    expect(canCreateTicket(reqIT1, IT, bad)).toBe(false);
  });

  it('actualizar: el solicitante no puede reasignar ni tocar tickets ajenos', () => {
    const reassign = { ...ticketOfReq1, technicianId: 'otro-tecnico' };
    expect(canUpdateTicket(reqIT1, IT, ticketOfReq1, reassign)).toBe(false);
    const editSubjectOnly = { ...ticketOfReq1 };
    expect(canUpdateTicket(reqIT1, IT, ticketOfReq1, editSubjectOnly)).toBe(true);
    expect(canUpdateTicket(reqIT1, IT, ticketOfReq2, ticketOfReq2)).toBe(false); // ajeno
  });

  it('actualizar: el técnico puede todo dentro del tenant', () => {
    const reassign = { ...ticketOfReq1, technicianId: techIT.uid };
    expect(canUpdateTicket(techIT, IT, ticketOfReq1, reassign)).toBe(true);
  });

  it('borrar ticket: solo admin del tenant', () => {
    expect(canDeleteTicket(techIT, IT)).toBe(false);
    expect(canDeleteTicket(adminIT, IT)).toBe(true);
  });

  it('configuración: lee cualquier miembro, escribe solo el admin', () => {
    expect(canReadConfig(reqIT1, IT)).toBe(true);
    expect(canWriteConfig(techIT, IT)).toBe(false);
    expect(canWriteConfig(adminIT, IT)).toBe(true);
  });

  it('gestión de miembros: solo admin', () => {
    expect(canReadMember(reqIT1, IT)).toBe(true);
    expect(canManageMembers(techIT, IT)).toBe(false);
    expect(canManageMembers(adminIT, IT)).toBe(true);
  });
});

describe('identidades externas (la diferencia con OrganiZate)', () => {
  it('un usuario/técnico externo al dominio funciona: la puerta es la pertenencia, no el email', () => {
    expect(canReadTenant(techLeasysExternal, LEASYS)).toBe(true);
    expect(canGetTicket(reqLeasysExternal, LEASYS, {
      type: 'incident', requesterId: reqLeasysExternal.uid, technicianId: null,
    })).toBe(true);
  });
});

describe('estados de acceso negados', () => {
  it('miembro invitado (no activo) no tiene acceso', () => {
    expect(canReadTenant(invitedIT, IT)).toBe(false);
    expect(canGetTicket(invitedIT, IT, ticketOfReq1)).toBe(false);
  });

  it('un extraño sin pertenencia no puede nada', () => {
    expect(canReadTenant(outsider, IT)).toBe(false);
    expect(canListTickets(outsider, IT)).toBe(false);
    expect(canCreateTicket(outsider, IT, ticketOfReq1)).toBe(false);
  });

  it('sin sesión (null) todo se deniega', () => {
    expect(canReadTenant(null, IT)).toBe(false);
    expect(canGetTicket(null, IT, ticketOfReq1)).toBe(false);
  });
});

describe('capacidades granulares en servidor (RBAC)', () => {
  const mk = (role: Role, caps?: string[]): User => ({ uid: 'u1', memberships: { [IT]: { role, status: 'active', ...(caps ? { caps } : {}) } } });

  it('sin caps → fallback al nivel base (no bloquea a los admins actuales)', () => {
    expect(canWriteConfig(mk('tenant_admin'), IT)).toBe(true);
    expect(canManageMembers(mk('tenant_admin'), IT)).toBe(true);
    expect(canWriteConfig(mk('technician'), IT)).toBe(false);
    expect(canManageMembers(mk('technician'), IT)).toBe(false);
  });

  it('caps restringen a un admin-base al que se le quitó manageConfig/manageUsers', () => {
    const restricted = mk('tenant_admin', ['viewAllTickets', 'assign', 'close']);
    expect(canWriteConfig(restricted, IT)).toBe(false);
    expect(canManageMembers(restricted, IT)).toBe(false);
    expect(canUpdateTenant(restricted, IT)).toBe(false);
    expect(hasCap(restricted, IT, 'assign')).toBe(true);
  });

  it('caps elevan a un técnico-base con manageConfig', () => {
    const elevated = mk('technician', ['viewAllTickets', 'manageConfig']);
    expect(canWriteConfig(elevated, IT)).toBe(true);
    expect(canManageMembers(elevated, IT)).toBe(false); // no tiene manageUsers
  });

  it('caps vacías → sin capacidades de gestión aunque el base fuese admin', () => {
    expect(canWriteConfig(mk('tenant_admin', []), IT)).toBe(false);
  });
});

describe('superadmin de plataforma', () => {
  it('puede crear tenants y ver/gestionar cualquiera', () => {
    expect(canCreateTenant(platform)).toBe(true);
    expect(canReadTenant(platform, IT)).toBe(true);
    expect(canReadTenant(platform, LEASYS)).toBe(true);
    expect(canManageMembers(platform, LEASYS)).toBe(true);
    expect(canGetTicket(platform, LEASYS, ticketOfReq1)).toBe(true);
  });

  it('un tenant_admin NO es superadmin: no crea tenants', () => {
    expect(canCreateTenant(adminIT)).toBe(false);
    expect(canUpdateTenant(adminIT, IT)).toBe(true);
  });
});
