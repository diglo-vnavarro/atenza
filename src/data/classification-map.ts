// Mapa DETERMINISTA de la sincronización: señales de SDP (plantilla / categoría de
// servicio / item) → clasificación v3 (Área, Servicio, Elemento). Si nada casa →
// «Sin clasificar» (nunca se pierde el ticket). Derivado del Anexo A y del análisis
// de resolutores. Ver docs/plan-implementacion-3-niveles.md (Fase 2).
import type { AreaNode } from '../model.js';
import { DIGLO_CLASSIFICATION_V3 } from './classification-seed.js';

export const SIN_CLASIFICAR = { area: 'sin-clasificar', service: 'sin-clasificar' } as const;

export interface V3Ref { area: string; service: string; element?: string }

// Plantilla SDP → (área, servicio). Cubre las plantillas ACTIVAS; el resto (legacy,
// «NO USAR», Intranet/Payroll/VOIP…) cae a «Sin clasificar».
const TEMPLATE_TO_V3: Record<string, { area: string; service: string }> = {
  'Plantilla Incidencia': { area: 'ar-it', service: 'sv-inc' },
  'Plantilla Peticion': { area: 'ar-it', service: 'sv-pet' },
  'Incidencias Gemini': { area: 'ar-it', service: 'sv-gemini' },
  'Solicitudes Gemini': { area: 'ar-it', service: 'sv-gemini' },
  'Plantilla Incidencia GCP': { area: 'ar-it', service: 'sv-gcp' },
  'Plantilla Peticion GCP': { area: 'ar-it', service: 'sv-gcp' },
  'Plantilla Incidencia Recovery': { area: 'ar-it', service: 'sv-recovery' },
  'Plantilla Servicio Recovery': { area: 'ar-it', service: 'sv-recovery' },
  'Plantilla Incidencias REO': { area: 'ar-it', service: 'sv-reo' },
  'Solicitud REO': { area: 'ar-it', service: 'sv-reo' },
  'Alta de usuarios externos': { area: 'ar-it', service: 'sv-usuarios' },
  'Alta de usuarios internos': { area: 'ar-it', service: 'sv-usuarios' },
  'Baja de usuario externo': { area: 'ar-it', service: 'sv-usuarios' },
  'Baja de usuario interno': { area: 'ar-it', service: 'sv-usuarios' },
  'Modificación de usuario': { area: 'ar-it', service: 'sv-usuarios' },
  'Alta Buzón compartido': { area: 'ar-it', service: 'sv-usuarios' },
  'Modificación o baja de Buzones compartidos': { area: 'ar-it', service: 'sv-usuarios' },
  'Alta Unidad departamental': { area: 'ar-it', service: 'sv-pet' },
  'Modificación o baja de Unidades departamentales': { area: 'ar-it', service: 'sv-pet' },
  'Nuevo FTP': { area: 'ar-it', service: 'sv-pet' },
  'Otras consultas': { area: 'ar-it', service: 'sv-pet' },
  'Solicitud de acceso a BBDD': { area: 'ar-it', service: 'sv-pet' },
  'Solicitud de nueva automatización': { area: 'ar-it', service: 'sv-pet' },
  'LIQUIDACIONES INFORMATIVAS DE DEUDA': { area: 'ar-ops', service: 'sv-liq' },
  'Solicitud PD': { area: 'ar-ops', service: 'sv-pd' },
  'Plantilla Incidencias PD': { area: 'ar-ops', service: 'sv-pd' },
  'Solicitud de datos BI': { area: 'ar-bi', service: 'sv-bi' },
  'Plantilla Incidencias BI': { area: 'ar-bi', service: 'sv-bi' },
  'Peticion ITSM BI': { area: 'ar-bi', service: 'sv-itsmbi' },
  'Informes Looker': { area: 'ar-bi', service: 'sv-looker' },
  'Plantilla Reclamación': { area: 'ar-neg', service: 'sv-reclam' },
  'Seguimiento Infoser/Diglo': { area: 'ar-neg', service: 'sv-seg' },
  'Solicitud Waiver Template': { area: 'ar-neg', service: 'sv-waiver' },
  'Solicitud Waiver': { area: 'ar-neg', service: 'sv-waiver' },
};

// Categoría de servicio SDP → (área, servicio). Respaldo si la plantilla no está mapeada.
const SC_TO_V3: Record<string, { area: string; service: string }> = {
  'AI - Gemini': { area: 'ar-it', service: 'sv-gemini' },
  Recovery: { area: 'ar-it', service: 'sv-recovery' },
  'Tareas REO': { area: 'ar-it', service: 'sv-reo' },
  'Gestión de usuarios': { area: 'ar-it', service: 'sv-usuarios' },
  'Gestiones de Correo Electrónico': { area: 'ar-it', service: 'sv-usuarios' },
  'Gestión Unidades Departamentales': { area: 'ar-it', service: 'sv-pet' },
  'Arquitectura IT': { area: 'ar-it', service: 'sv-pet' },
  'Incidencias GCP': { area: 'ar-it', service: 'sv-gcp' },
  'Peticiones GCP': { area: 'ar-it', service: 'sv-gcp' },
  Peticiones: { area: 'ar-it', service: 'sv-pet' },
  Operaciones: { area: 'ar-ops', service: 'sv-liq' },
  'Solicitudes PD': { area: 'ar-ops', service: 'sv-pd' },
  'Solicitudes BI': { area: 'ar-bi', service: 'sv-bi' },
  'ITSM BI': { area: 'ar-bi', service: 'sv-itsmbi' },
  'Informes Looker': { area: 'ar-bi', service: 'sv-looker' },
  'Reclamaciones  de Clientes': { area: 'ar-neg', service: 'sv-reclam' },
  'Seguimiento Operativo Infoser/Diglo': { area: 'ar-neg', service: 'sv-seg' },
  'Solicitud Waiver': { area: 'ar-neg', service: 'sv-waiver' },
};

/** Elemento (N3) por nombre del `item` legacy dentro del servicio (match por inclusión,
 *  case-insensitive). Devuelve el id del ElementNode o undefined. */
export function resolveElementByName(serviceId: string, itemName: string | undefined, tree: AreaNode[] = DIGLO_CLASSIFICATION_V3): string | undefined {
  if (!itemName) return undefined;
  const svc = tree.flatMap((a) => a.services).find((s) => s.id === serviceId);
  if (!svc?.elements?.length) return undefined;
  const n = itemName.trim().toLowerCase();
  if (!n) return undefined;
  const hit = svc.elements.find((e) => { const en = e.name.toLowerCase(); return n.includes(en) || en.includes(n); });
  return hit?.id;
}

/** Clasifica un ticket a v3 desde las señales de SDP. Plantilla primero; luego
 *  categoría de servicio; si nada casa → «Sin clasificar». */
export function classifyToV3(
  input: { template?: string; serviceCategory?: string; item?: string },
  tree: AreaNode[] = DIGLO_CLASSIFICATION_V3,
): V3Ref {
  const t = input.template?.trim();
  const sc = input.serviceCategory?.trim();
  const base = (t && TEMPLATE_TO_V3[t]) || (sc && SC_TO_V3[sc]) || SIN_CLASIFICAR;
  const element = base.service !== SIN_CLASIFICAR.service ? resolveElementByName(base.service, input.item, tree) : undefined;
  return element ? { area: base.area, service: base.service, element } : { area: base.area, service: base.service };
}

/** ¿El ticket quedó sin mapear? */
export const isUnclassified = (r: V3Ref): boolean => r.area === SIN_CLASIFICAR.area;
