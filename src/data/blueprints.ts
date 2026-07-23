// ============================================================================
// Blueprints de instancia — configuración base para crear una instancia NUEVA
// desde cero (Fase 3 del portal). Cada blueprint define un conjunto mínimo pero
// FUNCIONAL: estados, 1 ciclo de vida (con id/name en las transiciones — sin
// ellos React Flow no pinta las flechas), categorías de servicio, plantillas y
// prioridades. `materializeTenant` lo convierte en un TenantData completo.
// ============================================================================
import type { Lifecycle, Template, StatusDef, SlaCategory } from '../model.js';
import { type TenantData, type ServiceCategoryDef, type Group, type PickVal, type Branding, type UiMember, SDP_PICKLISTS } from './seed.js';

export interface BlueprintDef {
  id: string;
  label: string;
  description: string;
  statuses: StatusDef[];
  priorities: PickVal[];
  lifecycles: Lifecycle[];
  templates: Template[];
  serviceCategories: ServiceCategoryDef[];
  groups: Group[];
}

// helper: transición con id/name (imprescindible para el lienzo del ciclo)
const tr = (from: string, to: string, labels: Record<string, string>) => ({ id: `tr_${from}_${to}`, name: `${labels[from]} → ${labels[to]}`, from, to });

// ---- Ciclo estándar (incidencia/petición) ----
const L = { abierta: 'Abierta', en_curso: 'En curso', en_espera: 'En espera', resuelta: 'Resuelta', cerrada: 'Cerrada', cancelada: 'Cancelada' } as const;
const stdLifecycle: Lifecycle = {
  id: 'lc-base', name: 'Estándar', version: '1.0', type: 'incident', published: true,
  states: [
    { key: 'abierta', label: L.abierta, stage: 'open', category: 'in_progress', isInitial: true },
    { key: 'en_curso', label: L.en_curso, stage: 'open', category: 'in_progress' },
    { key: 'en_espera', label: L.en_espera, stage: 'open', category: 'stop_timer' },
    { key: 'resuelta', label: L.resuelta, stage: 'closed', category: 'completed' },
    { key: 'cerrada', label: L.cerrada, stage: 'closed', category: 'completed', isTerminal: true },
    { key: 'cancelada', label: L.cancelada, stage: 'closed', category: 'completed', isTerminal: true },
  ],
  transitions: [
    tr('abierta', 'en_curso', L), tr('abierta', 'en_espera', L), tr('abierta', 'cancelada', L),
    tr('en_curso', 'en_espera', L), tr('en_curso', 'resuelta', L), tr('en_curso', 'cancelada', L),
    tr('en_espera', 'en_curso', L), tr('en_espera', 'resuelta', L),
    tr('resuelta', 'cerrada', L), tr('resuelta', 'en_curso', L),
  ],
};

const stColor: Record<SlaCategory, string> = { in_progress: '#2f6bff', stop_timer: '#b4690e', completed: '#64748b' };
const st = (name: string, timer: SlaCategory, color?: string): StatusDef => ({ name, timer, color: color ?? stColor[timer] });

const STD_PRIORITIES: PickVal[] = [
  { name: 'Crítica', color: '#e5484d' }, { name: 'Alta', color: '#b45309' },
  { name: 'Media', color: '#0c8e48' }, { name: 'Baja', color: '#666666' },
];

const stdTemplates: Template[] = [
  { id: 'tpl-inc', type: 'incident', name: 'Incidencia', lifecycleId: 'lc-base', slaId: null, fields: ['subject', 'description', 'category', 'priority'], fieldDefs: [] },
  { id: 'tpl-sr', type: 'service_request', name: 'Petición de servicio', lifecycleId: 'lc-base', slaId: null, fields: ['subject', 'description', 'category', 'priority'], fieldDefs: [] },
];

