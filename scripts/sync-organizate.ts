// Puente Atenza → OrganiZate: refleja las TAREAS de los tickets (de los grupos de
// soporte activados) como TAREAS de OrganiZate, para que sumen a la CARGA real del
// técnico. Crear al asignar, cerrar al cerrar. Idempotente, con dry-run.
//
// OrganiZate guarda TODO su estado en un único doc `orgs/{ORG_ID}/state/app`
// = { payload: <AppState JSON>, rev }. Escribimos con TRANSACCIÓN (guardia por rev)
// y tocamos SOLO las tareas que este puente crea (marcadas `sourceAtenzaTaskId`);
// nunca las tareas propias del equipo.
//
//   GOOGLE_APPLICATION_CREDENTIALS=<adc-owner-de-ambos> \
//   TENANT=diglo-it npx tsx scripts/sync-organizate.ts            (aplica)
//   ...  DRY_RUN=1 npx tsx scripts/sync-organizate.ts             (previsualiza)
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';

const ATENZA_PROJECT = process.env.ATENZA_PROJECT ?? 'diglo-desk-pd';
const ORG_PROJECT = process.env.ORGANIZATE_PROJECT ?? 'diglo-organizate-pd';
const TENANT = process.env.TENANT ?? 'diglo-it';
const ORG_ID = process.env.ORGANIZATE_ORG_ID ?? 'diglo';
const DEFAULT_HOURS = Number(process.env.DEFAULT_TASK_HOURS ?? 1);
const DRY = process.env.DRY_RUN === '1' || process.argv.includes('--dry-run');

interface AtTask { id: string; text: string; done: boolean; assigneeUid?: string | null; dueAt?: number | null; estimatedHours?: number }
interface AtTicket { id: string; groupId?: string | null; status?: string; priority?: string; subject?: string; tasks?: AtTask[]; statusHistory?: { from?: number }[] }
interface OrgTask { id: string; title: string; projectId: string | null; startDate: string; endDate: string; estimatedHours: number; priority: string; status: string; assigneeId?: string | null; sourceAtenzaTaskId?: string; sourceAtenzaTicketId?: string }

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const todayIso = () => new Date().toISOString().slice(0, 10);
const CLOSED_RE = /cerrad|resuelt|cancelad|closed|resolved/i;
const mapPriority = (p?: string): string => { const n = (p ?? '').toLowerCase(); if (/crit|alta|high|urgen/.test(n)) return 'high'; if (/baja|low/.test(n)) return 'low'; return 'medium'; };

function initDbs(): { adb: Firestore; odb: Firestore } {
  const atenzaApp = initializeApp({ projectId: ATENZA_PROJECT }, 'atenza');
  const orgApp = initializeApp({ projectId: ORG_PROJECT }, 'organizate');
  return { adb: getFirestore(atenzaApp), odb: getFirestore(orgApp) };
}

