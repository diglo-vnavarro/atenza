// Construye el tenant `leasys` en Firestore a partir de importer/leasys-raw.json:
// config propia (estados, 1 ciclo, 13 categorías tal cual, plantillas, grupos,
// personas, prioridades, sede) + los 616 tickets (activo/archivo por estado).
// DRY por defecto (escribe leasys-tenant.json + resumen); WRITE=1 sube a Firestore.
//   GOOGLE_CLOUD_PROJECT=diglo-desk-pd npx tsx scripts/build-leasys-tenant.ts        (dry)
//   GOOGLE_CLOUD_PROJECT=diglo-desk-pd WRITE=1 npx tsx scripts/build-leasys-tenant.ts (sube)
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT ?? 'diglo-desk-pd';
const TENANT = 'leasys';
const WRITE = process.env.WRITE === '1';
const ADMIN_UID = 'QzdANMSSOuTQJWF9h18gaV0TRwo2'; // vnavarro (para revisar la instancia)
const ADMIN_EMAIL = 'vnavarro@digloservicer.com';
const here = dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(readFileSync(join(here, '..', 'importer', 'leasys-raw.json'), 'utf8')) as {
  statuses: any[]; categories: any[]; groups: any[]; technicians: any[]; requesters: any[]; priorities: any[]; sites: any[]; tickets: any[];
};
const nm = (o: any) => (o && typeof o === 'object' ? o.name : undefined);
const slug = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const PALETTE = ['#4f46e5', '#0f766e', '#b45309', '#0369a1', '#be185d', '#7c3aed', '#0891b2', '#15803d'];

// ---- estados (catálogo) + timer ----
const TERMINAL = new Set(['Closed', 'Canceled', 'Cancelled', 'Resolved']);
const timerOf = (name: string): 'in_progress' | 'stop_timer' | 'completed' =>
  TERMINAL.has(name) ? 'completed' : /hold|pendiente|pte\.|espera/i.test(name) ? 'stop_timer' : 'in_progress';
const ST_COLOR: Record<string, string> = { in_progress: '#2f6bff', stop_timer: '#b4690e', completed: '#64748b' };
const statuses = raw.statuses.map((s) => { const t = timerOf(s.name); return { name: s.name as string, timer: t, color: s.name === 'Canceled' ? '#c62b3f' : s.name === 'Resolved' ? '#0f7a52' : ST_COLOR[t] }; });

// ---- ciclo de vida único (con SUS estados) ----
const CAT: Record<string, string> = { in_progress: 'in_progress', stop_timer: 'stop_timer', completed: 'completed' };
const lcStates = raw.statuses.map((s) => ({ key: slug(s.name), label: s.name as string, stage: TERMINAL.has(s.name) ? 'closed' : 'open', category: CAT[timerOf(s.name)], ...(s.name === 'Open' ? { isInitial: true } : {}), ...(TERMINAL.has(s.name) ? { isTerminal: true } : {}) }));
const nonTerminal = lcStates.filter((s) => !(s as any).isTerminal);
const transitions = nonTerminal.flatMap((s) => lcStates.filter((d) => d.key !== s.key).map((d) => ({ from: s.key, to: d.key })));
const lifecycle = { id: 'lc-leasys', name: 'Leasys', type: 'incident', published: true, states: lcStates, transitions };

// ---- plantillas (para resolver ciclo sin categoría) ----
const templates = [
  { id: 'tpl-leasys-inc', type: 'incident', name: 'Incidencia Leasys', lifecycleId: 'lc-leasys', slaId: null, fields: ['subject', 'description', 'category', 'priority'], fieldDefs: [] },
  { id: 'tpl-leasys-sr', type: 'service_request', name: 'Petición Leasys', lifecycleId: 'lc-leasys', slaId: null, fields: ['subject', 'description', 'category', 'priority'], fieldDefs: [] },
];
// ---- 13 categorías de servicio (tal cual Leasys) ----
const serviceCategories = raw.categories.map((c, i) => ({ id: 'lsc-' + (i + 1), name: c.name as string, icon: '🗂️', incident: { lifecycleId: 'lc-leasys' }, service_request: { lifecycleId: 'lc-leasys' } }));

// ---- grupos ----
const groups = raw.groups.map((g) => ({ id: String(g.id), name: g.name as string }));
const allGroupIds = groups.map((g) => g.id);
// ---- personas (técnicos + solicitantes) ----
const mkMember = (p: any, role: string, i: number) => ({ uid: String(p.id), name: (p.name as string) || (p.email_id as string) || 'Sin nombre', email: ((p.email_id as string) ?? '').toLowerCase(), role, status: 'active', external: false, color: PALETTE[i % PALETTE.length], ...(role === 'technician' ? { groupIds: allGroupIds } : {}) });
const members = [
  { uid: ADMIN_UID, name: 'Vicente Navarro', email: ADMIN_EMAIL, role: 'tenant_admin', status: 'active', external: false, color: PALETTE[0], groupIds: allGroupIds, roleName: 'SDAdmin' },
  ...raw.technicians.map((t, i) => mkMember(t, 'technician', i)),
  ...raw.requesters.map((r, i) => mkMember(r, 'requester', i)),
].filter((m, i, arr) => m.uid !== ADMIN_UID || i === arr.findIndex((x) => x.uid === ADMIN_UID)); // dedup admin
const memberById = new Map(members.map((m) => [m.uid, m]));

