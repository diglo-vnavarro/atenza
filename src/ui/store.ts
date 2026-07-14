import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Lifecycle, LifecycleState, SlaCategory, Stage, Template, TicketType, Sla, FieldDef, StatusDef, NotifRule, NotifEvent, AppNotification, ReplyTemplate, Attachment } from '../model.js';
import type { User } from '../access.js';
import type { ClosureRules } from '../closure.js';
import { isClosingStatus, closureBlockers } from '../closure.js';
import { canTransition, initialState } from '../lifecycle.js';
import { makeSeed, SLA_BY_PRIORITY, type DB, type TenantData, type StoredTicket, type UiMember, type Group, type CatNode, type Picklists, type PickVal, type PriorityMatrix, type BusinessHours } from '../data/seed.js';
import { firebaseEnabled } from '../firebase.js';
import * as cloud from '../data/firestore.js';

export interface ImportSnapshot { categories: string[]; templates: Template[]; slas: Sla[]; groups: Group[]; members: UiMember[] }
export type Role = 'tenant_admin' | 'technician' | 'requester';

interface NewTicket {
  subject: string; description: string; category: string; subcategory?: string; item?: string;
  priority: string; impact?: string; urgency?: string; mode?: string; level?: string; site?: string;
  requesterId: string; technicianId?: string | null;
  templateId?: string;
}

interface State {
  db: DB;
  currentUserId: string;
  activeTenantId: string;
  adminSec: string;
  adminLcIndex: number;
  selectedTicketId: string | null;
  cloudReady: boolean;
  hasAccess: boolean;
  layouts: Record<string, Record<string, { x: number; y: number }>>;
  startCloud: (uid: string) => Promise<void>;
  setUser: (uid: string) => void;
  setTenant: (id: string) => void;
  setAdminSec: (s: string) => void;
  setAdminLc: (i: number) => void;
  select: (id: string | null) => void;
  createTicket: (t: NewTicket) => void;
  assign: (ticketId: string, techUid: string | null) => void;
  transition: (ticketId: string, to: string) => void;
  setStatus: (ticketId: string, statusName: string) => void;
  setStatuses: (list: StatusDef[]) => void;
  setPicklist: (key: keyof Picklists, list: PickVal[]) => void;
  setPriorityMatrix: (matrix: PriorityMatrix) => void;
  setBusinessHours: (bh: BusinessHours) => void;
  setHolidays: (list: string[]) => void;
  setSites: (list: string[]) => void;
  setDepartments: (list: string[]) => void;
  setUserGroups: (list: string[]) => void;
  setRoles: (list: import('../data/seed.js').RoleDef[]) => void;
  setNotifRules: (rules: NotifRule[]) => void;
  markNotifRead: (id: string) => void;
  markAllNotifsRead: () => void;
  addComment: (ticketId: string, text: string, authorName: string, internal: boolean) => void;
  setResolution: (ticketId: string, text: string) => void;
  addTask: (ticketId: string, text: string, opts?: { assigneeUid?: string | null; dueAt?: number | null; type?: string }) => void;
  updateTask: (ticketId: string, taskId: string, patch: Partial<import('../model.js').TicketTask>) => void;
  toggleTask: (ticketId: string, taskId: string) => void;
  moveTask: (ticketId: string, taskId: string, dir: number) => void;
  addWorklog: (ticketId: string, mins: number, note: string, techName: string) => void;
  requestApproval: (ticketId: string, approverUids: string[], note: string) => void;
  decideApproval: (ticketId: string, approvalId: string, decision: 'approved' | 'rejected', comment: string) => void;
  uploadAttachment: (ticketId: string, file: File, uploaderName: string) => Promise<void>;
  removeAttachment: (ticketId: string, attId: string) => void;
  setClosureRules: (rules: ClosureRules) => void;
  setReplyTemplates: (list: ReplyTemplate[]) => void;
  addState: (label: string, category: SlaCategory, stage: Stage) => void;
  removeState: (key: string) => void;
  addTransition: (from: string, to: string) => void;
  removeTransition: (id: string) => void;
  updateState: (key: string, patch: Partial<LifecycleState>) => void;
  setNodePos: (lcId: string, key: string, x: number, y: number) => void;
  addCategory: (name: string) => void;
  setCategoryTree: (tree: CatNode[]) => void;
  addTemplate: (name: string, type: TicketType, lifecycleId: string | null) => void;
  updateTemplate: (id: string, patch: Partial<Template>) => void;
  removeTemplate: (id: string) => void;
  setTemplateFields: (id: string, fieldDefs: FieldDef[]) => void;
  addLifecycle: (name: string, type: TicketType) => void;
  renameLifecycle: (name: string) => void;
  setLifecyclePublished: (published: boolean) => void;
  removeLifecycle: () => void;
  addSla: (name: string, responseMins: number, resolveMins: number) => void;
  updateSla: (id: string, patch: Partial<Sla>) => void;
  removeSla: (id: string) => void;
  addGroup: (name: string) => void;
  removeGroup: (id: string) => void;
  addMember: (name: string, email: string, role: Role, external: boolean) => void;
  updateMember: (uid: string, patch: Partial<UiMember>) => void;
  removeMember: (uid: string) => void;
  importSnapshot: (snap: ImportSnapshot) => void;
}

export function buildUser(db: DB, uid: string): User {
  const memberships: User['memberships'] = {};
  for (const t of db.tenants) {
    const m = t.members.find((x) => x.uid === uid);
    if (m) memberships[t.id] = { role: m.role, status: m.status };
  }
  return { uid, platformAdmin: db.platformAdmins.includes(uid), memberships };
}
export function tenantsForUser(db: DB, u: User): TenantData[] {
  if (u.platformAdmin) return db.tenants;
  return db.tenants.filter((t) => u.memberships[t.id]?.status === 'active');
}
export function lifecycleOfTicket(t: TenantData, tk: StoredTicket): Lifecycle | null {
  const tpl = t.templates.find((x) => x.id === tk.templateId);
  if (!tpl || !tpl.lifecycleId) return null;
  return t.lifecycles.find((l) => l.id === tpl.lifecycleId) ?? null;
}