async function main() {
  console.log(`${DRY ? '=== DRY-RUN === ' : ''}Sync Atenza(${ATENZA_PROJECT}/${TENANT}) → OrganiZate(${ORG_PROJECT}/orgs/${ORG_ID}).`);
  const { adb, odb } = initDbs();

  // 1) Atenza: config de grupos integrados + miembros (uid→email) + tickets
  const tSnap = await adb.doc(`tenants/${TENANT}`).get();
  const envGroups = process.env.SYNC_GROUPS ? process.env.SYNC_GROUPS.split(',').map((x) => x.trim()).filter(Boolean) : null;
  const syncGroups: string[] = envGroups ?? ((tSnap.data()?.organizateGroupIds as string[] | undefined) ?? []);
  const memSnap = await adb.collection(`tenants/${TENANT}/members`).get();
  const emailByUid = new Map<string, string>();
  const techEmails = new Set<string>();
  for (const d of memSnap.docs) { const m = d.data() as { email?: string; role?: string }; if (m.email) { emailByUid.set(d.id, m.email.toLowerCase()); if (m.role !== 'requester') techEmails.add(m.email.toLowerCase()); } }
  const tkSnap = await adb.collection(`tenants/${TENANT}/tickets`).get();
  const tickets = tkSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<AtTicket, 'id'>) })) as AtTicket[];
  const groupsSnap = await adb.collection(`tenants/${TENANT}/groups`).get();
  const groupName = new Map(groupsSnap.docs.map((d) => [d.id, (d.data() as { name?: string }).name ?? d.id]));
  console.log(`Atenza: ${tickets.length} tickets · ${emailByUid.size} miembros (${techEmails.size} técnicos).`);

  // 2) OrganiZate: doc de estado → members (email→id) + tasks actuales
  const ref = odb.doc(`orgs/${ORG_ID}/state/app`);
  const snap = await ref.get();
  if (!snap.exists) { console.error(`El doc orgs/${ORG_ID}/state/app no existe en ${ORG_PROJECT}.`); process.exit(1); }
  const rev = (snap.data()?.rev as number | undefined) ?? 0;
  // El payload es el envoltorio de zustand-persist: { state: AppState, version }.
  const env = JSON.parse((snap.data()?.payload as string | undefined) ?? '{}') as { state?: Record<string, unknown>; version?: number };
  const state = (env.state ?? env) as { members?: { id: string; email?: string }[]; tasks?: OrgTask[] };
  const orgIdByEmail = new Map<string, string>();
  for (const m of state.members ?? []) if (m.email) orgIdByEmail.set(m.email.toLowerCase(), m.id);
  const orgUidOf = (uid?: string | null): string | null => { if (!uid) return null; const e = emailByUid.get(uid); return e ? orgIdByEmail.get(e) ?? null : null; };

  // Diagnóstico de identidad (email técnico Atenza ↔ miembro OrganiZate)
  const matched = [...techEmails].filter((e) => orgIdByEmail.has(e));
  console.log(`OrganiZate: ${state.members?.length ?? 0} miembros · ${(state.tasks ?? []).length} tareas.`);
  console.log(`Correspondencia de identidad: ${matched.length}/${techEmails.size} técnicos de Atenza casan con un miembro de OrganiZate (por email).`);
  if (matched.length < techEmails.size) { const miss = [...techEmails].filter((e) => !orgIdByEmail.has(e)); console.log(`  Sin casar (${miss.length}): ${miss.slice(0, 8).join(', ')}${miss.length > 8 ? '…' : ''}`); }

  if (!syncGroups.length) {
    console.log('\nNingún grupo activado (tenant.organizateGroupIds vacío). Grupos disponibles y su carga potencial:');
    const byGroup = new Map<string, { tickets: number; tasks: number }>();
    for (const t of tickets) { if (!t.groupId) continue; const g = byGroup.get(t.groupId) ?? { tickets: 0, tasks: 0 }; g.tickets++; g.tasks += (t.tasks?.length ?? 0); byGroup.set(t.groupId, g); }
    for (const [gid, c] of [...byGroup.entries()].sort((a, b) => b[1].tasks - a[1].tasks).slice(0, 15)) console.log(`  ${groupName.get(gid) ?? gid} (${gid}): ${c.tickets} tickets · ${c.tasks} tareas`);
    console.log('\nActiva grupos en Atenza → Administración → Integración OrganiZate (o SYNC_GROUPS=id1,id2 para probar). Nada que sincronizar.');
    return;
  }
  console.log(`Grupos activados: ${syncGroups.map((g) => groupName.get(g) ?? g).join(', ')}`);

  // 3) Tareas deseadas en OrganiZate (a partir de las tareas de Atenza en grupos activados)
  const desired: OrgTask[] = [];
  let skippedNoAssignee = 0, skippedNoMap = 0;
  for (const t of tickets) {
    if (!t.groupId || !syncGroups.includes(t.groupId)) continue;
    const closed = CLOSED_RE.test(t.status ?? '');
    for (const task of t.tasks ?? []) {
      if (!task.assigneeUid) { skippedNoAssignee++; continue; }
      const assigneeId = orgUidOf(task.assigneeUid);
      if (!assigneeId) { skippedNoMap++; continue; }
      // La carga es trabajo ACTUAL: empieza hoy y termina en el vencimiento (o hoy).
      // No usamos la creación del ticket (puede ser de hace meses → carga diluida).
      const today = todayIso();
      const end = task.dueAt ? iso(task.dueAt) : today;
      desired.push({
        id: `atz-${t.id}-${task.id}`,
        title: `[${t.id}] ${task.text}`,
        projectId: null,
        startDate: end < today ? end : today,
        endDate: end < today ? today : end,
        estimatedHours: task.estimatedHours != null ? task.estimatedHours : DEFAULT_HOURS,
        priority: mapPriority(t.priority),
        status: (task.done || closed) ? 'done' : 'in_progress',
        assigneeId,
        sourceAtenzaTaskId: task.id,
        sourceAtenzaTicketId: t.id,
      });
    }
  }

  // 4) Reconciliar: conservar tareas propias de OrganiZate; sustituir el conjunto
  //    de tareas-puente por `desired`.
  const own = (state.tasks ?? []).filter((x) => !x.sourceAtenzaTaskId);
  const prevBridge = (state.tasks ?? []).filter((x) => x.sourceAtenzaTaskId);
  const prevById = new Map(prevBridge.map((x) => [x.id, x]));
  const desiredIds = new Set(desired.map((x) => x.id));
  let added = 0, updated = 0, unchanged = 0;
  for (const d of desired) { const p = prevById.get(d.id); if (!p) added++; else if (JSON.stringify({ ...p }) !== JSON.stringify({ ...d })) updated++; else unchanged++; }
  const removed = prevBridge.filter((x) => !desiredIds.has(x.id)).length;
  const nextTasks = [...own, ...desired];

  console.log(`Tareas-puente: +${added} nuevas · ~${updated} actualizadas · =${unchanged} sin cambios · -${removed} retiradas.`);
  console.log(`OrganiZate: ${own.length} tareas propias (intactas) + ${desired.length} del puente = ${nextTasks.length} totales.`);
  if (skippedNoAssignee || skippedNoMap) console.log(`Omitidas: ${skippedNoAssignee} sin responsable · ${skippedNoMap} sin correspondencia de identidad (email no casa con miembro de OrganiZate).`);

  if (DRY) {
    console.log('\nMuestra (hasta 8):');
    for (const d of desired.slice(0, 8)) console.log(`  ${d.status === 'done' ? '✓' : '·'} ${d.title} → ${d.assigneeId} · ${d.estimatedHours}h · ${d.status}`);
    console.log('\nDRY-RUN: nada escrito en OrganiZate.');
    return;
  }

  // Si no hay ningún cambio en las tareas-puente, NO escribir: evita subir `rev` y
  // contender con la app en vivo cada pasada (el doc de OrganiZate se reescribe entero).
  if (added === 0 && updated === 0 && removed === 0) {
    console.log('Sin cambios en las tareas-puente → no se escribe (se evita contención).');
    return;
  }

  // 5) Escribir con transacción (guardia por rev; reintentos ante conflicto)
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await odb.runTransaction(async (tx) => {
        const cur = await tx.get(ref);
        const curRev = (cur.data()?.rev as number | undefined) ?? 0;
        const curEnv = JSON.parse((cur.data()?.payload as string | undefined) ?? '{}') as { state?: { tasks?: OrgTask[] }; version?: number };
        const curState = (curEnv.state ?? curEnv) as { tasks?: OrgTask[] };
        const curOwn = (curState.tasks ?? []).filter((x) => !x.sourceAtenzaTaskId);
        const mergedState = { ...curState, tasks: [...curOwn, ...desired] };
        const mergedEnv = curEnv.state ? { ...curEnv, state: mergedState } : mergedState;
        tx.set(ref, { payload: JSON.stringify(mergedEnv), rev: curRev + 1, updatedAt: new Date() }, { merge: true });
      });
      console.log(`Aplicado en OrganiZate (rev previo ${rev}).`);
      return;
    } catch (e) { console.warn(`Reintento ${attempt + 1}: ${(e as Error).message}`); }
  }
  console.error('No se pudo escribir tras varios reintentos (conflictos de rev).'); process.exit(1);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