// ---- prioridades / sede ----
const priorities = raw.priorities.map((p) => ({ name: p.name as string, color: '#4f46e5' }));
const sites = raw.sites.map((s) => s.name as string);

// ---- tickets ----
const idNum = (s: string) => parseInt(String(s).replace(/\D/g, ''), 10) || 0;
const tickets = raw.tickets.map((t) => {
  const created = Number((t.created_time as any)?.value) || Date.now();
  const status = (nm(t.status) as string) ?? 'Open';
  const type = t.is_service_request ? 'service_request' : 'incident';
  return {
    id: '#' + ((t.display_id as string) || String(t.id)), // mismo esquema que el sync (importer/etl.ts)
    type, subject: (t.subject as string) ?? '(sin asunto)',
    requesterId: t.requester?.id ? String(t.requester.id) : null,
    technicianId: t.technician?.id ? String(t.technician.id) : null,
    groupId: t.group?.id ? String(t.group.id) : null,
    priority: (nm(t.priority) as string) ?? 'Media',
    status, templateId: type === 'service_request' ? 'tpl-leasys-sr' : 'tpl-leasys-inc',
    archived: TERMINAL.has(status), createdAt: created,
    statusHistory: [{ state: status, from: created, to: null }],
  };
});
const counter = Math.max(1000, ...tickets.map((t) => idNum(t.id))) + 1;
const activeN = tickets.filter((t) => !t.archived).length;

const tenantDoc = {
  name: 'Leasys', key: 'leasys', active: true, categories: serviceCategories.map((c) => c.name),
  statuses, picklists: { priority: priorities }, sites, departments: [], userGroups: [],
  serviceCategories, serviceCategoryIcons: {}, operationMode: 'simplified', capacity: {}, counter,
};

async function main() {
  writeFileSync(join(here, '..', 'importer', 'leasys-tenant.json'), JSON.stringify({ tenantDoc, lifecycle, templates, groups, members, tickets }, null, 1));
  console.log(`${WRITE ? '' : '[DRY] '}Tenant leasys:`);
  console.log(`  categorías de servicio: ${serviceCategories.length} · estados: ${statuses.length} · ciclo: 1 (${lcStates.length} estados, ${transitions.length} transiciones) · plantillas: ${templates.length}`);
  console.log(`  grupos: ${groups.length} · personas: ${members.length} (téc ${raw.technicians.length} + solic ${raw.requesters.length} + admin) · sedes: ${sites.length} · prioridades: ${priorities.length}`);
  console.log(`  tickets: ${tickets.length} (${activeN} activos · ${tickets.length - activeN} archivo) · counter=${counter}`);
  const unresolvedReq = tickets.filter((t) => t.requesterId && !memberById.has(t.requesterId)).length;
  const unresolvedTech = tickets.filter((t) => t.technicianId && !memberById.has(t.technicianId)).length;
  console.log(`  aviso: ${unresolvedReq} tickets con solicitante fuera del roster · ${unresolvedTech} con técnico fuera del roster (se verán como '—').`);
  if (!WRITE) { console.log('\n[DRY] No se ha escrito en Firestore. Relanza con WRITE=1 para subir. También en importer/leasys-tenant.json.'); return; }

  initializeApp({ projectId: PROJECT });
  const db = getFirestore();
  await db.doc(`tenants/${TENANT}`).set(tenantDoc);
  await db.doc(`tenants/${TENANT}/lifecycles/${lifecycle.id}`).set(lifecycle);
  for (const tp of templates) await db.doc(`tenants/${TENANT}/templates/${tp.id}`).set(tp);
  for (const g of groups) await db.doc(`tenants/${TENANT}/groups/${g.id}`).set(g);
  let mN = 0; for (let i = 0; i < members.length; i += 400) { const b = db.batch(); for (const m of members.slice(i, i + 400)) { b.set(db.doc(`tenants/${TENANT}/members/${m.uid}`), m); mN++; } await b.commit(); }
  let tN = 0; for (let i = 0; i < tickets.length; i += 400) { const b = db.batch(); for (const t of tickets.slice(i, i + 400)) { b.set(db.doc(`tenants/${TENANT}/tickets/${t.id}`), t); tN++; } await b.commit(); }
  const { FieldValue } = await import('firebase-admin/firestore');
  await db.doc(`userTenants/${ADMIN_UID}`).set({ tenantIds: FieldValue.arrayUnion(TENANT) }, { merge: true });
  console.log(`✓ Subido: tenant + ciclo + ${templates.length} plantillas + ${groups.length} grupos + ${mN} personas + ${tN} tickets. Acceso concedido a ${ADMIN_EMAIL}.`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
