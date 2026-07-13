import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import {
  ReactFlow, Background, BackgroundVariant, Controls, MiniMap, Handle, Position, MarkerType, Panel,
  useNodesState, useEdgesState, type Node, type Edge, type Connection, type NodeProps, type ReactFlowInstance,
} from '@xyflow/react';
import { useStore, buildUser, tenantsForUser, lifecycleOfTicket, type Role } from './store.js';
import { firebaseEnabled } from '../firebase.js';
import { useAuth, doSignOut } from '../auth/auth.js';
import { Login } from './Login.js';
import { outgoing, stateOf } from '../lifecycle.js';
import { slaStatus } from '../sla.js';
import type { SlaCategory, Stage } from '../model.js';
import type { TenantData, StoredTicket, UiMember, Capacity } from '../data/seed.js';

const CAT: Record<SlaCategory, [string, string, string]> = {
  in_progress: ['En curso', 'var(--ok)', 'var(--ok-bg)'],
  stop_timer: ['Detener temporizador', 'var(--warn)', 'var(--warn-bg)'],
  completed: ['Completado', 'var(--st-closed)', 'var(--sink)'],
};
const PRI: Record<string, string> = { high: 'Alta', medium: 'Media', low: 'Baja' };
const initials = (n: string) => n.replace(/\(.*?\)/g, '').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
const fmtMins = (m: number) => (m >= 1440 ? Math.round(m / 1440) + 'd' : m >= 60 ? Math.round(m / 60) + 'h' : m + 'm');
function capState(c: Capacity): [string, string] {
  if (c.off) return ['off', 'De vacaciones'];
  const p = c.cap ? Math.round((c.used / c.cap) * 100) : 0;
  return p > 100 ? ['over', 'Sobrecargado'] : p >= 85 ? ['tight', 'Al límite'] : ['free', 'Con hueco'];
}
function capColor(c: Capacity) { const [s] = capState(c); return s === 'over' ? 'var(--crit)' : s === 'tight' ? 'var(--warn)' : s === 'off' ? 'var(--ink-faint)' : 'var(--ok)'; }
const Avatar = ({ m }: { m: UiMember }) => <span className="av" style={{ background: m.color }}>{initials(m.name)}</span>;