const stdCategories: ServiceCategoryDef[] = [
  { id: 'sc-inc', name: 'Incidencias generales', icon: '🛠️', incident: { lifecycleId: 'lc-base' }, service_request: { lifecycleId: 'lc-base' } },
  { id: 'sc-sr', name: 'Peticiones de servicio', icon: '📨', incident: { lifecycleId: 'lc-base' }, service_request: { lifecycleId: 'lc-base' } },
];

export const BLUEPRINTS: BlueprintDef[] = [
  {
    id: 'starter-es',
    label: 'Inicial (español)',
    description: 'Mesa de servicio mínima lista para usar: 6 estados, ciclo estándar, incidencias y peticiones, 4 prioridades y 2 grupos de soporte.',
    statuses: [st('Abierta', 'in_progress'), st('En curso', 'in_progress'), st('En espera', 'stop_timer'), st('Resuelta', 'completed', '#0f7a52'), st('Cerrada', 'completed'), st('Cancelada', 'completed', '#c62b3f')],
    priorities: STD_PRIORITIES,
    lifecycles: [stdLifecycle],
    templates: stdTemplates,
    serviceCategories: stdCategories,
    groups: [{ id: 'g-n1', name: 'Soporte N1' }, { id: 'g-n2', name: 'Soporte N2' }],
  },
  {
    id: 'blank',
    label: 'Vacío (mínimo)',
    description: 'Lo imprescindible: Abierta/Cerrada, un ciclo simple, una categoría y una plantilla. Para configurar todo a mano.',
    statuses: [st('Abierta', 'in_progress'), st('Cerrada', 'completed')],
    priorities: [{ name: 'Media', color: '#0c8e48' }, { name: 'Alta', color: '#b45309' }],
    lifecycles: [{
      id: 'lc-base', name: 'Básico', version: '1.0', type: 'incident', published: true,
      states: [
        { key: 'abierta', label: 'Abierta', stage: 'open', category: 'in_progress', isInitial: true },
        { key: 'cerrada', label: 'Cerrada', stage: 'closed', category: 'completed', isTerminal: true },
      ],
      transitions: [{ id: 'tr_abierta_cerrada', name: 'Abierta → Cerrada', from: 'abierta', to: 'cerrada' }],
    }],
    templates: [{ id: 'tpl-inc', type: 'incident', name: 'Solicitud', lifecycleId: 'lc-base', slaId: null, fields: ['subject', 'description', 'priority'], fieldDefs: [] }],
    serviceCategories: [{ id: 'sc-gen', name: 'General', icon: '📁', incident: { lifecycleId: 'lc-base' }, service_request: { lifecycleId: 'lc-base' } }],
    groups: [],
  },
];

export function getBlueprint(id: string): BlueprintDef {
  return BLUEPRINTS.find((b) => b.id === id) ?? BLUEPRINTS[0]!;
}

export interface InstanceSpec {
  id: string;
  name: string;
  key: string;
  blueprintId: string;
  branding?: Branding;
}

/** Convierte un blueprint + datos de la instancia + primer admin en un TenantData
 *  completo (para escribir en Firestore o insertar en el estado local). */
export function materializeTenant(spec: InstanceSpec, admin: UiMember): TenantData {
  const bp = getBlueprint(spec.blueprintId);
  return {
    id: spec.id, name: spec.name, key: spec.key, active: true,
    ...(spec.branding ? { branding: spec.branding } : {}),
    members: [admin],
    lifecycles: bp.lifecycles,
    templates: bp.templates,
    slas: [], groups: bp.groups, tickets: [], assets: [],
    categories: bp.serviceCategories.map((c) => c.name),
    statuses: bp.statuses,
    picklists: { ...SDP_PICKLISTS, priority: bp.priorities },
    sites: [], departments: [], userGroups: [], roles: [],
    serviceCategories: bp.serviceCategories, serviceCategoryIcons: {},
    operationMode: 'simplified', capacity: {}, counter: 1000,
  };
}
