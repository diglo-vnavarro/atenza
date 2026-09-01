// Crea los 9 informes de Elena Andrés (REO por canal CRM/WEB + Reclamaciones) como informes GUARDADOS
// en la carpeta «Informes REO», programados semanalmente SOLO a eandres@ por ahora. Idempotente (ids fijos).
//   GOOGLE_CLOUD_PROJECT=diglo-desk-pd TENANT=diglo-it npx tsx scripts/create-reo-reports.ts
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { AVAILABLE_COLUMNS, filterableColumns, type SavedReport, type ReportColumn, type ReportScope } from '../src/reports.js';

const TENANT = process.env.TENANT ?? 'diglo-it';
initializeApp({ projectId: process.env.GOOGLE_CLOUD_PROJECT ?? 'diglo-desk-pd' });
const db = getFirestore();
const NOW = Date.now();
const REO_CRM = '9207000001900239', REO_WEB = '9207000001900291';
const cols = (...keys: string[]): ReportColumn[] => keys.map((k) => AVAILABLE_COLUMNS.find((c) => c.key === k) ?? { key: k, label: k });
const gscope = (label: string, value: string): ReportScope => ({ label, field: 'group', value });
const tscope = (label: string, value: string): ReportScope => ({ label, field: 'template', value });

// Resuelve el email a su uid REAL de login (Firebase). Los miembros de SDP pueden tener varias
// fichas (id SDP + id sintético); el idmap las mapea al uid real. El informe debe ir a nombre del
// uid real para que el dueño pueda editarlo (check `ownerUid === uid()` en UI y reglas).
async function findUid(email: string): Promise<{ uid: string; name: string }> {
  const idmap: Record<string, string> = {};
  (await db.collection(`tenants/${TENANT}/idmap`).get()).forEach((d) => { const u = d.data().uid as string | undefined; if (u) idmap[d.id] = u; });
  const ms = await db.collection(`tenants/${TENANT}/members`).get();
  let r = { uid: '_system', name: 'Elena Andrés' };
  ms.forEach((d) => { if ((d.data().email || '').toLowerCase() === email) r = { uid: d.id, name: (d.data().name as string) ?? email }; });
  r.uid = idmap[r.uid] ?? r.uid; // → uid real de login si venía de una ficha SDP
  return r;
}

async function main() {
  const owner = await findUid('eandres@digloservicer.com');
  console.log('Propietaria:', owner.uid, owner.name);
  const base = (id: string, name: string, extra: Partial<SavedReport>): SavedReport => {
    const c = extra.columns ?? [];
    return {
      id, name, folder: 'Informes REO', kind: 'table', dimension: 'group', period: 'none',
      ownerUid: owner.uid, ownerName: owner.name, accessibility: 'public', createdAt: NOW,
      filterCols: filterableColumns(c),
      schedule: { unit: 'week', recipients: ['eandres@digloservicer.com'], enabled: true },
      ...extra,
    };
  };
  const CREATED = cols('id', 'udf:udf_char129', 'udf:udf_char149', 'subject', 'requester', 'category', 'createdAt', 'status', 'technician', 'group', 'templateName');
  const CLOSED = cols('id', 'udf:udf_char129', 'udf:udf_char149', 'subject', 'requester', 'category', 'createdAt', 'resolvedAt', 'status', 'technician', 'group', 'templateName');
  const BACKLOG = cols('id', 'udf:udf_char129', 'udf:udf_char149', 'subject', 'priority', 'requester', 'technician', 'createdAt', 'status', 'templateName');
  const SEG_CRM = cols('id', 'requester', 'udf:udf_char129', 'subject', 'status', 'udf:udf_char146', 'priority', 'udf:udf_char149', 'technician', 'createdAt', 'udf:udf_char652', 'udf:udf_char147', 'udf:udf_char651');
  const SEG_WEB = cols('id', 'udf:udf_char129', 'subject', 'status', 'udf:udf_char146', 'priority', 'udf:udf_char149', 'udf:udf_char150', 'requester', 'technician', 'createdAt', 'resolvedAt', 'udf:udf_char652');
  // Reclamaciones: las DOS fechas de resolución con etiquetas claras (negocio vs mesa).
  const RECLAM: ReportColumn[] = [
    { key: 'id', label: 'Nº' },
    { key: 'udf:udf_datestamp1', label: 'Fecha origen incidencia' },
    { key: 'udf:udf_datestamp2', label: 'Fecha entrada en Diglo' },
    { key: 'udf:udf_date6', label: 'Resolución Diglo (negocio)' },
    { key: 'resolvedAt', label: 'Cierre del ticket (mesa)' },
    { key: 'udf:udf_char688', label: 'Dpto Propietario' },
    { key: 'udf:udf_char686', label: 'CCAA' },
    { key: 'status', label: 'Estado de solicitud' },
    { key: 'udf:udf_char690', label: 'Categoría Reclamación' },
    { key: 'udf:udf_char685', label: 'Canal NPL' },
    { key: 'udf:udf_char3', label: 'Nombre' },
    { key: 'udf:udf_char4', label: 'Apellidos' },
  ];

  const reports: SavedReport[] = [
    base('reo-created-lw-crm', 'Created Last Week CRM', { scopes: [gscope('Grupo Tecnicos REO - CRM', REO_CRM)], columns: CREATED, period: 'week', periodField: 'created' }),
    base('reo-created-lw-web', 'Created Last Week WEB', { scopes: [gscope('Grupo Tecnicos REO - WEB', REO_WEB)], columns: CREATED, period: 'week', periodField: 'created' }),
    base('reo-closed-lw-crm', 'Requests Closed Last Week CRM', { scopes: [gscope('Grupo Tecnicos REO - CRM', REO_CRM)], columns: CLOSED, period: 'week', periodField: 'resolved' }),
    base('reo-closed-lw-web', 'Requests Closed Last Week WEB', { scopes: [gscope('Grupo Tecnicos REO - WEB', REO_WEB)], columns: CLOSED, period: 'week', periodField: 'resolved' }),
    base('reo-backlog-crm', 'Open Requests CRM (Backlog)', { scopes: [gscope('Grupo Tecnicos REO - CRM', REO_CRM)], columns: BACKLOG, openOnly: true }),
    base('reo-backlog-web', 'Open Requests WEB (Backlog)', { scopes: [gscope('Grupo Tecnicos REO - WEB', REO_WEB)], columns: BACKLOG, openOnly: true }),
    base('reo-seguimiento-crm', 'Seguimiento REO CRM', { scopes: [gscope('Grupo Tecnicos REO - CRM', REO_CRM)], columns: SEG_CRM, openOnly: true }),
    base('reo-seguimiento-web', 'Seguimiento REO WEB', { scopes: [gscope('Grupo Tecnicos REO - WEB', REO_WEB)], columns: SEG_WEB, openOnly: true }),
    base('reo-reclamaciones', 'Informe Reclamaciones', { scopes: [tscope('Plantilla Reclamación', 'Plantilla Reclamación')], columns: RECLAM }),
  ];
  const batch = db.batch();
  for (const r of reports) batch.set(db.doc(`tenants/${TENANT}/reports/${r.id}`), r);
  await batch.commit();
  console.log(`✓ ${reports.length} informes creados en «Informes REO» (programados → eandres@):`);
  for (const r of reports) console.log(`   · ${r.name} [${r.periodField === 'resolved' ? 'cierre' : r.period === 'week' ? 'creación' : r.openOnly ? 'abiertos' : 'todo'}] ${r.columns!.length} col.`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
