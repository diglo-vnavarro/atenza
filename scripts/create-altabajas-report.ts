// Altas y Bajas de usuarios (informe de Nuria). Idempotente. Hace TRES cosas:
//   1) Alinea el formulario nativo: fija los campos de los 4 servicios reales de alta/baja del
//      árbol v3 de prod (área «n-gestion-managers») en el classificationTree del tenant vivo.
//   2) Re-clasifica el histórico (5 plantillas SDP) a su área/servicio real vía classifyToV3
//      (mismo valor que escribirá la sync → durable), para que el ámbito por área case.
//   3) Crea el informe GUARDADO «Altas y Bajas de usuarios» (ámbito area='n-gestion-managers',
//      columnas de doble fuente nativo↔SDP), SIN envío programado (pendiente de destinatarios).
//
//   GOOGLE_CLOUD_PROJECT=diglo-desk-pd TENANT=diglo-it [NURIA_EMAIL=…] \
//     npx tsx scripts/create-altabajas-report.ts
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { ALTA_FIELDS, BAJA_FIELDS } from '../src/data/classification-seed.js';
import { classifyToV3 } from '../src/data/classification-map.js';
import { filterableColumns, type SavedReport, type ReportColumn } from '../src/reports.js';
import type { AreaNode, FieldDef } from '../src/model.js';

const TENANT = process.env.TENANT ?? 'diglo-it';
const AREA = 'n-gestion-managers';
initializeApp({ projectId: process.env.GOOGLE_CLOUD_PROJECT ?? 'diglo-desk-pd' });
const db = getFirestore();
const NOW = Date.now();

const TEMPLATES = ['Alta de usuarios internos', 'Alta de usuarios externos', 'Baja de usuario interno', 'Baja de usuario externo', 'Modificación de usuario'];
// Campos por servicio real: alta → datos completos; baja → identificación + fecha de baja.
const FIELDS_BY_SVC: Record<string, FieldDef[]> = {
  'n-gestion-managers-alta-de-usuario-interno': ALTA_FIELDS,
  'n-gestion-managers-alta-de-usuario-externo': ALTA_FIELDS,
  'n-gestion-managers-baja-de-usuario-interno': BAJA_FIELDS,
  'n-gestion-managers-baja-de-usuario-externo': BAJA_FIELDS,
};

// Dueño del informe: Nuria (resuelto a su uid de login vía idmap para que pueda editarlo).
async function findOwner(): Promise<{ uid: string; name: string }> {
  const idmap: Record<string, string> = {};
  (await db.collection(`tenants/${TENANT}/idmap`).get()).forEach((d) => { const u = d.data().uid as string | undefined; if (u) idmap[d.id] = u; });
  const email = (process.env.NURIA_EMAIL ?? '').toLowerCase();
  let r = { uid: '_system', name: 'Nuria Imedio' };
  (await db.collection(`tenants/${TENANT}/members`).get()).forEach((d) => {
    const m = d.data() as { email?: string; name?: string };
    if ((email && (m.email || '').toLowerCase() === email) || (!email && /nuria/i.test(m.name || ''))) r = { uid: d.id, name: m.name ?? 'Nuria Imedio' };
  });
  r.uid = idmap[r.uid] ?? r.uid;
  return r;
}

// 1) Alinea los campos de los 4 servicios de alta/baja en el árbol vivo (idempotente).
async function alignForm(): Promise<void> {
  const ref = db.doc(`tenants/${TENANT}`);
  const tree = ((await ref.get()).data()?.classificationTree ?? []) as AreaNode[];
  let n = 0;
  for (const area of tree) for (const svc of area.services ?? []) {
    const fields = FIELDS_BY_SVC[svc.id]; if (fields) { svc.fields = fields; n++; }
  }
  if (!n) { console.warn('⚠ No encontré los servicios de alta/baja en el árbol.'); return; }
  await ref.set({ classificationTree: tree }, { merge: true });
  console.log(`✓ Formulario alineado: ${n} servicios de alta/baja con sus campos.`);
}

// 2) Re-clasifica el histórico a su área/servicio real (durable: = lo que escribe la sync).
async function reclassifyHistory(): Promise<void> {
  let fixed = 0;
  for (const tn of TEMPLATES) {
    const v3 = classifyToV3({ template: tn });
    const snap = await db.collection(`tenants/${TENANT}/tickets`).where('templateName', '==', tn).get();
    const batch = db.batch(); let ops = 0;
    snap.forEach((d) => {
      const t = d.data() as { area?: string; service?: string };
      if (t.area !== v3.area || t.service !== v3.service) { batch.set(d.ref, { area: v3.area, service: v3.service }, { merge: true }); ops++; }
    });
    if (ops) await batch.commit();
    fixed += ops;
    console.log(`   · ${tn}: ${snap.size} tickets → ${v3.service} (${ops} actualizados)`);
  }
  console.log(`✓ Histórico re-clasificado: ${fixed} tickets movidos al área real.`);
}

// 3) Informe. Columnas en el MISMO orden que el Excel de Nuria. Doble fuente `dual:<cf>:<udf>`.
const COLS: ReportColumn[] = [
  { key: 'id', label: 'Nº' },
  { key: 'templateName', label: 'Plantilla' },
  { key: 'status', label: 'Estado de solicitud' },
  { key: 'requester', label: 'Solicitante' },
  { key: 'createdAt', label: 'Hora de creación' },
  { key: 'dual:cf-nom:udf_char3', label: 'Nombre' },
  { key: 'dual:cf-ape:udf_char4', label: 'Apellidos' },
  { key: 'dual:cf-nif:udf_char2', label: 'NIF/CIF' },
  { key: 'dual:cf-resp:udf_ref1', label: 'Responsable' },
  { key: 'dual:cf-dep:udf_char673', label: 'Departamento' },
  { key: 'dual:cf-rol:udf_char19', label: 'Rol' },
  { key: 'dual:cf-depext:udf_ref10', label: 'Departamento Ext.' },
  { key: 'dual:cf-prov:udf_char16', label: 'Proveedor' },
  { key: 'dual:cf-cargo:udf_char672', label: 'Cargo' },
  { key: 'dual:cf-ofi:udf_char667', label: 'Oficina' },
  { key: 'dual:cf-inc2:udf_date1', label: 'Fecha Incorporación' },
  { key: 'dual:cf-fbaja:udf_date5', label: 'Fecha de baja' },
];

async function main() {
  await alignForm();
  await reclassifyHistory();
  const owner = await findOwner();
  console.log('Propietaria:', owner.uid, owner.name);
  const report: SavedReport = {
    id: 'altas-bajas-usuarios', name: 'Altas y Bajas de usuarios',
    folder: 'Altas y Bajas', kind: 'table', dimension: 'group', period: 'none',
    ownerUid: owner.uid, ownerName: owner.name, accessibility: 'public', createdAt: NOW,
    scopes: [{ label: 'Gestión de usuarios (altas/bajas)', field: 'area', value: AREA }],
    columns: COLS, filterCols: filterableColumns(COLS),
    // Sin `schedule`: no se envía por email hasta confirmar destinatarios.
  };
  await db.doc(`tenants/${TENANT}/reports/${report.id}`).set(report);
  console.log(`✓ Informe «${report.name}» creado en «${report.folder}» (${COLS.length} columnas, ámbito area=${AREA}, sin envío).`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
