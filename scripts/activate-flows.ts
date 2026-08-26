// Sprint 2 — «flujos por fuera»: cablea los ciclos de vida (ya existentes en el tenant,
// importados de SDP) a los nodos del árbol de clasificación v3, más el campo F13
// «Funcionalidad» (opcional, valores pendientes de negocio). El motor ya resuelve el ciclo
// por servicio+tipo (lifecycleFor → clsSvc.lifecycleByType[type]) y las aprobaciones por
// servicio; aquí solo PATCHEAMOS el classificationTree. Reversible (restaurar el árbol).
//
//   dry-run (por defecto): NO escribe; muestra qué nodos se cablearían.
//   --apply: patchea classificationTree.
//   --with-f13: además adjunta el FieldDef «Funcionalidad» (options vacías) a los servicios BI.
//   GOOGLE_CLOUD_PROJECT=diglo-desk-pd TENANT=diglo-it npx tsx scripts/activate-flows.ts
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import type { AreaNode, ServiceNode, FieldDef, TicketType, ApprovalLevelDef } from '../src/model.js';

const APPLY = process.argv.includes('--apply');
const WITH_F13 = process.argv.includes('--with-f13');
const PROJECT = process.env.GOOGLE_CLOUD_PROJECT ?? 'diglo-desk-pd';
const TENANT = process.env.TENANT ?? 'diglo-it';

// Ciclos de vida REALES del tenant (ids de SDP; verificados contra la colección al arrancar).
const LC = {
  incidencias: '9207000000949173',   // RLC - Incidencias v1.0 (incident)
  liquidaciones: '9207000002883136', // Operaciones - Liquidaciones Informativas Deuda (service_request)
  alta: '9207000003075231',          // Alta de usuarios internos (service_request)
  baja: '9207000003083634',          // Baja de usuarios (service_request)
} as const;

// F13 — «Funcionalidad». Valores PENDIENTES de Elena (REO) y Bea (BI): options vacías → el
// formulario lo pinta como texto libre hasta que se definan. Se adjunta solo con --with-f13.
const FUNC_FIELD: FieldDef = { id: 'funcionalidad', label: 'Funcionalidad', type: 'select', options: [], requesterVisible: true, col: 2 };

// L3 — aprobación de Altas/Bajas. Aprobadores confirmados por negocio: Silvia Flores (sflores) +
// Virginia Nef (vnef); rule 'any' = basta con que apruebe uno. «Aviso a Nuria» NO se modela aquí
// (el nivel de aprobación solo lleva aprobadores, no avisados) — pendiente de regla de notificación.
const APPROVERS_ALTABAJA: ApprovalLevelDef[] = [
  { id: 'al-altabaja-1', name: 'Visto bueno responsable', approverUids: ['9207000000198415', '9207000000199884'], rule: 'any' },
];

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

interface Patch { lifecycleByType?: Partial<Record<TicketType, string | null>>; allowedTypes?: TicketType[]; fields?: FieldDef[]; approvalLevels?: ApprovalLevelDef[] }

// Regla de cableado por (categoría, servicio). `svcMatch` casa por nombre normalizado.
function patchFor(catName: string, svcName: string): Patch | null {
  const c = norm(catName), s = norm(svcName);
  if (c === 'operaciones' && s.startsWith('liquidaciones'))
    return { lifecycleByType: { service_request: LC.liquidaciones }, allowedTypes: ['service_request'] };
  if (c === 'gestion managers' && s.startsWith('alta de usuario'))
    return { lifecycleByType: { service_request: LC.alta }, allowedTypes: ['service_request'], approvalLevels: APPROVERS_ALTABAJA };
  if (c === 'gestion managers' && s.startsWith('baja de usuario'))
    return { lifecycleByType: { service_request: LC.baja }, allowedTypes: ['service_request'], approvalLevels: APPROVERS_ALTABAJA };
  if (c === 'reclamaciones de clientes')
    return { lifecycleByType: { incident: LC.incidencias } }; // flujo definido; intake web = integración externa (fuera de alcance)
  if (WITH_F13 && c === 'visualizacion de informes')
    return { fields: [FUNC_FIELD] }; // BI
  return null;
}