export function App() {
  const db = useStore((s) => s.db);
  const currentUserId = useStore((s) => s.currentUserId);
  const activeTenantId = useStore((s) => s.activeTenantId);
  const setUser = useStore((s) => s.setUser);
  const setTenant = useStore((s) => s.setTenant);
  const authUser = useAuth((s) => s.user);
  const authReady = useAuth((s) => s.ready);
  useEffect(() => { void useAuth.getState().init(); }, []);
  const [theme, setTheme] = useState<'light' | 'dark' | null>(null);
  const [mode, setMode] = useState<'tickets' | 'admin'>('tickets');
  const [filter, setFilter] = useState<'all' | 'unassigned' | 'mine'>('all');
  const [showNew, setShowNew] = useState(false);

  // Identidad: en la nube = usuario autenticado (mapeado a miembro por email);
  // en local = selector de personas (demo).
  const memberByEmail = firebaseEnabled && authUser?.email
    ? db.tenants.flatMap((t) => t.members).find((m) => m.email.toLowerCase() === authUser.email!.toLowerCase())
    : undefined;
  const effectiveUserId = firebaseEnabled ? (memberByEmail?.uid ?? authUser?.uid ?? '') : currentUserId;
  const user = buildUser(db, effectiveUserId);
  const myTenants = tenantsForUser(db, user);
  const tenant = db.tenants.find((t) => t.id === activeTenantId) ?? myTenants[0] ?? db.tenants[0]!;
  const role: Role = user.platformAdmin ? 'tenant_admin' : (user.memberships[tenant.id]?.role ?? 'requester');
  const people = db.tenants.flatMap((t) => t.members).filter((m, i, a) => a.findIndex((x) => x.uid === m.uid) === i);

  const toggleTheme = () => {
    const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next; setTheme(next);
  };

  // Gates de sesión (solo en la nube).
  if (firebaseEnabled && !authReady) return <div className="login-wrap"><div className="login-card" style={{ textAlign: 'center', color: 'var(--ink-faint)' }}>Cargando…</div></div>;
  if (firebaseEnabled && !authUser) return <Login />;
  if (firebaseEnabled && authUser && myTenants.length === 0) return (
    <div className="login-wrap"><div className="login-card" style={{ textAlign: 'center' }}>
      <div className="brand" style={{ justifyContent: 'center', fontSize: 20 }}><span className="glyph">A</span> Atenza</div>
      <p style={{ margin: '16px 0', color: 'var(--ink-soft)', fontSize: 14 }}>Sin acceso todavía.<br /><b>{authUser.email}</b> no pertenece a ninguna instancia. Pide a un administrador que te invite.</p>
      <button className="ghost" onClick={() => doSignOut()}>Salir</button>
    </div></div>
  );

  return (
    <div>
      <div className="top">
        <div className="brand"><span className="glyph">A</span> Atenza <small>{firebaseEnabled ? 'nube' : 'piloto · local'}</small></div>
        <div className="spring" />
        {firebaseEnabled ? <>
          <span className="lbl">Sesión</span>
          <span style={{ fontSize: 12.5, color: 'var(--ink-soft)' }}>{memberByEmail?.name ?? authUser?.email}</span>
          <button className="ghost" onClick={() => doSignOut()}>Salir</button>
        </> : <>
          <span className="lbl">Identidad</span>
          <select value={currentUserId} onChange={(e) => { setUser(e.target.value); setMode('tickets'); }}>
            {people.map((p) => <option key={p.uid} value={p.uid}>{p.name}</option>)}
          </select>
        </>}
        {myTenants.length > 1 && <>
          <span className="lbl">Instancia</span>
          <select value={tenant.id} onChange={(e) => setTenant(e.target.value)}>
            {myTenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </>}
        <span className="rolebadge">{role === 'tenant_admin' ? 'Admin' : role === 'technician' ? 'Técnico' : 'Solicitante'}</span>
        <button className="iconbtn" onClick={toggleTheme} title="Tema">◐</button>
      </div>

      <div className="shell">
        <aside className="side">
          {mode === 'tickets' ? (
            <TicketQueues tenant={tenant} role={role} user={user} filter={filter} setFilter={setFilter} onNew={() => { setShowNew(true); }} />
          ) : (
            <AdminNav />
          )}
          {role === 'tenant_admin' && (
            <button className="qbtn" style={{ marginTop: 10 }} onClick={() => setMode(mode === 'admin' ? 'tickets' : 'admin')}>
              {mode === 'admin' ? '← Volver a la bandeja' : '⚙ Administración'}
            </button>
          )}
          <div className="foot">
            {myTenants.length > 1 ? 'Perteneces a varias instancias.' : `Solo tienes acceso a ${tenant.name}.`} Todo aquí es propio de <b>{tenant.name}</b>.
          </div>
        </aside>

        <main className="main">
          {mode === 'admin' && role === 'tenant_admin'
            ? <AdminArea tenant={tenant} />
            : <Workspace tenant={tenant} role={role} user={user} filter={filter} showNew={showNew} setShowNew={setShowNew} />}
        </main>
      </div>
    </div>
  );
}

function TicketQueues({ tenant, role, user, filter, setFilter, onNew }:
  { tenant: TenantData; role: Role; user: ReturnType<typeof buildUser>; filter: string; setFilter: (f: any) => void; onNew: () => void }) {
  const all = tenant.tickets;
  if (role === 'requester') {
    const mine = all.filter((t) => t.requesterId === user.uid);
    return <>
      <div className="cap">Solicitante</div>
      <button className="qbtn on">Mis solicitudes <span className="n">{mine.length}</span></button>
      <button className="newbtn" onClick={onNew}>＋ Nueva solicitud</button>
    </>;
  }
  const q: [string, string, number][] = [
    ['all', 'Todas', all.length],
    ['unassigned', 'Sin asignar', all.filter((t) => !t.technicianId).length],
    ['mine', 'Mías', all.filter((t) => t.technicianId === user.uid).length],
  ];
  return <>
    <div className="cap">Colas</div>
    {q.map(([k, l, n]) => <button key={k} className={'qbtn' + (filter === k ? ' on' : '')} onClick={() => setFilter(k)}>{l} <span className="n">{n}</span></button>)}
    <button className="newbtn" onClick={onNew}>＋ Nuevo ticket</button>
  </>;
}

function Workspace({ tenant, role, user, filter, showNew, setShowNew }:
  { tenant: TenantData; role: Role; user: ReturnType<typeof buildUser>; filter: string; showNew: boolean; setShowNew: (b: boolean) => void }) {
  const selectedId = useStore((s) => s.selectedTicketId);
  const select = useStore((s) => s.select);
  let list = tenant.tickets;
  if (role === 'requester') list = list.filter((t) => t.requesterId === user.uid);
  else if (filter === 'unassigned') list = list.filter((t) => !t.technicianId);
  else if (filter === 'mine') list = list.filter((t) => t.technicianId === user.uid);
  const selected = tenant.tickets.find((t) => t.id === selectedId) ?? null;

  return <>
    <div className="hd"><h1>{role === 'requester' ? 'Mis solicitudes' : 'Bandeja de tickets'}</h1><span className="sub">{tenant.name} · {list.length} tickets</span></div>
    <div className="work">
      <div className="listwrap">
        {list.length === 0 && <div className="empty">No hay tickets en esta vista.</div>}
        {list.map((t) => <TicketRow key={t.id} tenant={tenant} t={t} sel={t.id === selectedId} onClick={() => { select(t.id); setShowNew(false); }} />)}
      </div>
      <div>
        {showNew ? <NewTicket tenant={tenant} role={role} user={user} onClose={() => setShowNew(false)} />
          : selected ? <TicketDetail tenant={tenant} t={selected} canAct={role !== 'requester'} />
            : <div className="card"><div className="empty">Selecciona un ticket para ver el detalle.</div></div>}
      </div>
    </div>
  </>;
}

function TicketRow({ tenant, t, sel, onClick }: { tenant: TenantData; t: StoredTicket; sel: boolean; onClick: () => void }) {
  const lc = lifecycleOfTicket(tenant, t);
  const st = lc ? stateOf(lc, t.status) : undefined;
  const cat = st ? CAT[st.category] : null;
  const tech = tenant.members.find((m) => m.uid === t.technicianId);
  return (
    <button className={'row' + (sel ? ' sel' : '')} onClick={onClick}>
      <span className="id">{t.id}</span>
      <span>
        <span className="subj">{t.subject}</span>
        <span className="meta">
          <span className={'chip p-' + t.priority}>{PRI[t.priority ?? 'low']}</span>
          {cat && <span className="cat" style={{ color: cat[1], background: cat[2] }}>{st?.label}</span>}
        </span>
      </span>
      {tech ? <Avatar m={tech} /> : <span className="av" style={{ background: 'var(--ink-faint)' }}>?</span>}
    </button>
  );
}

function TicketDetail({ tenant, t, canAct }: { tenant: TenantData; t: StoredTicket; canAct: boolean }) {
  const transition = useStore((s) => s.transition);
  const assign = useStore((s) => s.assign);
  const lc = lifecycleOfTicket(tenant, t);
  const st = lc ? stateOf(lc, t.status) : undefined;
  const cat = st ? CAT[st.category] : null;
  const sla = tenant.slas.find((s) => s.id === t.slaId);
  const ss = sla ? slaStatus(lc, t.statusHistory ?? [], sla.resolveMins, Date.now()) : null;
  const req = tenant.members.find((m) => m.uid === t.requesterId);
  const tech = tenant.members.find((m) => m.uid === t.technicianId);
  const nexts = canAct ? outgoing(lc, t.status) : [];
  const techs = tenant.members.filter((m) => m.role === 'technician' || m.role === 'tenant_admin')
    .sort((a, b) => (tenant.capacity[a.uid]?.off ? 1 : 0) - (tenant.capacity[b.uid]?.off ? 1 : 0)
      || ((tenant.capacity[a.uid]?.used ?? 0) / (tenant.capacity[a.uid]?.cap ?? 1)) - ((tenant.capacity[b.uid]?.used ?? 0) / (tenant.capacity[b.uid]?.cap ?? 1)));

  const pct = ss ? Math.min(100, Math.round((ss.consumedMins / ss.targetMins) * 100)) : 0;
  const paused = st?.category === 'stop_timer';
  return (
    <div className="card">
      <div className="id">{t.id} · {t.type === 'incident' ? 'Incidencia' : 'Solicitud'}</div>
      <h2 style={{ marginTop: 4 }}>{t.subject}</h2>
      <div className="facts">
        <div><div className="k">Prioridad</div><span className={'chip p-' + t.priority}>{PRI[t.priority ?? 'low']}</span></div>
        <div><div className="k">Estado</div>{cat && <span className="cat" style={{ color: cat[1], background: cat[2] }}>{st?.label} · {cat[0]}</span>}</div>
        <div><div className="k">Solicitante</div><span style={{ fontSize: 13 }}>{req?.name ?? '—'}</span></div>
        <div><div className="k">Técnico</div><span style={{ fontSize: 13 }}>{tech?.name ?? 'Sin asignar'}</span></div>
      </div>
      {ss && <div style={{ marginTop: 12 }}>
        <div className="k">SLA de resolución {paused && '· ⏸ en pausa'}</div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: ss.breached ? 'var(--crit)' : 'var(--ink-soft)' }}>
          {fmtMins(ss.consumedMins)} de {fmtMins(ss.targetMins)} consumidos {ss.breached ? '· incumplido' : `· quedan ${fmtMins(Math.max(0, ss.remainingMins))}`}
        </div>
        <div className="slabar"><span style={{ width: pct + '%', background: ss.breached ? 'var(--crit)' : paused ? 'var(--warn)' : 'var(--ok)' }} /></div>
      </div>}
      <div className="desc">{t.description}</div>

      {canAct && <>
        {nexts.length > 0 && <>
          <div className="section-t">Mover a</div>
          <div className="trbtns">{nexts.map((tr) => <button key={tr.id} className="trbtn" onClick={() => transition(t.id, tr.to)}>{stateOf(lc!, tr.to)?.label} →</button>)}</div>
        </>}
        <div className="section-t">Asignar técnico <span className="badge">⚡ carga vía OrganiZate</span></div>
        {techs.map((m) => {
          const c = tenant.capacity[m.uid] ?? { used: 0, cap: 40 };
          const [s, label] = capState(c); const p = c.cap ? Math.round((c.used / c.cap) * 100) : 0;
          return <button key={m.uid} className={'caprow' + (t.technicianId === m.uid ? ' on' : '')} disabled={!!c.off} onClick={() => assign(t.id, m.uid)}>
            <Avatar m={m} />
            <span><span className="nm">{m.name}{t.technicianId === m.uid ? ' · asignado' : ''}</span>
              <span className="bar"><span style={{ width: Math.min(p, 100) + '%', background: capColor(c) }} /></span>
              <span className="cmeta">{c.off ? '— ' + c.off : `${c.used} / ${c.cap} h · ${p}%`}</span></span>
            <span className={'state ' + s}>{label}</span>
          </button>;
        })}
      </>}
    </div>
  );
}