const seed = makeSeed(Date.now());
const mapTenant = (db: DB, id: string, fn: (t: TenantData) => TenantData): DB => ({ ...db, tenants: db.tenants.map((t) => (t.id === id ? fn(t) : t)) });
const genId = (t: TenantData): string => (t.id === 'leasys' ? 'SR-' : 'INC-') + String(t.counter).padStart(4, '0');
function editLc(t: TenantData, idx: number, fn: (lc: Lifecycle) => Lifecycle): TenantData {
  return { ...t, lifecycles: t.lifecycles.map((lc, i) => (i === idx ? fn(lc) : lc)) };
}

const CLOUD = firebaseEnabled;
const errlog = (e: unknown) => console.error('[cloud write]', e);
let unsubs: Array<() => void> = [];
let notifSeq = 0;
// FASE DE PRUEBAS: todo correo se redirige a este usuario (candado también en las
// reglas de Firestore: la colección `mail` solo admite `to` == este valor).
const MAIL_TEST_MODE = true;
const TEST_EMAIL = 'vnavarro@digloservicer.com';

export const useStore = create<State>()(
  persist(
    (set, get) => {
      const activeT = (s: State) => s.db.tenants.find((t) => t.id === s.activeTenantId);
      const curLc = (s: State): Lifecycle | undefined => { const t = activeT(s); return t?.lifecycles[Math.min(s.adminLcIndex, (t?.lifecycles.length ?? 1) - 1)]; };
      const syncCurLc = () => { if (!CLOUD) return; const s = get(); const t = activeT(s); const lc = curLc(s); if (t && lc?.id) void cloud.writeLifecycle(t.id, lc).catch(errlog); };

      // Motor de notificaciones: en cada evento evalúa las reglas del tenant,
      // resuelve destinatarios (solicitante / técnico / grupo) y crea un aviso en
      // pantalla para cada uno con canal `screen` (salvo el propio actor). El correo
      // queda pendiente de la extensión Trigger Email (ver README).
      const NOTIF_LABEL: Record<NotifEvent, string> = {
        created: 'Nueva solicitud', assigned: 'Te han asignado una solicitud', status: 'Cambio de estado',
        resolved: 'Solicitud resuelta', comment: 'Nuevo comentario', internal_note: 'Nueva nota interna', sla_breach: 'SLA incumplido',
        approval: 'Aprobación',
      };
      // Aviso dirigido a uids concretos (aprobaciones): no pasa por la matriz de
      // reglas por rol; escribe una notificación de pantalla a cada destinatario.
      const pushNotifTo = (t: TenantData, forUids: string[], ticket: StoredTicket, text: string) => {
        const actor = get().currentUserId;
        const notifs: AppNotification[] = forUids.filter((u) => u && u !== actor).map((forUid) => ({
          id: 'n-' + Date.now() + '-' + (notifSeq++), at: Date.now(), event: 'approval', ticketId: ticket.id,
          subject: ticket.subject, forUid, text,
        }));
        if (notifs.length === 0) return;
        set((st) => ({ db: mapTenant(st.db, t.id, (tt) => ({ ...tt, notifications: [...notifs, ...(tt.notifications ?? [])] })) }));
        if (CLOUD) for (const n of notifs) void cloud.writeNotification(t.id, n).catch(errlog);
      };
      const emitNotifs = (t: TenantData, event: NotifEvent, ticket: StoredTicket) => {
        const rule = (t.notifRules ?? []).find((r) => r.event === event);
        if (!rule) return;
        const actor = get().currentUserId;
        const targets = new Set<string>();
        if (rule.requester.screen && ticket.requesterId && ticket.requesterId !== actor) targets.add(ticket.requesterId);
        if (rule.technician.screen && ticket.technicianId && ticket.technicianId !== actor) targets.add(ticket.technicianId);
        if (rule.group.screen && ticket.groupId) for (const m of t.members) if ((m.groupIds ?? []).includes(ticket.groupId) && m.uid !== actor) targets.add(m.uid);
        if (targets.size === 0) return;
        const notifs: AppNotification[] = [...targets].map((forUid) => ({
          id: 'n-' + Date.now() + '-' + (notifSeq++), at: Date.now(), event, ticketId: ticket.id,
          subject: ticket.subject, forUid, text: `${NOTIF_LABEL[event]} · ${ticket.id}`,
        }));
        set((st) => ({ db: mapTenant(st.db, t.id, (tt) => ({ ...tt, notifications: [...notifs, ...(tt.notifications ?? [])] })) }));
        if (CLOUD) for (const n of notifs) void cloud.writeNotification(t.id, n).catch(errlog);

        // Correo: si alguna regla del evento tiene canal `mail`, encola UN email.
        // En fase de pruebas el destino es SIEMPRE TEST_EMAIL; los destinatarios
        // reales solo se listan en el cuerpo (nunca se les envía).
        if (CLOUD) {
          const mailWho: string[] = [];
          if (rule.requester.mail) mailWho.push('Solicitante');
          if (rule.technician.mail) mailWho.push('Técnico asignado');
          if (rule.group.mail) mailWho.push('Grupo de soporte');
          if (mailWho.length && MAIL_TEST_MODE) {
            const subject = `[Atenza · PRUEBA] ${NOTIF_LABEL[event]} · ${ticket.id}`;
            const html = `<p><b>${NOTIF_LABEL[event]}</b> — ${ticket.id}: ${ticket.subject}</p>`
              + `<p style="color:#888;font-size:13px">Aviso de prueba. Destinatarios reales (no notificados en pruebas): ${mailWho.join(', ')}.</p>`;
            void cloud.enqueueMail(TEST_EMAIL, subject, html).catch(errlog);
          }
        }
      };

      return {
        db: seed,
        currentUserId: 'u-admin',
        activeTenantId: 'diglo-it',
        adminSec: 'lifecycle',
        adminLcIndex: 0,
        selectedTicketId: null,
        cloudReady: false,
        hasAccess: false,
        layouts: {},

        startCloud: async (uid) => {
          unsubs.forEach((u) => u()); unsubs = [];
          const [pa, tids] = await Promise.all([
            cloud.isPlatformAdmin(uid).catch(() => false),
            cloud.getUserTenantIds(uid).catch(() => [] as string[]),
          ]);
          set({ db: { tenants: [], platformAdmins: pa ? [uid] : [] }, currentUserId: uid, cloudReady: true, hasAccess: pa || tids.length > 0, activeTenantId: tids[0] ?? '' });
          for (const tid of tids) {
            const role = await cloud.getMemberRole(tid, uid).catch(() => null);
            const filter = role === 'requester' ? uid : null;
            const un = await cloud.subscribeTenant(tid, filter, (tdata) => {
              set((s) => ({ db: { ...s.db, tenants: [...s.db.tenants.filter((t) => t.id !== tid), tdata] } }));
            }, uid);
            unsubs.push(un);
          }
        },

        setUser: (uid) => {
          const db = get().db; const u = buildUser(db, uid); const ts = tenantsForUser(db, u);
          set({ currentUserId: uid, selectedTicketId: null, activeTenantId: ts[0]?.id ?? get().activeTenantId });
        },
        setTenant: (id) => set({ activeTenantId: id, selectedTicketId: null }),
        setAdminSec: (s) => set({ adminSec: s }),
        setAdminLc: (i) => set({ adminLcIndex: i }),
        select: (id) => set({ selectedTicketId: id }),

        createTicket: (nt) => {
          const s = get(); const t = activeT(s); if (!t) return;
          const tpl = t.templates.find((x) => x.id === nt.templateId) ?? t.templates[0];
          const lc = tpl?.lifecycleId ? t.lifecycles.find((l) => l.id === tpl.lifecycleId) ?? null : null;
          const init = lc ? initialState(lc)?.key ?? 'open' : 'open';
          const now = Date.now(); const id = genId(t);
          const ticket: StoredTicket = {
            id, type: tpl?.type ?? 'incident', subject: nt.subject, description: nt.description,
            requesterId: nt.requesterId, technicianId: nt.technicianId ?? null, category: nt.category,
            subcategory: nt.subcategory, item: nt.item,
            priority: nt.priority, impact: nt.impact, urgency: nt.urgency, mode: nt.mode, level: nt.level, site: nt.site,
            templateId: tpl?.id ?? 'tpl-inc', status: init,
            slaId: SLA_BY_PRIORITY[nt.priority] ?? null, statusHistory: [{ state: init, from: now, to: null }],
          };
          set((st) => ({ db: mapTenant(st.db, t.id, (tt) => ({ ...tt, counter: tt.counter + 1, tickets: [ticket, ...tt.tickets] })) }));
          if (CLOUD) { void cloud.writeTicket(t.id, ticket).catch(errlog); void cloud.patchTenantDoc(t.id, { counter: t.counter + 1 }).catch(errlog); }
          emitNotifs(t, 'created', ticket);
        },

        assign: (ticketId, techUid) => {
          const s = get(); const t = activeT(s); if (!t) return;
          const tk = t.tickets.find((x) => x.id === ticketId); if (!tk) return;
          const lc = lifecycleOfTicket(t, tk);
          let status = tk.status, hist = tk.statusHistory ?? [];
          if (techUid && canTransition(lc, tk.status, 'assigned')) {
            const now = Date.now();
            hist = [...hist.map((h) => (h.to == null ? { ...h, to: now } : h)), { state: 'assigned', from: now, to: null }];
            status = 'assigned';
          }
          set((st) => ({ db: mapTenant(st.db, t.id, (tt) => ({ ...tt, tickets: tt.tickets.map((x) => (x.id === ticketId ? { ...x, technicianId: techUid, status, statusHistory: hist } : x)) })) }));
          if (CLOUD) void cloud.patchTicket(t.id, ticketId, { technicianId: techUid, status, statusHistory: hist }).catch(errlog);
          if (techUid) emitNotifs(t, 'assigned', { ...tk, technicianId: techUid, status });
        },

        transition: (ticketId, to) => {
          const s = get(); const t = activeT(s); if (!t) return;
          const tk = t.tickets.find((x) => x.id === ticketId); if (!tk) return;
          const lc = lifecycleOfTicket(t, tk);
          if (!canTransition(lc, tk.status, to)) return;
          if (isClosingStatus(t.statuses, to) && closureBlockers(t.closureRules, tk).length) return; // salvaguarda de reglas de cierre
          const now = Date.now();
          const hist = [...(tk.statusHistory ?? []).map((h) => (h.to == null ? { ...h, to: now } : h)), { state: to, from: now, to: null }];
          set((st) => ({ db: mapTenant(st.db, t.id, (tt) => ({ ...tt, tickets: tt.tickets.map((x) => (x.id === ticketId ? { ...x, status: to, statusHistory: hist } : x)) })) }));
          if (CLOUD) void cloud.patchTicket(t.id, ticketId, { status: to, statusHistory: hist }).catch(errlog);
          emitNotifs(t, 'status', { ...tk, status: to, statusHistory: hist });
        },
        // Cambio de estado directo al catálogo (sin exigir transición del ciclo).
        setStatus: (ticketId, to) => {
          const s = get(); const t = activeT(s); const tk = t?.tickets.find((x) => x.id === ticketId); if (!t || !tk || tk.status === to) return;
          if (isClosingStatus(t.statuses, to) && closureBlockers(t.closureRules, tk).length) return; // salvaguarda de reglas de cierre
          const now = Date.now();
          const hist = [...(tk.statusHistory ?? []).map((h) => (h.to == null ? { ...h, to: now } : h)), { state: to, from: now, to: null }];
          set((st) => ({ db: mapTenant(st.db, t.id, (tt) => ({ ...tt, tickets: tt.tickets.map((x) => (x.id === ticketId ? { ...x, status: to, statusHistory: hist } : x)) })) }));
          if (CLOUD) void cloud.patchTicket(t.id, ticketId, { status: to, statusHistory: hist }).catch(errlog);
          emitNotifs(t, to === 'Resuelta' ? 'resolved' : 'status', { ...tk, status: to, statusHistory: hist });
        },
        setStatuses: (list) => {
          set((s) => ({ db: mapTenant(s.db, s.activeTenantId, (t) => ({ ...t, statuses: list })) }));
          if (CLOUD) { const t = activeT(get()); if (t) void cloud.patchTenantDoc(t.id, { statuses: list }).catch(errlog); }
        },
        setPicklist: (key, list) => {
          set((s) => ({ db: mapTenant(s.db, s.activeTenantId, (t) => ({ ...t, picklists: { ...(t.picklists as Picklists), [key]: list } })) }));
          if (CLOUD) { const t = activeT(get()); if (t?.picklists) void cloud.patchTenantDoc(t.id, { picklists: t.picklists }).catch(errlog); }
        },
        setPriorityMatrix: (matrix) => {
          set((s) => ({ db: mapTenant(s.db, s.activeTenantId, (t) => ({ ...t, priorityMatrix: matrix })) }));
          if (CLOUD) { const t = activeT(get()); if (t) void cloud.patchTenantDoc(t.id, { priorityMatrix: matrix }).catch(errlog); }
        },
        setBusinessHours: (bh) => {
          set((s) => ({ db: mapTenant(s.db, s.activeTenantId, (t) => ({ ...t, businessHours: bh })) }));
          if (CLOUD) { const t = activeT(get()); if (t) void cloud.patchTenantDoc(t.id, { businessHours: bh }).catch(errlog); }
        },
        setHolidays: (list) => {
          set((s) => ({ db: mapTenant(s.db, s.activeTenantId, (t) => ({ ...t, holidays: list })) }));
          if (CLOUD) { const t = activeT(get()); if (t) void cloud.patchTenantDoc(t.id, { holidays: list }).catch(errlog); }
        },
        setSites: (list) => {
          set((s) => ({ db: mapTenant(s.db, s.activeTenantId, (t) => ({ ...t, sites: list })) }));
          if (CLOUD) { const t = activeT(get()); if (t) void cloud.patchTenantDoc(t.id, { sites: list }).catch(errlog); }
        },
        setDepartments: (list) => {
          set((s) => ({ db: mapTenant(s.db, s.activeTenantId, (t) => ({ ...t, departments: list })) }));
          if (CLOUD) { const t = activeT(get()); if (t) void cloud.patchTenantDoc(t.id, { departments: list }).catch(errlog); }
        },
        setUserGroups: (list) => {
          set((s) => ({ db: mapTenant(s.db, s.activeTenantId, (t) => ({ ...t, userGroups: list })) }));
          if (CLOUD) { const t = activeT(get()); if (t) void cloud.patchTenantDoc(t.id, { userGroups: list }).catch(errlog); }
        },
        setRoles: (list) => {
          set((s) => ({ db: mapTenant(s.db, s.activeTenantId, (t) => ({ ...t, roles: list })) }));
          if (CLOUD) { const t = activeT(get()); if (t) void cloud.patchTenantDoc(t.id, { roles: list }).catch(errlog); }
        },
        setNotifRules: (rules) => {
          set((s) => ({ db: mapTenant(s.db, s.activeTenantId, (t) => ({ ...t, notifRules: rules })) }));
          if (CLOUD) { const t = activeT(get()); if (t) void cloud.patchTenantDoc(t.id, { notifRules: rules }).catch(errlog); }
        },
        markNotifRead: (id) => {
          const t = activeT(get()); if (!t) return;
          set((s) => ({ db: mapTenant(s.db, s.activeTenantId, (tt) => ({ ...tt, notifications: (tt.notifications ?? []).map((n) => (n.id === id ? { ...n, read: true } : n)) })) }));
          if (CLOUD) void cloud.markNotifReadDoc(t.id, id).catch(errlog);
        },
        markAllNotifsRead: () => {
          const t = activeT(get()); if (!t) return;
          const me = get().currentUserId;
          const unread = (t.notifications ?? []).filter((n) => n.forUid === me && !n.read);
          set((s) => ({ db: mapTenant(s.db, s.activeTenantId, (tt) => ({ ...tt, notifications: (tt.notifications ?? []).map((n) => (n.forUid === me ? { ...n, read: true } : n)) })) }));
          if (CLOUD) for (const n of unread) void cloud.markNotifReadDoc(t.id, n.id).catch(errlog);
        },

        // Parche genérico de un campo del ticket (local + write-through en nube).
        addComment: (ticketId, text, authorName, internal) => {
          const body = text.trim(); if (!body) return;
          const s = get(); const t = activeT(s); const tk = t?.tickets.find((x) => x.id === ticketId); if (!t || !tk) return;
          const comments = [...(tk.comments ?? []), { author: s.currentUserId, authorName, at: Date.now(), text: body, internal }];
          set((st) => ({ db: mapTenant(st.db, t.id, (tt) => ({ ...tt, tickets: tt.tickets.map((x) => (x.id === ticketId ? { ...x, comments } : x)) })) }));
          if (CLOUD) void cloud.patchTicket(t.id, ticketId, { comments }).catch(errlog);
          emitNotifs(t, internal ? 'internal_note' : 'comment', tk);
        },
        setResolution: (ticketId, text) => {
          const s = get(); const t = activeT(s); if (!t) return;
          set((st) => ({ db: mapTenant(st.db, t.id, (tt) => ({ ...tt, tickets: tt.tickets.map((x) => (x.id === ticketId ? { ...x, resolution: text } : x)) })) }));
          if (CLOUD) void cloud.patchTicket(t.id, ticketId, { resolution: text }).catch(errlog);
        },
        addTask: (ticketId, text, opts) => {
          const body = text.trim(); if (!body) return;
          const s = get(); const t = activeT(s); const tk = t?.tickets.find((x) => x.id === ticketId); if (!t || !tk) return;
          // nuevas tareas al principio (orden descendente: última creada, la primera).
          const tasks = [{ id: 'tk-' + Date.now(), text: body, done: false, assigneeUid: opts?.assigneeUid ?? null, dueAt: opts?.dueAt ?? null, type: opts?.type }, ...(tk.tasks ?? [])];
          set((st) => ({ db: mapTenant(st.db, t.id, (tt) => ({ ...tt, tickets: tt.tickets.map((x) => (x.id === ticketId ? { ...x, tasks } : x)) })) }));
          if (CLOUD) void cloud.patchTicket(t.id, ticketId, { tasks }).catch(errlog);
        },
        updateTask: (ticketId, taskId, patch) => {
          const s = get(); const t = activeT(s); const tk = t?.tickets.find((x) => x.id === ticketId); if (!t || !tk) return;
          const tasks = (tk.tasks ?? []).map((k) => (k.id === taskId ? { ...k, ...patch } : k));
          set((st) => ({ db: mapTenant(st.db, t.id, (tt) => ({ ...tt, tickets: tt.tickets.map((x) => (x.id === ticketId ? { ...x, tasks } : x)) })) }));
          if (CLOUD) void cloud.patchTicket(t.id, ticketId, { tasks }).catch(errlog);
        },
        toggleTask: (ticketId, taskId) => {
          const s = get(); const t = activeT(s); const tk = t?.tickets.find((x) => x.id === ticketId); if (!t || !tk) return;
          const tasks = (tk.tasks ?? []).map((k) => (k.id === taskId ? { ...k, done: !k.done } : k));
          set((st) => ({ db: mapTenant(st.db, t.id, (tt) => ({ ...tt, tickets: tt.tickets.map((x) => (x.id === ticketId ? { ...x, tasks } : x)) })) }));
          if (CLOUD) void cloud.patchTicket(t.id, ticketId, { tasks }).catch(errlog);
        },
        moveTask: (ticketId, taskId, dir) => {
          const s = get(); const t = activeT(s); const tk = t?.tickets.find((x) => x.id === ticketId); if (!t || !tk) return;
          const tasks = [...(tk.tasks ?? [])]; const i = tasks.findIndex((k) => k.id === taskId); const j = i + dir;
          if (i < 0 || j < 0 || j >= tasks.length) return;
          [tasks[i], tasks[j]] = [tasks[j]!, tasks[i]!];
          set((st) => ({ db: mapTenant(st.db, t.id, (tt) => ({ ...tt, tickets: tt.tickets.map((x) => (x.id === ticketId ? { ...x, tasks } : x)) })) }));
          if (CLOUD) void cloud.patchTicket(t.id, ticketId, { tasks }).catch(errlog);
        },
        // Registra tiempo en el ticket y suma a la capacidad del técnico (OrganiZate).
        addWorklog: (ticketId, mins, note, techName) => {
          if (!mins || mins <= 0) return;
          const s = get(); const t = activeT(s); const tk = t?.tickets.find((x) => x.id === ticketId); if (!t || !tk) return;
          const techUid = s.currentUserId;
          const worklog = [{ id: 'w-' + Date.now(), techUid, techName, mins, at: Date.now(), note: note.trim() || undefined }, ...(tk.worklog ?? [])];
          const prev = t.capacity[techUid] ?? { used: 0, cap: 40 };
          const capacity = { ...t.capacity, [techUid]: { ...prev, used: Math.round((prev.used + mins / 60) * 10) / 10 } };
          set((st) => ({ db: mapTenant(st.db, t.id, (tt) => ({ ...tt, capacity, tickets: tt.tickets.map((x) => (x.id === ticketId ? { ...x, worklog } : x)) })) }));
          if (CLOUD) { void cloud.patchTicket(t.id, ticketId, { worklog }).catch(errlog); void cloud.patchTenantDoc(t.id, { capacity }).catch(errlog); }
        },
        // Solicita aprobación a uno o varios aprobadores y pone el ticket "Pendiente
        // Aprobación" (estado que PAUSA el SLA en el catálogo). Avisa a los aprobadores.
        requestApproval: (ticketId, approverUids, note) => {
          const s = get(); const t = activeT(s); const tk = t?.tickets.find((x) => x.id === ticketId); if (!t || !tk || approverUids.length === 0) return;
          const me = s.currentUserId; const meName = t.members.find((m) => m.uid === me)?.name ?? me; const now = Date.now();
          const news = approverUids.map((uid, i) => ({
            id: 'ap-' + now + '-' + i, approverUid: uid, approverName: t.members.find((m) => m.uid === uid)?.name ?? uid,
            status: 'pending' as const, requestedBy: me, requestedByName: meName, requestedAt: now, note: note.trim() || undefined,
          }));
          const approvals = [...news, ...(tk.approvals ?? [])];
          // pone "Pendiente Aprobación" si existe en el catálogo del tenant y no lo está ya
          const APPR = 'Pendiente Aprobación';
          const toAppr = (t.statuses ?? []).some((x) => x.name === APPR) && tk.status !== APPR;
          const hist = toAppr ? [...(tk.statusHistory ?? []).map((h) => (h.to == null ? { ...h, to: now } : h)), { state: APPR, from: now, to: null }] : tk.statusHistory;
          const patch = toAppr ? { approvals, status: APPR, statusHistory: hist } : { approvals };
          set((st) => ({ db: mapTenant(st.db, t.id, (tt) => ({ ...tt, tickets: tt.tickets.map((x) => (x.id === ticketId ? { ...x, ...patch } : x)) })) }));
          if (CLOUD) void cloud.patchTicket(t.id, ticketId, patch).catch(errlog);
          pushNotifTo(t, approverUids, tk, `Aprobación pendiente · ${tk.id}: ${tk.subject}`);
        },
        // Registra la decisión (aprobar/rechazar) de un aprobador y avisa al solicitante
        // de la aprobación (quien la pidió) y al técnico asignado.
        decideApproval: (ticketId, approvalId, decision, comment) => {
          const s = get(); const t = activeT(s); const tk = t?.tickets.find((x) => x.id === ticketId); if (!t || !tk) return;
          const now = Date.now();
          const approvals = (tk.approvals ?? []).map((a) => (a.id === approvalId ? { ...a, status: decision, decidedAt: now, comment: comment.trim() || undefined } : a));
          set((st) => ({ db: mapTenant(st.db, t.id, (tt) => ({ ...tt, tickets: tt.tickets.map((x) => (x.id === ticketId ? { ...x, approvals } : x)) })) }));
          if (CLOUD) void cloud.patchTicket(t.id, ticketId, { approvals }).catch(errlog);
          const decided = approvals.find((a) => a.id === approvalId);
          const who = t.members.find((m) => m.uid === s.currentUserId)?.name ?? 'Un aprobador';
          const verb = decision === 'approved' ? 'APROBÓ' : 'RECHAZÓ';
          pushNotifTo(t, [decided?.requestedBy ?? '', tk.technicianId ?? ''], tk, `${who} ${verb} · ${tk.id}: ${tk.subject}`);
        },
        // Sube un adjunto: en la nube va a Storage (path+url); en local, inline como
        // data URL para que la demo funcione sin backend.
        uploadAttachment: async (ticketId, file, uploaderName) => {
          const s = get(); const t = activeT(s); const tk = t?.tickets.find((x) => x.id === ticketId); if (!t || !tk) return;
          const id = 'at-' + Date.now(); const me = s.currentUserId; const base = { id, name: file.name, size: file.size, contentType: file.type || undefined, uploadedBy: me, uploadedByName: uploaderName, at: Date.now() };
          let att: Attachment;
          if (CLOUD) {
            const { path, url } = await cloud.uploadAttachment(t.id, ticketId, id, file);
            att = { ...base, path, url };
          } else {
            const dataUrl = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result as string); r.onerror = () => rej(r.error); r.readAsDataURL(file); });
            att = { ...base, dataUrl };
          }
          const cur = get().db.tenants.find((x) => x.id === t.id)?.tickets.find((x) => x.id === ticketId); // relee (subida async)
          const attachments = [att, ...(cur?.attachments ?? [])];
          set((st) => ({ db: mapTenant(st.db, t.id, (tt) => ({ ...tt, tickets: tt.tickets.map((x) => (x.id === ticketId ? { ...x, attachments } : x)) })) }));
          if (CLOUD) void cloud.patchTicket(t.id, ticketId, { attachments }).catch(errlog);
        },
        removeAttachment: (ticketId, attId) => {
          const s = get(); const t = activeT(s); const tk = t?.tickets.find((x) => x.id === ticketId); if (!t || !tk) return;
          const att = (tk.attachments ?? []).find((a) => a.id === attId);
          const attachments = (tk.attachments ?? []).filter((a) => a.id !== attId);
          set((st) => ({ db: mapTenant(st.db, t.id, (tt) => ({ ...tt, tickets: tt.tickets.map((x) => (x.id === ticketId ? { ...x, attachments } : x)) })) }));
          if (CLOUD) { void cloud.patchTicket(t.id, ticketId, { attachments }).catch(errlog); if (att?.path) void cloud.deleteAttachment(att.path).catch(errlog); }
        },
        setClosureRules: (rules) => {
          set((s) => ({ db: mapTenant(s.db, s.activeTenantId, (t) => ({ ...t, closureRules: rules })) }));
          if (CLOUD) { const t = activeT(get()); if (t) void cloud.patchTenantDoc(t.id, { closureRules: rules }).catch(errlog); }
        },
        setReplyTemplates: (list) => {
          set((s) => ({ db: mapTenant(s.db, s.activeTenantId, (t) => ({ ...t, replyTemplates: list })) }));
          if (CLOUD) { const t = activeT(get()); if (t) void cloud.patchTenantDoc(t.id, { replyTemplates: list }).catch(errlog); }
        },

        addState: (label, category, stage) => {
          set((s) => ({ db: mapTenant(s.db, s.activeTenantId, (t) => editLc(t, s.adminLcIndex, (lc) => {
            let base = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 's' + lc.states.length;
            let key = base, i = 1; while (lc.states.some((x) => x.key === key)) key = base + '_' + ++i;
            const ns: LifecycleState = { key, label, stage, category };
            return { ...lc, states: [...lc.states, ns] };
          })) })); syncCurLc();
        },
        removeState: (key) => {
          set((s) => ({ db: mapTenant(s.db, s.activeTenantId, (t) => editLc(t, s.adminLcIndex, (lc) => ({
            ...lc, states: lc.states.filter((x) => x.key !== key), transitions: lc.transitions.filter((x) => x.from !== key && x.to !== key),
          }))) })); syncCurLc();
        },
        addTransition: (from, to) => {
          set((s) => ({ db: mapTenant(s.db, s.activeTenantId, (t) => editLc(t, s.adminLcIndex, (lc) => {
            if (from === to || lc.transitions.some((x) => x.from === from && x.to === to)) return lc;
            const lf = lc.states.find((x) => x.key === from)?.label ?? from;
            const lt = lc.states.find((x) => x.key === to)?.label ?? to;
            return { ...lc, transitions: [...lc.transitions, { id: 'tr_' + from + '_' + to, name: `${lf} → ${lt}`, from, to }] };
          })) })); syncCurLc();
        },
        removeTransition: (id) => {
          set((s) => ({ db: mapTenant(s.db, s.activeTenantId, (t) => editLc(t, s.adminLcIndex, (lc) => ({ ...lc, transitions: lc.transitions.filter((x) => x.id !== id) }))) })); syncCurLc();
        },
        updateState: (key, patch) => {
          set((s) => ({ db: mapTenant(s.db, s.activeTenantId, (t) => editLc(t, s.adminLcIndex, (lc) => ({ ...lc, states: lc.states.map((x) => (x.key === key ? { ...x, ...patch } : x)) }))) })); syncCurLc();
        },
        setNodePos: (lcId, key, x, y) => set((s) => ({ layouts: { ...s.layouts, [lcId]: { ...(s.layouts[lcId] ?? {}), [key]: { x, y } } } })),

        addCategory: (name) => {
          const n = name.trim(); if (!n) return;
          set((s) => ({ db: mapTenant(s.db, s.activeTenantId, (t) => (t.categories.includes(n) ? t : { ...t, categories: [...t.categories, n] })) }));
          if (CLOUD) { const t = activeT(get()); if (t) void cloud.patchTenantDoc(t.id, { categories: t.categories }).catch(errlog); }
        },
        setCategoryTree: (tree) => {
          const categories = tree.map((c) => c.name);
          set((s) => ({ db: mapTenant(s.db, s.activeTenantId, (t) => ({ ...t, categoryTree: tree, categories })) }));
          if (CLOUD) { const t = activeT(get()); if (t) void cloud.patchTenantDoc(t.id, { categoryTree: tree, categories }).catch(errlog); }
        },
        addTemplate: (name, type, lifecycleId) => {
          const defs: FieldDef[] = [
            { id: 'f-subject', label: 'Asunto', type: 'text', mandatory: true, requesterVisible: true },
            { id: 'f-desc', label: 'Descripción', type: 'textarea', requesterVisible: true },
            { id: 'f-cat', label: 'Categoría', type: 'select', requesterVisible: true },
            { id: 'f-pri', label: 'Prioridad', type: 'select', requesterVisible: true },
          ];
          const tpl: Template = { id: 'tpl-' + Date.now(), name, type, lifecycleId, slaId: null, fields: defs.map((d) => d.label), fieldDefs: defs, group: type === 'incident' ? 'Plantillas generales de incidentes' : 'Solicitudes de servicio', showToRequester: true };
          set((s) => ({ db: mapTenant(s.db, s.activeTenantId, (t) => ({ ...t, templates: [...t.templates, tpl] })) }));
          if (CLOUD) { const t = activeT(get()); if (t) void cloud.writeTemplate(t.id, tpl).catch(errlog); }
        },
        updateTemplate: (id, patch) => {
          set((s) => ({ db: mapTenant(s.db, s.activeTenantId, (t) => ({ ...t, templates: t.templates.map((x) => (x.id === id ? { ...x, ...patch } : x)) })) }));
          if (CLOUD) { const t = activeT(get()); const tp = t?.templates.find((x) => x.id === id); if (t && tp) void cloud.writeTemplate(t.id, tp).catch(errlog); }
        },
        removeTemplate: (id) => {
          set((s) => ({ db: mapTenant(s.db, s.activeTenantId, (t) => ({ ...t, templates: t.templates.filter((x) => x.id !== id) })) }));
          if (CLOUD) { const t = activeT(get()); if (t) void cloud.removeTemplateDoc(t.id, id).catch(errlog); }
        },
        setTemplateFields: (id, fieldDefs) => {
          set((s) => ({ db: mapTenant(s.db, s.activeTenantId, (t) => ({ ...t, templates: t.templates.map((x) => (x.id === id ? { ...x, fieldDefs, fields: fieldDefs.map((d) => d.label) } : x)) })) }));
          if (CLOUD) { const t = activeT(get()); const tp = t?.templates.find((x) => x.id === id); if (t && tp) void cloud.writeTemplate(t.id, tp).catch(errlog); }
        },
        addLifecycle: (name, type) => {
          const id = 'lc-' + Date.now();
          const lc: Lifecycle = {
            id, name, version: '1.0', published: false, type,
            states: [
              { key: 'open', label: 'Abierta', stage: 'open', category: 'in_progress', isInitial: true },
              { key: 'working', label: 'En curso', stage: 'open', category: 'in_progress' },
              { key: 'resolved', label: 'Resuelta', stage: 'resolved', category: 'completed' },
              { key: 'closed', label: 'Cerrada', stage: 'closed', category: 'completed', isTerminal: true },
            ],
            transitions: [
              { id: 't0', name: 'Abierta → En curso', from: 'open', to: 'working' },
              { id: 't1', name: 'En curso → Resuelta', from: 'working', to: 'resolved' },
              { id: 't2', name: 'Resuelta → Cerrada', from: 'resolved', to: 'closed' },
            ],
          };
          set((s) => { const t = s.db.tenants.find((x) => x.id === s.activeTenantId)!; return { db: mapTenant(s.db, s.activeTenantId, (tt) => ({ ...tt, lifecycles: [...tt.lifecycles, lc] })), adminLcIndex: t.lifecycles.length }; });
          if (CLOUD) { const t = activeT(get()); if (t) void cloud.writeLifecycle(t.id, lc).catch(errlog); }
        },
        renameLifecycle: (name) => { set((s) => ({ db: mapTenant(s.db, s.activeTenantId, (t) => editLc(t, s.adminLcIndex, (lc) => ({ ...lc, name }))) })); syncCurLc(); },
        setLifecyclePublished: (published) => { set((s) => ({ db: mapTenant(s.db, s.activeTenantId, (t) => editLc(t, s.adminLcIndex, (lc) => ({ ...lc, published }))) })); syncCurLc(); },
        removeLifecycle: () => {
          const s0 = get(); const t0 = activeT(s0); const removed = t0 && t0.lifecycles.length > 1 ? curLc(s0) : undefined;
          set((s) => ({ db: mapTenant(s.db, s.activeTenantId, (t) => (t.lifecycles.length <= 1 ? t : { ...t, lifecycles: t.lifecycles.filter((_, i) => i !== s.adminLcIndex) })), adminLcIndex: 0 }));
          if (CLOUD && t0 && removed?.id) void cloud.removeLifecycleDoc(t0.id, removed.id).catch(errlog);
        },
        addSla: (name, responseMins, resolveMins) => {
          const n = name.trim(); if (!n) return;
          const sla: Sla = { id: 'sla-' + Date.now(), name: n, responseMins, resolveMins };
          set((s) => ({ db: mapTenant(s.db, s.activeTenantId, (t) => ({ ...t, slas: [...t.slas, sla] })) }));
          if (CLOUD) { const t = activeT(get()); if (t) void cloud.writeSla(t.id, sla).catch(errlog); }
        },
        updateSla: (id, patch) => {
          set((s) => ({ db: mapTenant(s.db, s.activeTenantId, (t) => ({ ...t, slas: t.slas.map((x) => (x.id === id ? { ...x, ...patch } : x)) })) }));
          if (CLOUD) { const t = activeT(get()); const s = t?.slas.find((x) => x.id === id); if (t && s) void cloud.writeSla(t.id, s).catch(errlog); }
        },
        removeSla: (id) => {
          set((s) => ({ db: mapTenant(s.db, s.activeTenantId, (t) => ({ ...t, slas: t.slas.filter((x) => x.id !== id) })) }));
          if (CLOUD) { const t = activeT(get()); if (t) void cloud.removeSlaDoc(t.id, id).catch(errlog); }
        },
        addGroup: (name) => {
          const n = name.trim(); if (!n) return;
          const g: Group = { id: 'grp-' + Date.now(), name: n };
          set((s) => ({ db: mapTenant(s.db, s.activeTenantId, (t) => ({ ...t, groups: [...t.groups, g] })) }));
          if (CLOUD) { const t = activeT(get()); if (t) void cloud.writeGroup(t.id, g).catch(errlog); }
        },
        removeGroup: (id) => {
          set((s) => ({ db: mapTenant(s.db, s.activeTenantId, (t) => ({ ...t, groups: t.groups.filter((x) => x.id !== id) })) }));
          if (CLOUD) { const t = activeT(get()); if (t) void cloud.removeGroupDoc(t.id, id).catch(errlog); }
        },
        addMember: (name, email, role, external) => {
          const em = email.trim().toLowerCase(); if (!em) return;
          const palette = ['#4f46e5', '#0f766e', '#b45309', '#0369a1', '#be185d', '#7c3aed'];
          const t0 = activeT(get());
          const member: UiMember = {
            uid: 'm-' + Date.now(), name: name.trim() || em, email: em, role, status: 'invited', external,
            color: palette[(t0?.members.length ?? 0) % palette.length]!,
          };
          set((s) => ({ db: mapTenant(s.db, s.activeTenantId, (t) => ({ ...t, members: [...t.members, member] })) }));
          if (CLOUD) { const t = activeT(get()); if (t) void cloud.writeMember(t.id, member).catch(errlog); }
        },
        updateMember: (uid, patch) => {
          set((s) => ({ db: mapTenant(s.db, s.activeTenantId, (t) => ({ ...t, members: t.members.map((x) => (x.uid === uid ? { ...x, ...patch } : x)) })) }));
          if (CLOUD) { const t = activeT(get()); const m = t?.members.find((x) => x.uid === uid); if (t && m) void cloud.writeMember(t.id, m).catch(errlog); }
        },
        removeMember: (uid) => {
          set((s) => ({ db: mapTenant(s.db, s.activeTenantId, (t) => ({ ...t, members: t.members.filter((x) => x.uid !== uid) })) }));
          if (CLOUD) { const t = activeT(get()); if (t) void cloud.removeMemberDoc(t.id, uid).catch(errlog); }
        },
        importSnapshot: (snap) => {
          set((s) => ({ db: mapTenant(s.db, s.activeTenantId, (t) => ({
            ...t,
            categories: snap.categories?.length ? snap.categories : t.categories,
            templates: snap.templates?.length ? snap.templates : t.templates,
            slas: snap.slas?.length ? snap.slas : t.slas,
            groups: snap.groups?.length ? snap.groups : t.groups,
            members: snap.members?.length ? snap.members : t.members,
          })) }));
          // Write-through en la nube: solo CONFIG (categorías/plantillas/SLAs/grupos).
          // Los miembros NO se vuelcan en bloque (evita pisar accesos y volcar cientos
          // de cuentas sin auth); se gestionan en «Miembros»/onboarding.
          if (CLOUD) { const t = activeT(get()); if (t) void cloud.importConfigToFirestore(t.id, { categories: snap.categories, templates: snap.templates, slas: snap.slas, groups: snap.groups }).catch(errlog); }
        },
      };
    },
    { name: 'atenza-pilot-v12', partialize: (s) => (firebaseEnabled ? ({ layouts: s.layouts } as unknown as State) : s) },
  ),
);