initializeApp({ projectId: PROJECT });
const db = getFirestore();

async function main(): Promise<void> {
  const root = (await db.doc(`tenants/${TENANT}`).get()).data() ?? {};
  const tree = (root.classificationTree ?? []) as AreaNode[];
  if (!tree.length) { console.error('No hay classificationTree (¿v3 activado?).'); process.exit(1); }

  // Verificar que los ciclos existen y están publicados.
  const lcs = (await db.collection(`tenants/${TENANT}/lifecycles`).get()).docs.map((d) => ({ id: d.id, name: String(d.data().name ?? ''), published: !!d.data().published }));
  const byId = new Map(lcs.map((l) => [l.id, l]));
  console.log('=== CICLOS referenciados ===');
  for (const [k, id] of Object.entries(LC)) {
    const l = byId.get(id);
    console.log(`  ${l ? (l.published ? '✓' : '⚠ no publicado') : '✗ NO EXISTE'}  ${k} → ${l?.name ?? id}`);
    if (!l) { console.error(`\nERROR: el ciclo ${id} (${k}) no existe en el tenant. Aborto.`); process.exit(1); }
  }

  const changes: { path: string; patch: Patch }[] = [];
  const applyPatch = (svc: ServiceNode, p: Patch) => {
    if (p.lifecycleByType) svc.lifecycleByType = { ...(svc.lifecycleByType ?? {}), ...p.lifecycleByType };
    if (p.allowedTypes) svc.allowedTypes = p.allowedTypes;
    if (p.fields) svc.fields = [...(svc.fields ?? []).filter((f) => !p.fields!.some((nf) => nf.id === f.id)), ...p.fields];
    if (p.approvalLevels) svc.approvalLevels = p.approvalLevels;
  };
  for (const area of tree) for (const svc of area.services) {
    const p = patchFor(area.name, svc.name);
    if (p) { changes.push({ path: `${area.name} › ${svc.name}`, patch: p }); applyPatch(svc, p); }
  }

  console.log(`\n=== NODOS A CABLEAR (${changes.length}) ===`);
  for (const ch of changes) {
    const bits: string[] = [];
    if (ch.patch.lifecycleByType) for (const [ty, id] of Object.entries(ch.patch.lifecycleByType)) bits.push(`${ty}→${byId.get(id as string)?.name ?? id}`);
    if (ch.patch.allowedTypes) bits.push(`solo [${ch.patch.allowedTypes.join(',')}]`);
    if (ch.patch.fields) bits.push(`+campo ${ch.patch.fields.map((f) => f.label).join(',')}`);
    if (ch.patch.approvalLevels) bits.push(`aprob. [${ch.patch.approvalLevels.flatMap((l) => l.approverUids).join(',')}] (${ch.patch.approvalLevels[0]!.rule})`);
    console.log(`  • ${ch.path}: ${bits.join(' · ')}`);
  }

  if (!WITH_F13) console.log(`\n(F13 «Funcionalidad» NO incluido; añade --with-f13. Valores pendientes de Elena/Bea; ubicación REO pendiente — los elementos N3 no llevan campos, iría a nivel de servicio.)`);
  console.log(`\nNOTA: aprobación altas/bajas = Silvia Flores + Virginia Nef (rule any). «Aviso a Nuria» NO\nse modela en approvalLevels (solo aprobadores) → pendiente de regla de notificación aparte.`);

  if (APPLY) {
    await db.doc(`tenants/${TENANT}`).set({ classificationTree: tree }, { merge: true });
    console.log(`\n✓ APLICADO: ${changes.length} nodos cableados en classificationTree.`);
    console.log(`  Rollback: restaurar classificationTree del backup, o re-ejecutar el activador del árbol.`);
  } else {
    console.log(`\n(dry-run: NO se ha escrito nada. Revisa y añade --apply.)`);
  }
}
main().catch((e) => { console.error('ERROR:', (e as Error).message); process.exit(1); });