function NewTicket({ tenant, role, user, onClose }: { tenant: TenantData; role: Role; user: ReturnType<typeof buildUser>; onClose: () => void }) {
  const create = useStore((s) => s.createTicket);
  const [templateId, setTemplateId] = useState(tenant.templates[0]?.id ?? '');
  const [subject, setSubject] = useState('');
  const [category, setCategory] = useState(tenant.categories[0] ?? 'General');
  const [priority, setPriority] = useState<'high' | 'medium' | 'low'>('medium');
  const [description, setDescription] = useState('');
  const requesters = tenant.members.filter((m) => m.role === 'requester');
  const [requesterId, setRequesterId] = useState(role === 'requester' ? user.uid : requesters[0]?.uid ?? user.uid);
  const submit = () => { if (!subject.trim()) return; create({ subject, description, category, priority, requesterId, templateId }); onClose(); };
  return (
    <div className="card">
      <h2>Nuevo ticket</h2>
      <div className="form">
        {tenant.templates.length > 1 && <label>Tipo / plantilla<select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>{tenant.templates.map((tp) => <option key={tp.id} value={tp.id}>{tp.name}</option>)}</select></label>}
        <label>Asunto<input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Describe el problema…" /></label>
        <label>Descripción<textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} /></label>
        <label>Categoría<select value={category} onChange={(e) => setCategory(e.target.value)}>{tenant.categories.map((c) => <option key={c} value={c}>{c}</option>)}</select></label>
        <label>Prioridad<select value={priority} onChange={(e) => setPriority(e.target.value as any)}><option value="high">Alta</option><option value="medium">Media</option><option value="low">Baja</option></select></label>
        {role !== 'requester' && <label>Solicitante<select value={requesterId} onChange={(e) => setRequesterId(e.target.value)}>{requesters.map((m) => <option key={m.uid} value={m.uid}>{m.name}</option>)}</select></label>}
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="primary" onClick={submit}>Crear ticket</button>
          <button className="ghost" onClick={onClose}>Cancelar</button>
        </div>
      </div>
    </div>
  );
}

