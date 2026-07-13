import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Lifecycle, LifecycleState, SlaCategory, Stage, Template, TicketType, Sla, FieldDef } from '../model.js';
import type { User } from '../access.js';
import { canTransition, initialState } from '../lifecycle.js';
import { makeSeed, SLA_BY_PRIORITY, type DB, type TenantData, type StoredTicket, type UiMember, type Group } from '../data/seed.js';
import { firebaseEnabled } from '../firebase.js';
import * as cloud from '../data/firestore.js';

export interface ImportSnapshot { categories: string[]; templates: Template[]; slas: Sla[]; groups: Group[]; members: UiMember[] }
export type Role = 'tenant_admin' | 'technician' | 'requester';

interface NewTicket {
  subject: string; description: string; category: string;
  priority: 'high' | 'medium' | 'low'; requesterId: string; technicianId?: string | null;
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
  addComment: (ticketId: string, text: string, authorName: string, internal: boolean) => void;
  setResolution: (ticketId: string, text: string) => void;
  addTask: (ticketId: string, text: string) => void;
  toggleTask: (ticketId: string, taskId: string) => void;
  moveTask: (ticketId: string, taskId: string, dir: number) => void;
  addState: (label: string, category: SlaCategory, stage: Stage) => void;
  removeState: (key: string) => void;
  addTransition: (from: string, to: string) => void;
  removeTransition: (id: string) => void;
  updateState: (key: string, patch: Partial<LifecycleState>) => void;
  setNodePos: (lcId: string, key: string, x: number, y: number) => void;
  addCategory: (name: string) => void;
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

export const useStore = create<State>()(
  persist(
    (set, get) => {
      const activeT = (s: State) => s.db.tenants.find((t) => t.id === s.activeTenantId);
      const curLc = (s: State): Lifecycle | undefined => { const t = activeT(s); return t?.lifecycles[Math.min(s.adminLcIndex, (t?.lifecycles.length ?? 1) - 1)]; };
      const syncCurLc = () => { if (!CLOUD) return; const s = get(); const t = activeT(s); const lc = curLc(s); if (t && lc?.id) void cloud.writeLifecycle(t.id, lc).catch(errlog); };

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
            });
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
            priority: nt.priority, templateId: tpl?.id ?? 'tpl-inc', status: init,
            slaId: SLA_BY_PRIORITY[nt.priority] ?? null, statusHistory: [{ state: init, from: now, to: null }],
          };
          set((st) => ({ db: mapTenant(st.db, t.id, (tt) => ({ ...tt, counter: tt.counter + 1, tickets: [ticket, ...tt.tickets] })) }));
          if (CLOUD) { void cloud.writeTicket(t.id, ticket).catch(errlog); void cloud.patchTenantDoc(t.id, { counter: t.counter + 1 }).catch(errlog); }
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
        },

        transition: (ticketId, to) => {
          const s = get(); const t = activeT(s); if (!t) return;
          const tk = t.tickets.find((x) => x.id === ticketId); if (!tk) return;
          const lc = lifecycleOfTicket(t, tk);
          if (!canTransition(lc, tk.status, to)) return;
          const now = Date.now();
          const hist = [...(tk.statusHistory ?? []).map((h) => (h.to == null ? { ...h, to: now } : h)), { state: to, from: now, to: null }];
          set((st) => ({ db: mapTenant(st.db, t.id, (tt) => ({ ...tt, tickets: tt.tickets.map((x) => (x.id === ticketId ? { ...x, status: to, statusHistory: hist } : x)) })) }));
          if (CLOUD) void cloud.patchTicket(t.id, ticketId, { status: to, statusHistory: hist }).catch(errlog);
        },

        // Parche genérico de un campo del ticket (local + write-through en nube).
        addComment: (ticketId, text, authorName, internal) => {
          const body = text.trim(); if (!body) return;
          const s = get(); const t = activeT(s); const tk = t?.tickets.find((x) => x.id === ticketId); if (!t || !tk) return;
          const comments = [...(tk.comments ?? []), { author: s.currentUserId, authorName, at: Date.now(), text: body, internal }];
          set((st) => ({ db: mapTenant(st.db, t.id, (tt) => ({ ...tt, tickets: tt.tickets.map((x) => (x.id === ticketId ? { ...x, comments } : x)) })) }));
          if (CLOUD) void cloud.patchTicket(t.id, ticketId, { comments }).catch(errlog);
        },
        setResolution: (ticketId, text) => {
          const s = get(); const t = activeT(s); if (!t) return;
          set((st) => ({ db: mapTenant(st.db, t.id, (tt) => ({ ...tt, tickets: tt.tickets.map((x) => (x.id === ticketId ? { ...x, resolution: text } : x)) })) }));
          if (CLOUD) void cloud.patchTicket(t.id, ticketId, { resolution: text }).catch(errlog);
        },
        addTask: (ticketId, text) => {
          const body = text.trim(); if (!body) return;
          const s = get(); const t = activeT(s); const tk = t?.tickets.find((x) => x.id === ticketId); if (!t || !tk) return;
          // nuevas tareas al principio (orden descendente: última creada, la primera).
          const tasks = [{ id: 'tk-' + Date.now(), text: body, done: false }, ...(tk.tasks ?? [])];
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
    { name: 'atenza-pilot-v2', partialize: (s) => (firebaseEnabled ? ({ layouts: s.layouts } as unknown as State) : s) },
  ),
);
