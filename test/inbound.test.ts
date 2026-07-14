import { describe, it, expect } from 'vitest';
import { parseInbound } from '../src/inbound.js';

describe('parseInbound', () => {
  it('correo nuevo: sin id de ticket', () => {
    const p = parseInbound({ from: 'Ana@Diglo.com', subject: 'No arranca el PC', body: 'Ayuda' });
    expect(p.replyToId).toBeNull();
    expect(p.subject).toBe('No arranca el PC');
    expect(p.fromEmail).toBe('ana@diglo.com');
  });
  it('respuesta: detecta [INC-2039] y limpia asunto', () => {
    const p = parseInbound({ from: 'x@y.com', subject: 'Re: [INC-2039] VPN caída', body: 'sigue igual' });
    expect(p.replyToId).toBe('INC-2039');
    expect(p.subject).toBe('VPN caída');
  });
  it('detecta id sin corchetes y varios Re/Fwd', () => {
    const p = parseInbound({ from: 'x@y.com', subject: 'RE: Fwd: SR-1201 alta de usuario', body: '' });
    expect(p.replyToId).toBe('SR-1201');
    expect(p.subject).toBe('alta de usuario');
  });
  it('asunto vacío tras limpiar → fallback', () => {
    expect(parseInbound({ from: 'x@y.com', subject: '[INC-500]', body: 'hola' }).subject).toBe('Respuesta a INC-500');
    expect(parseInbound({ from: 'x@y.com', subject: 'Re:', body: 'hola' }).subject).toBe('Solicitud por correo');
  });
  it('normaliza mayúsculas del id', () => {
    expect(parseInbound({ from: 'x@y.com', subject: 'inc-77 test', body: '' }).replyToId).toBe('INC-77');
  });
});