function AdminNav() {
  const adminSec = useStore((s) => s.adminSec);
  const setAdminSec = useStore((s) => s.setAdminSec);
  const secs: [string, string][] = [['lifecycle', 'Ciclos de vida'], ['sla', 'SLA'], ['catalog', 'Catálogo']];
  return <>
    <div className="cap">Administración</div>
    {secs.map(([k, l]) => <button key={k} className={'qbtn' + (adminSec === k ? ' on' : '')} onClick={() => setAdminSec(k)}>{l}</button>)}
  </>;
}

function AdminArea({ tenant }: { tenant: TenantData }) {
  const adminSec = useStore((s) => s.adminSec);
  if (adminSec === 'sla') return <SlaAdmin tenant={tenant} />;
  if (adminSec === 'catalog') return <CatalogAdmin tenant={tenant} />;
  return <GraphEditor tenant={tenant} />;
}

function SlaAdmin({ tenant }: { tenant: TenantData }) {
  return <div className="card"><h2>SLA</h2>
    <div className="facts" style={{ gridTemplateColumns: '1fr auto auto' }}>
      <div className="k">Nombre</div><div className="k">Respuesta</div><div className="k">Resolución</div>
      {tenant.slas.map((s) => <Fragment key={s.id}><div style={{ fontSize: 13, fontWeight: 600 }}>{s.name}</div><div className="mono" style={{ fontSize: 12 }}>{fmtMins(s.responseMins)}</div><div className="mono" style={{ fontSize: 12 }}>{fmtMins(s.resolveMins)}</div></Fragment>)}
    </div>
    <div className="banner" style={{ marginTop: 12 }}>El SLA solo consume en estados <b>En curso</b>; se pausa en <b>Detener temporizador</b>. Verificado en el motor (sla.ts).</div>
  </div>;
}

