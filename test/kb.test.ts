import { describe, it, expect } from 'vitest';
import { searchKb, type KbArticle } from '../src/kb.js';

const A = (over: Partial<KbArticle>): KbArticle => ({ id: 'a', title: '', body: '', status: 'published', authorName: 'x', createdAt: 1, updatedAt: 1, ...over });

const arts: KbArticle[] = [
  A({ id: 'vpn', title: 'Conectar a la VPN', body: 'FortiClient perfil Diglo', category: 'Redes', tags: ['vpn'], status: 'published', updatedAt: 10 }),
  A({ id: 'pwd', title: 'Restablecer contraseña', body: 'portal de autoservicio', category: 'Cuentas', status: 'published', updatedAt: 20 }),
  A({ id: 'draft', title: 'Firma de correo', body: 'outlook', status: 'draft', updatedAt: 30 }),
];

describe('searchKb', () => {
  it('solicitante solo ve publicados', () => {
    const r = searchKb(arts, '', false);
    expect(r.map((a) => a.id)).not.toContain('draft');
    expect(r.length).toBe(2);
  });
  it('staff ve también borradores (publicados primero)', () => {
    const r = searchKb(arts, '', true);
    expect(r.length).toBe(3);
    expect(r[r.length - 1]!.id).toBe('draft'); // borrador al final
  });
  it('busca por título/categoría/tags/cuerpo', () => {
    expect(searchKb(arts, 'vpn', false).map((a) => a.id)).toEqual(['vpn']);
    expect(searchKb(arts, 'Cuentas', false).map((a) => a.id)).toEqual(['pwd']);
    expect(searchKb(arts, 'forticlient', false).map((a) => a.id)).toEqual(['vpn']);
  });
  it('el título pesa más que el cuerpo', () => {
    const list: KbArticle[] = [
      A({ id: 'body', title: 'Otro', body: 'aquí hablamos de impresoras' }),
      A({ id: 'title', title: 'Impresoras', body: 'texto' }),
    ];
    expect(searchKb(list, 'impresora', false)[0]!.id).toBe('title');
  });
  it('sin query devuelve todos (según estado)', () => {
    expect(searchKb(arts, '', false).length).toBe(2);
  });
});
