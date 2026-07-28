// Resolución PURA de la clasificación v3 (Área → Servicio → Elemento). Sin estado,
// testeable. La usan el store (createTicket) y el formulario. Reglas:
//   · GRUPO de soporte: herencia bottom-up (elemento → servicio → área).
//   · ACL de SOLICITANTE: por SERVICIO (como `user_groups` de la plantilla SDP); vacío = todos.
// Ver docs/plan-implementacion-3-niveles.md (Fase 1).
import type { AreaNode, ServiceNode, ElementNode, TicketType } from './model.js';

export interface ClassificationPath {
  area?: AreaNode;
  service?: ServiceNode;
  element?: ElementNode;
}

/** Grupo de soporte por herencia bottom-up: elemento ?? servicio ?? área. */
export function resolveGroup(p: ClassificationPath): string | undefined {
  return p.element?.groupId ?? p.service?.groupId ?? p.area?.groupId;
}

/** ACL de solicitante efectiva del servicio. `[]` = sin restricción (lo ven todos). */
export function requesterAcl(p: ClassificationPath): string[] {
  return p.service?.userGroups ?? [];
}

/** ¿Puede este solicitante (por sus grupos de usuario) ver/levantar el nodo? */
export function visibleToRequester(p: ClassificationPath, userGroups: string[]): boolean {
  const acl = requesterAcl(p);
  if (!acl.length) return true; // sin restricción
  return acl.some((g) => userGroups.includes(g));
}

/** Tipos permitidos por el servicio (vacío/ausente = ambos). */
export function allowedTypes(s: ServiceNode | undefined): TicketType[] {
  return s?.allowedTypes?.length ? s.allowedTypes : ['incident', 'service_request'];
}

/** Ciclo de vida para un (servicio, tipo). `undefined` si no está definido. */
export function lifecycleFor(s: ServiceNode | undefined, type: TicketType): string | null | undefined {
  return s?.lifecycleByType?.[type];
}

const active = <T extends { inactive?: boolean }>(xs: T[] | undefined): T[] => (xs ?? []).filter((x) => !x.inactive);

/** Localiza el camino por ids. NO filtra inactivos: debe poder resolver tickets
 *  históricos clasificados con un nodo ya retirado (para archivo/auditoría). */
export function findPath(tree: AreaNode[], areaId?: string, serviceId?: string, elementId?: string): ClassificationPath {
  const area = tree.find((a) => a.id === areaId);
  const service = area?.services.find((s) => s.id === serviceId);
  const element = service?.elements?.find((e) => e.id === elementId);
  return { area, service, element };
}

/** Árbol que un solicitante puede ver para LEVANTAR un ticket: sin inactivos y
 *  respetando la ACL por servicio. Elementos inactivos filtrados; áreas sin
 *  servicios visibles se descartan. */
export function visibleTree(tree: AreaNode[], userGroups: string[]): AreaNode[] {
  const out: AreaNode[] = [];
  for (const area of active(tree).slice().sort(byOrder)) {
    const services: ServiceNode[] = [];
    for (const service of active(area.services).slice().sort(byOrder)) {
      if (!visibleToRequester({ area, service }, userGroups)) continue;
      services.push({ ...service, elements: active(service.elements) });
    }
    if (services.length) out.push({ ...area, services });
  }
  return out;
}

const byOrder = (a: { sortIndex?: number; name: string }, b: { sortIndex?: number; name: string }): number =>
  (a.sortIndex ?? 1e9) - (b.sortIndex ?? 1e9) || a.name.localeCompare(b.name);