const STAGE_ORDER: Stage[] = ['open', 'pending', 'resolved', 'closed'];
type SNData = { label: string; category: SlaCategory; isInitial?: boolean; isTerminal?: boolean };
type SNode = Node<SNData, 'state'>;

function StateNode({ data, selected }: NodeProps) {
  const d = data as SNData; const c = CAT[d.category];
  return (
    <div className="rf-state" style={{ background: c[2], borderColor: selected ? 'var(--accent)' : c[1], boxShadow: selected ? '0 0 0 2px var(--accent)' : 'none' }}>
      <Handle type="target" position={Position.Left} className="rf-h" />
      <span className="rf-dot" style={{ background: c[1] }} />
      <div className="rf-txt">
        <div className="rf-label">{d.label}</div>
        <div className="rf-cat" style={{ color: c[1] }}>{c[0].toUpperCase()}</div>
      </div>
      {d.isInitial && <span className="rf-badge" style={{ color: 'var(--accent)' }}>▶</span>}
      {d.isTerminal && <span className="rf-badge" style={{ color: 'var(--ink-faint)' }}>■</span>}
      <Handle type="source" position={Position.Right} className="rf-h" />
    </div>
  );
}
const nodeTypes = { state: StateNode };

function GraphEditor({ tenant }: { tenant: TenantData }) {
  const idx = useStore((s) => s.adminLcIndex);
  const setLc = useStore((s) => s.setAdminLc);
  const addLifecycle = useStore((s) => s.addLifecycle);
  const renameLifecycle = useStore((s) => s.renameLifecycle);
  const setPublished = useStore((s) => s.setLifecyclePublished);
  const removeLifecycle = useStore((s) => s.removeLifecycle);
  const lc = tenant.lifecycles[Math.min(idx, tenant.lifecycles.length - 1)]!;
  return <div>
    <div className="tabs">
      {tenant.lifecycles.map((l, i) => <button key={l.id ?? i} className={i === idx ? 'on' : ''} onClick={() => setLc(i)}>
        {l.name} <span style={{ opacity: .6 }}>v{l.version}</span>{!l.published && <span className="draftdot" title="Borrador">•</span>}
      </button>)}
      <button className="ghost" onClick={() => addLifecycle('Nuevo flujo', 'service_request')}>＋ Nuevo flujo</button>
    </div>
    <div className="flowmeta">
      <input value={lc.name} onChange={(e) => renameLifecycle(e.target.value)} style={{ fontWeight: 700, minWidth: 240 }} />
      <span className="pill">v{lc.version}</span>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--ink-soft)' }}>
        <input type="checkbox" checked={lc.published} onChange={(e) => setPublished(e.target.checked)} /> Publicado
      </label>
      <button className="ghost" style={{ color: 'var(--crit)', marginLeft: 'auto' }} disabled={tenant.lifecycles.length <= 1} onClick={() => removeLifecycle()}>🗑 Borrar flujo</button>
    </div>
    <div className="banner">Editor gráfico <b>real</b>: crea flujos, arrastra los estados, conéctalos y edítalos. Cada estado tiene su categoría de temporizador (En curso consume SLA · Detener temporizador lo pausa · Completado). Todo se guarda y gobierna las transiciones válidas y el SLA de los tickets.</div>
    <FlowCanvas key={lc.id ?? 'x'} lc={lc} />
  </div>;
}

