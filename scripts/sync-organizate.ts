// Puente ticketIN → OrganiZate: refleja las TAREAS de los tickets (de los grupos de
// soporte activados) como TAREAS de OrganiZate, para que sumen a la CARGA real del
// técnico. Crear al asignar, cerrar al cerrar. Idempotente, con dry-run.
//
// OrganiZate guarda TODO su estado en un único doc `orgs/{ORG_ID}/state/app`
// = { payload: <AppState JSON>, rev }. Escribimos con TRANSACCIÓN (guardia por rev)
// y tocamos SOLO las tareas que este puente crea (marcadas `sourceticketINTaskId`);
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

interface AtTask { id: string; text: string; done: boolean; assigneeUid?: string | null; startAt?: number | null; dueAt?: number | null; estimatedHours?: number }
interface AtTicket { id: string; groupId?: string | null; technicianId?: string | null; status?: string; priority?: string; subject?: string; tasks?: AtTask[]; statusHistory?: { from?: number }[] }
interface OrgTask { id: string; title: string; projectId: string | null; startDate: string; endDate: string; estimatedHours: number; priority: string; status: string; assigneeId?: string | null; sourceticketINTaskId?: string; sourceticketINTicketId?: string }

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
  console.log(`${DRY ? '=== DRY-RUN === ' : ''}Sync ticketIN(${ATENZA_PROJECT}/${TENANT}) → OrganiZate(${ORG_PROJECT}/orgs/${ORG_ID}).`);
  const { adb, odb } = initDbs();

  // 1) ticketIN: miembros (uid→email) + tickets. El grupo del ticket NO bloquea: se
  // procesan TODOS los tickets. El único gate es que el asignado (o el técnico del ticket)
  // exista en OrganiZate. `SYNC_GROUPS` sigue como filtro OPCIONAL para pruebas.
  const syncGroups: string[] = process.env.SYNC_GROUPS ? process.env.SYNC_GROUPS.split(',').map((x) => x.trim()).filter(Boolean) : [];
  const memSnap = await adb.collection(`tenants/${TENANT}/members`).get();
  const emailByUid = new Map<string, string>();
  const techEmails = new Set<string>();
  for (const d of memSnap.docs) { const m = d.data() as { email?: string; role?: string }; if (m.email) { emailByUid.set(d.id, m.email.toLowerCase()); if (m.role !== 'requester') techEmails.add(m.email.toLowerCase()); } }
  const tkSnap = await adb.collection(`tenants/${TENANT}/tickets`).get();
  const tickets = tkSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<AtTicket, 'id'>) })) as AtTicket[];
  const groupsSnap = await adb.collection(`tenants/${TENANT}/groups`).get();
  const groupName = new Map(groupsSnap.docs.map((d) => [d.id, (d.data() as { name?: string }).name ?? d.id]));
  console.log(`ticketIN: ${tickets.length} tickets · ${emailByUid.size} miembros (${techEmails.size} técnicos).`);

  // 2) OrganiZate: modelo SHARDED (un doc por tipo de dato: orgs/{ORG_ID}/state/{clave},
  //    payload = JSON del array de ESE tipo). Leemos los shards `members` (identidad)
  //    y `tasks`. Fallback al doc legacy `app` (modelo antiguo de doc único) si aún
  //    no se hubiera migrado. El puente escribe SOLO el shard `tasks` (sin contender
  //    con el resto del estado de OrganiZate).
  const membersRef = odb.doc(`orgs/${ORG_ID}/state/members`);
  const tasksRef = odb.doc(`orgs/${ORG_ID}/state/tasks`);
  const [membersSnap, tasksSnap] = await Promise.all([membersRef.get(), tasksRef.get()]);
  const sharded = tasksSnap.exists || membersSnap.exists;
  let orgMembers: { id: string; email?: string }[] = [];
  let orgTasks: OrgTask[] = [];
  if (sharded) {
    orgMembers = JSON.parse((membersSnap.data()?.payload as string | undefined) ?? '[]') as typeof orgMembers;
    orgTasks = JSON.parse((tasksSnap.data()?.payload as string | undefined) ?? '[]') as OrgTask[];
  } else {
    const legacy = await odb.doc(`orgs/${ORG_ID}/state/app`).get();
    if (!legacy.exists) { console.error(`OrganiZate ${ORG_PROJECT}: no hay shards ni doc legacy en orgs/${ORG_ID}/state.`); process.exit(1); }
    const env = JSON.parse((legacy.data()?.payload as string | undefined) ?? '{}') as { state?: { members?: typeof orgMembers; tasks?: OrgTask[] } };
    orgMembers = env.state?.members ?? []; orgTasks = env.state?.tasks ?? [];
  }
  const orgIdByEmail = new Map<string, string>();
  for (const m of orgMembers) if (m.email) orgIdByEmail.set(m.email.toLowerCase(), m.id);
  const orgUidOf = (uid?: string | null): string | null => { if (!uid) return null; const e = emailByUid.get(uid); return e ? orgIdByEmail.get(e) ?? null : null; };

  // Diagnóstico de identidad (email técnico ticketIN ↔ miembro OrganiZate)
  const matched = [...techEmails].filter((e) => orgIdByEmail.has(e));
  console.log(`OrganiZate (${sharded ? 'sharded' : 'legacy'}): ${orgMembers.length} miembros · ${orgTasks.length} tareas.`);
  console.log(`Correspondencia de identidad: ${matched.length}/${techEmails.size} técnicos de ticketIN casan con un miembro de OrganiZate (por email).`);
  if (matched.length < techEmails.size) { const miss = [...techEmails].filter((e) => !orgIdByEmail.has(e)); console.log(`  Sin casar (${miss.length}): ${miss.slice(0, 8).join(', ')}${miss.length > 8 ? '…' : ''}`); }

  console.log(syncGroups.length
    ? `Filtro de grupos (SYNC_GROUPS): ${syncGroups.map((g) => groupName.get(g) ?? g).join(', ')}`
    : 'Sin filtro de grupo: se procesan TODOS los tickets (gate = el asignado/técnico existe en OrganiZate).');

  // 3) Tareas deseadas en OrganiZate (a partir de las tareas de ticketIN en grupos activados)
  const desired: OrgTask[] = [];
  let skippedNoAssignee = 0, skippedNoMap = 0;
  for (const t of tickets) {
    if (syncGroups.length && !(t.groupId && syncGroups.includes(t.groupId))) continue; // filtro OPCIONAL
    const closed = CLOSED_RE.test(t.status ?? '');
    for (const task of t.tasks ?? []) {
      // El «usuario» de la tarea = su asignado; si no lo tiene, el técnico del ticket
      // («una tarea en mi ticket es mi carga»). Solo pasa a OrganiZate si ese usuario existe allí.
      const assigneeUid = task.assigneeUid ?? t.technicianId ?? null;
      if (!assigneeUid) { skippedNoAssignee++; continue; }
      const assigneeId = orgUidOf(assigneeUid);
      if (!assigneeId) { skippedNoMap++; continue; }
      // Fechas previstas de la tarea (las que fija el técnico en ticketIN); si faltan, se derivan:
      // inicio = hoy, fin = vencimiento (o inicio/hoy). Se garantiza inicio ≤ fin.
      const today = todayIso();
      const start = task.startAt ? iso(task.startAt) : today;
      let end = task.dueAt ? iso(task.dueAt) : (start > today ? start : today);
      if (end < start) end = start;
      desired.push({
        id: `atz-${t.id}-${task.id}`,
        title: `[${t.id}] ${task.text}`,
        projectId: null,
        startDate: start,
        endDate: end,
        estimatedHours: task.estimatedHours != null ? task.estimatedHours : DEFAULT_HOURS,
        priority: mapPriority(t.priority),
        status: (task.done || closed) ? 'done' : 'in_progress',
        assigneeId,
        sourceticketINTaskId: task.id,
        sourceticketINTicketId: t.id,
      });
    }
  }

  // 4) Reconciliar: conservar tareas propias de OrganiZate; sustituir el conjunto
  //    de tareas-puente por `desired`.
  // Marcador de tarea-puente: el actual `sourceticketINTaskId` o el antiguo
  // `sourceAtenzaTaskId` (previo al renombrado) — así se limpian los huérfanos viejos.
  const isBridge = (x: OrgTask & { sourceAtenzaTaskId?: string }) => !!(x.sourceticketINTaskId || x.sourceAtenzaTaskId);
  const own = orgTasks.filter((x) => !isBridge(x));
  const prevBridge = orgTasks.filter((x) => isBridge(x));
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
  // `prevBridge.length !== desired.length` detecta DUPLICADOS por id (misma tarea escrita
  // con marcador viejo y nuevo): la comparación por id no los ve, pero reescribir dedup­lica.
  if (added === 0 && updated === 0 && removed === 0 && prevBridge.length === desired.length) {
    console.log('Sin cambios en las tareas-puente → no se escribe (se evita contención).');
    return;
  }

  // 5) Escribir. Modelo sharded → transacción SOLO sobre el shard `tasks` (re-lee
  //    en la transacción y conserva las tareas propias actuales; toca solo las del
  //    puente). La transacción de Firestore reintenta ante escritura concurrente.
  if (sharded) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await odb.runTransaction(async (tx) => {
          const cur = await tx.get(tasksRef);
          const curRev = (cur.data()?.rev as number | undefined) ?? 0;
          const curTasks = JSON.parse((cur.data()?.payload as string | undefined) ?? '[]') as OrgTask[];
          const curOwn = curTasks.filter((x) => !x.sourceticketINTaskId);
          // merge:true conserva `version` y demás campos del shard.
          tx.set(tasksRef, { payload: JSON.stringify([...curOwn, ...desired]), rev: curRev + 1, updatedAt: new Date() }, { merge: true });
        });
        console.log('Aplicado en OrganiZate (shard `tasks`).');
        return;
      } catch (e) { console.warn(`Reintento ${attempt + 1}: ${(e as Error).message}`); }
    }
    console.error('No se pudo escribir el shard `tasks` tras varios reintentos.'); process.exit(1);
  } else {
    // Fallback legacy: doc único `app` con envoltorio { state, version }.
    const ref = odb.doc(`orgs/${ORG_ID}/state/app`);
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await odb.runTransaction(async (tx) => {
          const cur = await tx.get(ref);
          const curRev = (cur.data()?.rev as number | undefined) ?? 0;
          const curEnv = JSON.parse((cur.data()?.payload as string | undefined) ?? '{}') as { state?: { tasks?: OrgTask[] }; version?: number };
          const curState = (curEnv.state ?? {}) as { tasks?: OrgTask[] };
          const curOwn = (curState.tasks ?? []).filter((x) => !x.sourceticketINTaskId);
          const mergedEnv = { ...curEnv, state: { ...curState, tasks: [...curOwn, ...desired] } };
          tx.set(ref, { payload: JSON.stringify(mergedEnv), rev: curRev + 1, updatedAt: new Date() }, { merge: true });
        });
        console.log('Aplicado en OrganiZate (doc legacy `app`).');
        return;
      } catch (e) { console.warn(`Reintento ${attempt + 1}: ${(e as Error).message}`); }
    }
    console.error('No se pudo escribir el doc legacy tras varios reintentos.'); process.exit(1);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
