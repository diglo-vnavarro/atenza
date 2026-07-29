// Activa la clasificación v3 en un tenant REAL: construye classificationTree con los
// GRUPOS REALES (resueltos por nombre desde tenants/{TENANT}/groups) y pone el flag
// classificationVersion='v3'. Reversible (volver a 'legacy'). Ver Fase A del plan.
//
//   dry-run (por defecto): lee grupos, resuelve y MUESTRA el árbol; NO escribe.
//   --apply: escribe classificationTree + classificationVersion='v3' en Firestore.
//
//   GOOGLE_CLOUD_PROJECT=diglo-desk-pd TENANT=diglo-it npx tsx scripts/activate-v3.ts
//   (añade --apply para escribir de verdad)
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import type { AreaNode, ServiceNode, TicketType } from '../src/model.js';

const APPLY = process.argv.includes('--apply');
const PROJECT = process.env.GOOGLE_CLOUD_PROJECT ?? 'diglo-desk-pd';
const TENANT = process.env.TENANT ?? 'diglo-it';

// Especificación por NOMBRE de grupo real (se resuelve a id contra el tenant). Derivada
// del Anexo A + análisis de resolutores. Ajusta nombres si en el tenant difieren.
interface Svc { id: string; name: string; group?: string; types?: TicketType[]; userGroups?: string[]; inactive?: boolean; elements?: string[] }
interface Area { id: string; name: string; group?: string; services: Svc[] }
const SPEC: Area[] = [
  { id: 'ar-it', name: 'IT', group: 'CAU', services: [
    { id: 'sv-inc', name: 'Incidencia general', group: 'CAU', types: ['incident'],
      elements: ['Gmail', 'Drive', 'Outlook', 'SharePoint', 'Teams', 'Citrix', 'SAP', 'OneDrive'] },
    { id: 'sv-pet', name: 'Petición general', group: 'CAU', types: ['service_request'] },
    { id: 'sv-gcp', name: 'GCP', group: 'Técnicos GCP', userGroups: ['CAU', 'IT'] },
    { id: 'sv-gemini', name: 'AI · Gemini', group: 'Tecnicos Gemini' },
    { id: 'sv-usuarios', name: 'Gestión de usuarios', group: 'CAU', types: ['service_request'],
      userGroups: ['IT', 'Usuarios alta/baja', 'Usuarios RRHH', 'Usuarios Responsable'] },
    { id: 'sv-recovery', name: 'Recovery', group: 'Tecnicos Recovery' },
    { id: 'sv-reo', name: 'Tareas REO', group: 'Tecnicos REO - CRM' },
  ] },
  { id: 'ar-ops', name: 'Operaciones', services: [
    { id: 'sv-liq', name: 'Liquidaciones de deuda', group: 'Tecnicos Operaciones', types: ['service_request'],
      userGroups: ['IT', 'Usuarios NPL', 'Usuarios Operaciones'] },
    { id: 'sv-pd', name: 'PD', group: 'Tecnicos PD', inactive: true, userGroups: ['IT', 'UserAdmin', 'Usuarios PD'] },
  ] },
  { id: 'ar-bi', name: 'BI', services: [
    { id: 'sv-bi', name: 'Solicitudes BI', group: 'Tecnicos BI', userGroups: ['IT', 'UserAdmin', 'Usuarios  BI'] },
    { id: 'sv-itsmbi', name: 'ITSM BI', group: 'Tecnicos ITSM BI' },
    { id: 'sv-looker', name: 'Informes Looker', group: 'Técnicos Informes Looker' },
  ] },
  { id: 'ar-neg', name: 'Negocio', services: [
    { id: 'sv-reclam', name: 'Reclamación', group: 'Tecnicos ReclamacionesDeuda', types: ['incident'],
      userGroups: ['IT', 'UsuariosReclamaciones'] },
    { id: 'sv-seg', name: 'Seguimiento Infoser/Diglo', group: 'Seguimiento Infoser/Diglo', userGroups: ['Infoser', 'IT'] },
    { id: 'sv-waiver', name: 'Solicitud Waiver', group: 'CAU' },
  ] },
];

initializeApp({ projectId: PROJECT });
const db = getFirestore();

async function main(): Promise<void> {
  const snap = await db.collection(`tenants/${TENANT}/groups`).get();
  const idByName = new Map<string, string>();
  snap.docs.forEach((d) => { const n = (d.data().name as string | undefined)?.trim(); if (n) idByName.set(n, d.id); });
  console.log(`Grupos en ${TENANT}: ${idByName.size}`);

  const warn: string[] = [];
  const resolve = (name?: string): string | undefined => {
    if (!name) return undefined;
    const id = idByName.get(name);
    if (!id) warn.push(`grupo NO encontrado: «${name}» (el servicio quedará sin grupo → hereda)`);
    return id;
  };

  const tree: AreaNode[] = SPEC.map((a, ai) => ({
    id: a.id, name: a.name, sortIndex: ai + 1,
    ...(resolve(a.group) ? { groupId: resolve(a.group)! } : {}),
    services: a.services.map((s, si): ServiceNode => ({
      id: s.id, name: s.name, sortIndex: si + 1,
      ...(resolve(s.group) ? { groupId: resolve(s.group)! } : {}),
      ...(s.userGroups ? { userGroups: s.userGroups } : {}),
      ...(s.types ? { allowedTypes: s.types } : {}),
      ...(s.inactive ? { inactive: true } : {}),
      ...(s.elements ? { elements: s.elements.map((n) => ({ id: 'el-' + n.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name: n })) } : {}),
    })),
  }));

  console.log(`\n=== Árbol resuelto (${tree.length} áreas) ===`);
  for (const a of tree) {
    console.log(`■ ${a.name}`);
    for (const s of a.services) console.log(`    ${s.name}${s.inactive ? ' (inactivo)' : ''} → grupo: ${s.groupId ?? '(hereda/ninguno)'}${s.userGroups ? ` · ven: ${s.userGroups.join(', ')}` : ''}`);
  }
  if (warn.length) { console.log(`\n⚠️  Avisos (${warn.length}):`); warn.forEach((w) => console.log('   - ' + w)); }

  if (APPLY) {
    await db.doc(`tenants/${TENANT}`).set({ classificationTree: tree, classificationVersion: 'v3' }, { merge: true });
    console.log(`\n✓ APLICADO: classificationTree + classificationVersion='v3' en tenants/${TENANT}.`);
    console.log(`  Rollback: set classificationVersion='legacy' (el árbol se conserva).`);
  } else {
    console.log(`\n(dry-run: NO se ha escrito nada. Revisa el árbol y los avisos; luego añade --apply.)`);
  }
}
main().catch((e) => { console.error('ERROR:', (e as Error).message); process.exit(1); });