function FlowCanvas({ lc }: { lc: import('../model.js').Lifecycle }) {
  const addState = useStore((s) => s.addState);
  const removeState = useStore((s) => s.removeState);
  const addTransition = useStore((s) => s.addTransition);
  const removeTransition = useStore((s) => s.removeTransition);
  const updateState = useStore((s) => s.updateState);
  const setNodePos = useStore((s) => s.setNodePos);
  const savedLayout = useStore((s) => s.layouts[lc.id ?? '']);
  const lcId = lc.id ?? 'x';
  const [sel, setSel] = useState<string | null>(null);

  const nodeFor = useCallback((cur: SNode[]): SNode[] => {
    const per: Record<string, number> = {};
    return lc.states.map((s) => {
      const stageIdx = Math.max(0, STAGE_ORDER.indexOf(s.stage));
      per[s.stage] = per[s.stage] ?? 0;
      const def = { x: stageIdx * 250 + 30, y: 40 + per[s.stage]! * 108 };
      per[s.stage]!++;
      const pos = cur.find((n) => n.id === s.key)?.position ?? savedLayout?.[s.key] ?? def;
      return { id: s.key, type: 'state', position: pos, data: { label: s.label, category: s.category, isInitial: s.isInitial, isTerminal: s.isTerminal } };
    });
  }, [lc, savedLayout]);
  const edgesFor = useCallback((): Edge[] => {
    const rank = (k: string) => Math.max(0, STAGE_ORDER.indexOf(lc.states.find((s) => s.key === k)?.stage ?? 'open'));
    return lc.transitions.map((tr) => {
      const ret = rank(tr.to) < rank(tr.from); // retorno = va a una fase anterior (reapertura, volver de espera…)
      const color = ret ? '#e0824e' : '#7a8194';
      return {
        id: tr.id, source: tr.from, target: tr.to, label: tr.name, type: 'smoothstep',
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color },
        style: { stroke: color, strokeWidth: 1.6, ...(ret ? { strokeDasharray: '6 4' } : {}) },
        data: { ret },
      };
    });
  }, [lc]);

  const [nodes, setNodes, onNodesChange] = useNodesState<SNode>(nodeFor([]));
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(edgesFor());
  useEffect(() => { setNodes((cur) => nodeFor(cur)); setEdges(edgesFor()); }, [lc, nodeFor, edgesFor, setNodes, setEdges]);

  const rf = useRef<ReactFlowInstance<SNode, Edge> | null>(null);
  const reorganize = () => {
    const per: Record<string, number> = {}; const np: Record<string, { x: number; y: number }> = {};
    lc.states.forEach((s) => { const col = Math.max(0, STAGE_ORDER.indexOf(s.stage)); per[s.stage] = per[s.stage] ?? 0; np[s.key] = { x: col * 260 + 30, y: 40 + per[s.stage]! * 112 }; per[s.stage]!++; });
    setNodes((cur) => cur.map((n) => ({ ...n, position: np[n.id] ?? n.position })));
    Object.entries(np).forEach(([k, p]) => setNodePos(lcId, k, p.x, p.y));
    setTimeout(() => rf.current?.fitView({ padding: 0.2, duration: 400 }), 60);
  };

  const selState = lc.states.find((s) => s.key === sel);

  return <>
    <div style={{ display: 'flex', gap: 8, marginBottom: 10, alignItems: 'center', flexWrap: 'wrap' }}>
      <button className="primary" onClick={() => addState('Nuevo estado', 'in_progress', 'open')}>＋ Estado</button>
      <button className="ghost" onClick={reorganize}>⤢ Reorganizar</button>
      <span style={{ fontSize: 12, color: 'var(--ink-faint)' }}>Arrastra los estados · conéctalos tirando del punto derecho de uno al izquierdo de otro · Supr para borrar · clic para editar.</span>
    </div>

    <div className="work" style={{ gridTemplateColumns: '1fr 300px' }}>
      <div className="card rf-wrap" style={{ padding: 0, height: 540, overflow: 'hidden' }}>
        <ReactFlow
          nodes={nodes} edges={edges} nodeTypes={nodeTypes}
          onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
          onConnect={(c: Connection) => { if (c.source && c.target) addTransition(c.source, c.target); }}
          onNodeDragStop={(_, n) => setNodePos(lcId, n.id, n.position.x, n.position.y)}
          onNodeClick={(_, n) => setSel(n.id)}
          onNodesDelete={(ns) => ns.forEach((n) => removeState(n.id))}
          onEdgesDelete={(es) => es.forEach((e) => removeTransition(e.id))}
          onInit={(inst) => { rf.current = inst; setTimeout(() => inst.fitView({ padding: 0.2 }), 50); }}
          fitView minZoom={0.3}
          defaultEdgeOptions={{ type: 'smoothstep', markerEnd: { type: MarkerType.ArrowClosed } }}>
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable nodeColor={(n) => CAT[(n.data as SNData).category]?.[1] ?? '#999'} nodeStrokeWidth={2} />
          <Panel position="top-right" className="rf-legend">
            <div className="rl-row"><span className="rl-dot" style={{ background: 'var(--ok)' }} />En curso</div>
            <div className="rl-row"><span className="rl-dot" style={{ background: 'var(--warn)' }} />Detener temporizador</div>
            <div className="rl-row"><span className="rl-dot" style={{ background: 'var(--st-closed)' }} />Completado</div>
            <div className="rl-sep" />
            <div className="rl-row"><span className="rl-line" style={{ background: '#7a8194' }} />avance</div>
            <div className="rl-row"><span className="rl-line dash" style={{ background: '#e0824e' }} />retorno</div>
          </Panel>
        </ReactFlow>
      </div>

      <div className="card">
        {selState ? <StateEditor lc={lc} s={selState} onUpdate={(patch) => updateState(selState.key, patch)} onDelete={() => { removeState(selState.key); setSel(null); }} /> : <div className="empty">Selecciona un estado en el lienzo para editarlo, o pulsa <b>＋ Estado</b>.</div>}
        <div className="section-t" style={{ marginTop: 18 }}>Transiciones <span className="badge">{lc.transitions.length}</span></div>
        {lc.transitions.map((tr) => <div key={tr.id} className="trrow">
          <span className="pill">{stateOf(lc, tr.from)?.label ?? tr.from}</span><span>→</span><span className="pill">{stateOf(lc, tr.to)?.label ?? tr.to}</span>
          <button className="xbtn" style={{ marginLeft: 'auto' }} onClick={() => removeTransition(tr.id)}>✕</button>
        </div>)}
        {lc.transitions.length === 0 && <div className="empty">Sin transiciones. Conecta dos estados en el lienzo.</div>}
      </div>
    </div>
  </>;
}

