import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Lifecycle, LifecycleState, SlaCategory, Stage, Template, TicketType, Sla } from '../model.js';
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
  addState: (label: string, category: SlaCategory, stage: Stage) => void;
  removeState: (key: string) => void;
  addTransition: (from: string, to: string) => void;
  removeTransition: (id: string) => void;
  updateState: (key: string, patch: Partial<LifecycleState>) => void;
  setNodePos: (lcId: string, key: string, x: number, y: number) => void;
  addCategory: (name: string) => void;
  addTemplate: (name: string, type: TicketType, lifecycleId: string | null) => void;
  addLifecycle: (name: string, type: TicketType) => void;
  renameLifecycle: (name: string) => void;
  setLifecyclePublished: (published: boolean) => void;
  removeLifecycle: () => void;
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
          const tpl: Template = { id: 'tpl-' + Date.now(), name, type, lifecycleId, slaId: null, fields: ['subject', 'description', 'category', 'priority'] };
          set((s) => ({ db: mapTenant(s.db, s.activeTenantId, (t) => ({ ...t, templates: [...t.templates, tpl] })) }));
          if (CLOUD) { const t = activeT(get()); if (t) void cloud.writeTemplate(t.id, tpl).catch(errlog); }
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
        importSnapshot: (snap) => {
          // Import en la nube (miembros/SLAs/grupos) llegará con el módulo de admin de instancia; por ahora, local.
          set((s) => ({ db: mapTenant(s.db, s.activeTenantId, (t) => ({
            ...t,
            categories: snap.categories?.length ? snap.categories : t.categories,
            templates: snap.templates?.length ? snap.templates : t.templates,
            slas: snap.slas?.length ? snap.slas : t.slas,
            groups: snap.groups?.length ? snap.groups : t.groups,
            members: snap.members?.length ? snap.members : t.members,
          })) }));
        },
      };
    },
    { name: 'atenza-pilot-v2', partialize: (s) => (firebaseEnabled ? ({ layouts: s.layouts } as unknown as State) : s) },
  ),
);
