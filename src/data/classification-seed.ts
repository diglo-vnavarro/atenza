// Semilla de la clasificación v3 para diglo-it, derivada del Anexo A de
// docs/propuesta-taxonomia-3-niveles.md. INERTE mientras classificationVersion='legacy'.
//
// NOTA: los `groupId` usan los grupos del seed local (g-n1/g-n2/g-red) como
// marcador; en la instancia real diglo-it se mapean a los grupos reales (CAU,
// Tecnicos Gemini, Tecnicos Operaciones…) al aplicar la clasificación (Fase 2/3).
import type { AreaNode, FieldDef } from '../model.js';

// Departamentos de Diglo (lista cerrada del formulario de Altas/Bajas), derivada de los
// valores reales de SDP (udf_char673). Editable por tenant en la administración.
export const DEPARTAMENTOS_DIGLO: string[] = [
  'FIN - Financiero',
  'ITO - Tecnología',
  'ITO - Transformación',
  'NPL - DT Centralizado',
  'NPL - DT Centro',
  'NPL - DT Levante',
  'NPL - DT Norte',
  'REO - Marketing',
  'REO - Valoraciones',
  'SSJJ - Adecuación Jurídica',
  'Third Party Business',
];

// Campos del formulario de Altas/Bajas (fuente NATIVA del informe; doble fuente con el udf de
// SDP). Los ids `cf-*` deben coincidir con los que lee el informe (`dual:cf-x:udf_y`).
const cf = (id: string, label: string, type: FieldDef['type'], col: 1 | 2, mandatory = false, options?: string[]): FieldDef =>
  ({ id, label, type, mandatory, requesterVisible: true, section: 'Datos del usuario', col, ...(options ? { options } : {}) });
// ALTA: todos los datos del empleado (internos + externos; los no aplicables quedan en blanco).
export const ALTA_FIELDS: FieldDef[] = [
  cf('cf-nom', 'Nombre', 'text', 1, true), cf('cf-ape', 'Apellidos', 'text', 2, true),
  cf('cf-nif', 'NIF/CIF', 'text', 1, true), cf('cf-dep', 'Departamento', 'select', 2, false, DEPARTAMENTOS_DIGLO),
  cf('cf-cargo', 'Cargo', 'text', 1), cf('cf-rol', 'Rol / Perfil', 'text', 2),
  cf('cf-resp', 'Responsable', 'text', 1), cf('cf-ofi', 'Oficina', 'text', 2),
  cf('cf-prov', 'Proveedor', 'text', 1), cf('cf-depext', 'Departamento Ext.', 'text', 2),
  cf('cf-inc2', 'Fecha de incorporación', 'date', 1, true),
];
// BAJA: identificación del empleado + fecha de baja.
export const BAJA_FIELDS: FieldDef[] = [
  cf('cf-nom', 'Nombre', 'text', 1), cf('cf-ape', 'Apellidos', 'text', 2),
  cf('cf-nif', 'NIF/CIF', 'text', 1), cf('cf-fbaja', 'Fecha de baja', 'date', 2, true),
];
// Unión (para el seed local del servicio marcador sv-usuarios; en prod se aplican por servicio real).
export const USUARIOS_FIELDS: FieldDef[] = [...ALTA_FIELDS, cf('cf-fbaja', 'Fecha de baja', 'date', 2)];

export const DIGLO_CLASSIFICATION_V3: AreaNode[] = [
  {
    id: 'ar-it', name: 'IT', sortIndex: 1, groupId: 'g-n1',
    services: [
      { id: 'sv-inc', name: 'Incidencia general', sortIndex: 1, groupId: 'g-n1', allowedTypes: ['incident'],
        elements: [
          { id: 'el-gmail', name: 'Gmail' }, { id: 'el-drive', name: 'Drive' }, { id: 'el-outlook', name: 'Outlook' },
          { id: 'el-sharepoint', name: 'SharePoint' }, { id: 'el-teams', name: 'Teams' }, { id: 'el-citrix', name: 'Citrix' },
          { id: 'el-sap', name: 'SAP' }, { id: 'el-onedrive', name: 'OneDrive' },
        ] },
      { id: 'sv-pet', name: 'Petición general', sortIndex: 2, groupId: 'g-n1', allowedTypes: ['service_request'] },
      { id: 'sv-gcp', name: 'GCP', sortIndex: 3, groupId: 'g-n2', userGroups: ['CAU', 'IT'] },
      { id: 'sv-gemini', name: 'AI · Gemini', sortIndex: 4, groupId: 'g-n2' },
      { id: 'sv-usuarios', name: 'Gestión de usuarios', sortIndex: 5, groupId: 'g-n1', allowedTypes: ['service_request'],
        userGroups: ['IT', 'Usuarios alta/baja', 'Usuarios RRHH', 'Usuarios Responsable'], fields: USUARIOS_FIELDS },
      { id: 'sv-recovery', name: 'Recovery', sortIndex: 6, groupId: 'g-n1' },
      { id: 'sv-reo', name: 'Tareas REO', sortIndex: 7, groupId: 'g-red' },
    ],
  },
  {
    id: 'ar-ops', name: 'Operaciones', sortIndex: 2,
    services: [
      { id: 'sv-liq', name: 'Liquidaciones de deuda', sortIndex: 1, groupId: 'g-n2', allowedTypes: ['service_request'],
        userGroups: ['IT', 'Usuarios NPL', 'Usuarios Operaciones'] },
      { id: 'sv-pd', name: 'PD', sortIndex: 2, groupId: 'g-n2', inactive: true,
        userGroups: ['IT', 'UserAdmin', 'Usuarios PD'] },
    ],
  },
  {
    id: 'ar-bi', name: 'BI', sortIndex: 3,
    services: [
      { id: 'sv-bi', name: 'Solicitudes BI', sortIndex: 1, groupId: 'g-n2', userGroups: ['IT', 'UserAdmin', 'Usuarios  BI'] },
      { id: 'sv-itsmbi', name: 'ITSM BI', sortIndex: 2, groupId: 'g-n2' },
      { id: 'sv-looker', name: 'Informes Looker', sortIndex: 3, groupId: 'g-n2' },
    ],
  },
  {
    id: 'ar-neg', name: 'Negocio', sortIndex: 4,
    services: [
      { id: 'sv-reclam', name: 'Reclamación', sortIndex: 1, groupId: 'g-n1', allowedTypes: ['incident'],
        userGroups: ['IT', 'UsuariosReclamaciones'] },
      { id: 'sv-seg', name: 'Seguimiento Infoser/Diglo', sortIndex: 2, groupId: 'g-n2', userGroups: ['Infoser', 'IT'] },
      { id: 'sv-waiver', name: 'Solicitud Waiver', sortIndex: 3, groupId: 'g-n1' },
    ],
  },
];