function StateEditor({ s, onUpdate, onDelete }: { lc: import('../model.js').Lifecycle; s: import('../model.js').LifecycleState; onUpdate: (p: Partial<import('../model.js').LifecycleState>) => void; onDelete: () => void }) {
  return <div>
    <h2>Editar estado</h2>
    <div className="form">
      <label>Nombre<input value={s.label} onChange={(e) => onUpdate({ label: e.target.value })} /></label>
      <label>Categoría de temporizador<select value={s.category} onChange={(e) => onUpdate({ category: e.target.value as SlaCategory })}><option value="in_progress">En curso (consume SLA)</option><option value="stop_timer">Detener temporizador (pausa)</option><option value="completed">Completado</option></select></label>
      <label>Fase<select value={s.stage} onChange={(e) => onUpdate({ stage: e.target.value as Stage })}><option value="open">Abierto</option><option value="pending">En espera</option><option value="resolved">Resuelto</option><option value="closed">Cerrado</option></select></label>
      <div style={{ display: 'flex', gap: 14, fontSize: 12.5 }}>
        <label style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}><input type="checkbox" checked={!!s.isInitial} onChange={(e) => onUpdate({ isInitial: e.target.checked })} /> Inicial</label>
        <label style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}><input type="checkbox" checked={!!s.isTerminal} onChange={(e) => onUpdate({ isTerminal: e.target.checked })} /> Terminal</label>
      </div>
      <button className="ghost" style={{ color: 'var(--crit)', alignSelf: 'flex-start' }} onClick={onDelete}>Eliminar estado</button>
    </div>
  </div>;
}

