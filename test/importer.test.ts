// Tests de los mappers del importador (SDP v3 -> Atenza). Sin red ni credenciales.
import { describe, it, expect } from 'vitest';
import { mapSnapshot, mapTemplate, mapSla, mapUser, durationToMins, statusCategory, type SdpRaw } from '../importer/map.js';

describe('importador · mappers SDP v3 -> Atenza', () => {
  it('duración {days,hours,minutes} -> minutos', () => {
    expect(durationToMins({ hours: 2 })).toBe(120);
    expect(durationToMins({ days: 1, hours: 1, minutes: 30 })).toBe(1530);
    expect(durationToMins(45)).toBe(45);
    expect(durationToMins(null)).toBe(0);
  });

  it('plantilla de servicio vs incidencia', () => {
    expect(mapTemplate({ id: 1, name: 'Incidencia' }).type).toBe('incident');
    expect(mapTemplate({ id: 2, name: 'Alta usuario', is_service_template: true }).type).toBe('service_request');
    expect(mapTemplate({ id: 3, name: 'X', fields: [{ name: 'asunto' }, { label: 'desc' }] }).fields).toEqual(['asunto', 'desc']);
  });

  it('SLA con tiempos de respuesta/resolución', () => {
    const s = mapSla({ id: 9, name: 'Alta', response_time: { hours: 2 }, resolution_time: { hours: 8 } });
    expect(s).toMatchObject({ id: '9', name: 'Alta', responseMins: 120, resolveMins: 480 });
  });

  it('usuario externo se detecta por dominio del correo', () => {
    const interno = mapUser({ id: 1, name: 'Ana', email_id: 'ana@digloservicer.com' }, 'technician', 0, 'digloservicer.com');
    const externo = mapUser({ id: 2, name: 'Cli', email_id: 'cli@leasys.com' }, 'requester', 1, 'digloservicer.com');
    expect(interno.external).toBe(false);
    expect(externo.external).toBe(true);
    expect(externo.role).toBe('requester');
  });

  it('estado -> categoría de temporizador', () => {
    expect(statusCategory({ id: 1, name: 'Trabajando', in_progress: true })).toBe('in_progress');
    expect(statusCategory({ id: 2, name: 'En espera', stop_timer: true })).toBe('stop_timer');
    expect(statusCategory({ id: 3, name: 'Cerrada' })).toBe('completed');
  });

  it('snapshot completo mapea todos los recursos', () => {
    const raw: SdpRaw = {
      instanceName: 'Diglo ITSM', corpDomain: 'digloservicer.com',
      templates: [{ id: 1, name: 'Incidencia' }, { id: 2, name: 'Alta usuario', is_service_template: true }],
      categories: [{ id: 1, name: 'Hardware' }, { id: 2, name: 'Correo' }, { id: 3, name: 'Correo' }],
      slas: [{ id: 5, name: 'Alta', response_time: { hours: 2 }, resolution_time: { hours: 2 } }],
      groups: [{ id: 7, name: 'Soporte N1' }],
      technicians: [{ id: 10, name: 'Elena', email_id: 'e@digloservicer.com' }],
      requesters: [{ id: 20, name: 'Cliente', email_id: 'c@leasys.com' }],
      priorities: [{ name: 'Alta' }, { name: 'Media' }],
      statuses: [{ id: 1, name: 'Abierta', in_progress: true }, { id: 2, name: 'En espera', stop_timer: true }],
    };
    const snap = mapSnapshot(raw);
    expect(snap.name).toBe('Diglo ITSM');
    expect(snap.categories).toEqual(['Hardware', 'Correo']); // dedup
    expect(snap.templates.map((t) => t.type)).toEqual(['incident', 'service_request']);
    expect(snap.slas[0]!.resolveMins).toBe(120);
    expect(snap.groups[0]!.name).toBe('Soporte N1');
    expect(snap.members.length).toBe(2);
    expect(snap.members.find((m) => m.uid === '20')!.external).toBe(true);
    expect(snap.reference.priorities).toEqual(['Alta', 'Media']);
    expect(snap.reference.statuses).toEqual([{ name: 'Abierta', category: 'in_progress' }, { name: 'En espera', category: 'stop_timer' }]);
  });
});
