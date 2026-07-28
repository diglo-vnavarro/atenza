import { describe, it, expect } from 'vitest';
import type { AreaNode } from '../src/model.js';
import {
  resolveGroup, requesterAcl, visibleToRequester, allowedTypes, lifecycleFor, findPath, visibleTree,
} from '../src/classification.js';

// Árbol de prueba: grupo heredable, ACL por servicio, inactivos y orden.
const tree: AreaNode[] = [
  { id: 'ar-it', name: 'IT', sortIndex: 1, groupId: 'g-area',
    services: [
      { id: 'sv-gemini', name: 'Gemini', sortIndex: 2, groupId: 'g-gemini',
        elements: [{ id: 'el-a', name: 'A' }, { id: 'el-b', name: 'B', groupId: 'g-b' }, { id: 'el-off', name: 'Off', inactive: true }] },
      { id: 'sv-restr', name: 'Restringido', sortIndex: 1, userGroups: ['IT', 'RRHH'], allowedTypes: ['service_request'],
        lifecycleByType: { service_request: 'lc-sr' } },
      { id: 'sv-heredado', name: 'SinGrupo', sortIndex: 3 }, // hereda el grupo del área
      { id: 'sv-off', name: 'Inactivo', sortIndex: 4, inactive: true },
    ] },
  { id: 'ar-vacia', name: 'AreaVacia', sortIndex: 2, services: [{ id: 'sv-x', name: 'X', inactive: true }] },
];

describe('resolveGroup (herencia elemento → servicio → área)', () => {
  it('elemento gana', () => {
    expect(resolveGroup(findPath(tree, 'ar-it', 'sv-gemini', 'el-b'))).toBe('g-b');
  });
  it('servicio si el elemento no fija', () => {
    expect(resolveGroup(findPath(tree, 'ar-it', 'sv-gemini', 'el-a'))).toBe('g-gemini');
  });
  it('área si el servicio no fija', () => {
    expect(resolveGroup(findPath(tree, 'ar-it', 'sv-heredado'))).toBe('g-area');
  });
  it('undefined si nada fija grupo', () => {
    expect(resolveGroup(findPath(tree, 'ar-vacia', 'sv-x'))).toBeUndefined();
  });
});

describe('ACL de solicitante (por servicio)', () => {
  it('servicio sin userGroups → sin restricción (todos)', () => {
    const p = findPath(tree, 'ar-it', 'sv-gemini');
    expect(requesterAcl(p)).toEqual([]);
    expect(visibleToRequester(p, [])).toBe(true);
  });
  it('servicio restringido: solo sus grupos', () => {
    const p = findPath(tree, 'ar-it', 'sv-restr');
    expect(visibleToRequester(p, ['RRHH'])).toBe(true);
    expect(visibleToRequester(p, ['Ventas'])).toBe(false);
  });
});

describe('tipos y ciclo', () => {
  it('sin allowedTypes → ambos', () => {
    expect(allowedTypes(findPath(tree, 'ar-it', 'sv-gemini').service)).toEqual(['incident', 'service_request']);
  });
  it('allowedTypes explícito', () => {
    expect(allowedTypes(findPath(tree, 'ar-it', 'sv-restr').service)).toEqual(['service_request']);
  });
  it('lifecycleFor por tipo', () => {
    const s = findPath(tree, 'ar-it', 'sv-restr').service;
    expect(lifecycleFor(s, 'service_request')).toBe('lc-sr');
    expect(lifecycleFor(s, 'incident')).toBeUndefined();
  });
});

describe('findPath', () => {
  it('ids inexistentes → nodos undefined', () => {
    expect(findPath(tree, 'nope', 'nope')).toEqual({ area: undefined, service: undefined, element: undefined });
  });
  it('resuelve nodos inactivos (para histórico)', () => {
    expect(findPath(tree, 'ar-it', 'sv-off').service?.id).toBe('sv-off');
  });
});

describe('visibleTree (solicitante)', () => {
  it('quita inactivos, ordena, filtra elementos inactivos y áreas vacías', () => {
    const t = visibleTree(tree, []); // usuario sin grupos: solo ve lo no restringido
    expect(t.map((a) => a.id)).toEqual(['ar-it']);           // AreaVacia se descarta (sin servicios visibles)
    const it = t[0]!;
    // sv-restr requiere grupo → no visible; sv-off inactivo → fuera
    expect(it.services.map((s) => s.id)).toEqual(['sv-gemini', 'sv-heredado']); // por sortIndex 2,3
    const gemini = it.services[0]!;
    expect(gemini.elements!.map((e) => e.id)).toEqual(['el-a', 'el-b']);        // el-off fuera
  });
  it('un usuario con el grupo ve el servicio restringido', () => {
    const t = visibleTree(tree, ['IT']);
    expect(t[0]!.services.map((s) => s.id)).toEqual(['sv-restr', 'sv-gemini', 'sv-heredado']); // sortIndex 1,2,3
  });
});