function CatalogAdmin({ tenant }: { tenant: TenantData }) {
  const addCategory = useStore((s) => s.addCategory);
  const addTemplate = useStore((s) => s.addTemplate);
  const importSnapshot = useStore((s) => s.importSnapshot);
  const [cat, setCat] = useState('');
  const [tname, setTname] = useState('');
  const [ttype, setTtype] = useState<'incident' | 'service_request'>('incident');
  const [tlc, setTlc] = useState(tenant.lifecycles[0]?.id ?? null);
  const [raw, setRaw] = useState('');
  const [msg, setMsg] = useState('');
  const doImport = () => {
    try {
      const snap = JSON.parse(raw);
      importSnapshot(snap);
      const n = (snap.templates?.length ?? 0) + (snap.categories?.length ?? 0) + (snap.slas?.length ?? 0) + (snap.members?.length ?? 0);
      setMsg(`✓ Importado: ${snap.categories?.length ?? 0} categorías, ${snap.templates?.length ?? 0} plantillas, ${snap.slas?.length ?? 0} SLAs, ${snap.members?.length ?? 0} personas (${n} elementos).`);
      setRaw('');
    } catch (e) { setMsg('✕ JSON no válido: ' + (e as Error).message); }
  };
  return <div>
    <div className="work">
      <div className="card">
        <h2>Plantillas / tipologías</h2>
        <div style={{ marginTop: 12 }}>
          {tenant.templates.map((tp) => <div key={tp.id} className="lcstate">
            <span className="sdot" style={{ background: tp.type === 'incident' ? 'var(--p-high)' : 'var(--p-med)' }} />
            <span><b style={{ fontSize: 13.5 }}>{tp.name}</b> <span className="pill">{tp.type === 'incident' ? 'Incidencia' : 'Solicitud'}</span>
              <span className="pill">{tenant.lifecycles.find((l) => l.id === tp.lifecycleId)?.name ?? 'sin flujo'}</span></span>
            <span className="pill">{tp.fields.length} campos</span>
          </div>)}
        </div>
        <div className="designer">
          <input style={{ flex: 1, minWidth: 120 }} value={tname} onChange={(e) => setTname(e.target.value)} placeholder="Nueva plantilla…" />
          <select value={ttype} onChange={(e) => setTtype(e.target.value as any)}><option value="incident">Incidencia</option><option value="service_request">Solicitud</option></select>
          <select value={tlc ?? ''} onChange={(e) => setTlc(e.target.value || null)}><option value="">— sin flujo —</option>{tenant.lifecycles.map((l) => <option key={l.id ?? ''} value={l.id ?? ''}>{l.name}</option>)}</select>
          <button className="primary" onClick={() => { if (tname.trim()) { addTemplate(tname.trim(), ttype, tlc); setTname(''); } }}>＋ Plantilla</button>
        </div>
      </div>
      <div className="card">
        <h2>Categorías <span className="badge">{tenant.categories.length}</span></h2>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 12 }}>
          {tenant.categories.map((c) => <span key={c} className="pill">{c}</span>)}
        </div>
        <div className="designer">
          <input style={{ flex: 1, minWidth: 120 }} value={cat} onChange={(e) => setCat(e.target.value)} placeholder="Nueva categoría…" />
          <button className="primary" onClick={() => { if (cat.trim()) { addCategory(cat.trim()); setCat(''); } }}>＋ Categoría</button>
        </div>
      </div>
    </div>
    <div className="card" style={{ marginTop: 16 }}>
      <h2>Importar datos de SDP</h2>
      <div className="banner" style={{ marginTop: 10 }}>Pega aquí el <code>imported-seed.json</code> generado por el importador (<code>npm run import</code> con la API v3). Reemplaza categorías, plantillas, SLAs, grupos y personas de <b>{tenant.name}</b>.</div>
      <textarea value={raw} onChange={(e) => setRaw(e.target.value)} rows={5} placeholder='{ "categories": [...], "templates": [...], "slas": [...], "members": [...] }' style={{ width: '100%', fontFamily: 'var(--mono)', fontSize: 12 }} />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
        <button className="primary" onClick={doImport} disabled={!raw.trim()}>Importar</button>
        {msg && <span style={{ fontSize: 12.5, color: msg.startsWith('✓') ? 'var(--ok)' : 'var(--crit)' }}>{msg}</span>}
      </div>
    </div>
  </div>;
}
