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
import type { SlaCategory, Stage, Template } from '../model.js';
import type { TenantData, StoredTicket, UiMember, Capacity } from '../data/seed.js';

const CAT: Record<SlaCategory, [string, string, string]> = {
  in_progress: ['En curso', 'var(--ok)', 'var(--ok-bg)'],
  stop_timer: ['Detener temporizador', 'var(--warn)', 'var(--warn-bg)'],
  completed: ['Completado', 'var(--st-closed)', 'var(--sink)'],
};
const PRI: Record<string, string> = { high: 'Alta', medium: 'Media', low: 'Baja' };

/** Convierte el rich-text HTML de SDP (estilos inline, imágenes de servlet) a
 *  texto limpio y legible. Las imágenes del servlet de SDP no cargan aquí → se
 *  marcan. Texto plano pasa tal cual. Sin dangerouslySetInnerHTML (evita XSS). */
function richToText(html: string): string {
  if (!html) return '';
  if (!/[<&]/.test(html)) return html;
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('img').forEach((im) => im.replaceWith(doc.createTextNode('🖼 [imagen adjunta en SDP]\n')));
    doc.querySelectorAll('br').forEach((b) => b.replaceWith(doc.createTextNode('\n')));
    doc.querySelectorAll('p,div,li,tr,h1,h2,h3').forEach((el) => el.appendChild(doc.createTextNode('\n')));
    return (doc.body.textContent ?? '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  } catch { return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }
}
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
  const cloudReady = useStore((s) => s.cloudReady);
  const hasAccess = useStore((s) => s.hasAccess);
  const startCloud = useStore((s) => s.startCloud);
  const authUser = useAuth((s) => s.user);
  const authReady = useAuth((s) => s.ready);
  useEffect(() => { void useAuth.getState().init(); }, []);
  useEffect(() => { if (firebaseEnabled && authUser) void startCloud(authUser.uid); }, [authUser?.uid, startCloud]);
  const [, setTheme] = useState<'light' | 'dark' | null>(null);
  const [view, setView] = useState<'home' | 'tickets' | 'admin'>('home');
  const [filter, setFilter] = useState<'all' | 'unassigned' | 'mine'>('all');
  const [showNew, setShowNew] = useState(false);

  // Identidad: en la nube = uid del usuario autenticado (los docs de miembro van
  // keyados por ese uid); en local = selector de personas (demo).
  const effectiveUserId = firebaseEnabled ? (authUser?.uid ?? '') : currentUserId;
  const user = buildUser(db, effectiveUserId);
  const myTenants = tenantsForUser(db, user);
  const tenant = db.tenants.find((t) => t.id === activeTenantId) ?? myTenants[0] ?? db.tenants[0];
  const role: Role = user.platformAdmin ? 'tenant_admin' : (tenant ? user.memberships[tenant.id]?.role ?? 'requester' : 'requester');
  const people = db.tenants.flatMap((t) => t.members).filter((m, i, a) => a.findIndex((x) => x.uid === m.uid) === i);
  const displayMember = db.tenants.flatMap((t) => t.members).find((m) => m.uid === effectiveUserId);

  const toggleTheme = () => {
    const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next; setTheme(next);
  };
  const card = (msg: string) => <div className="login-wrap"><div className="login-card" style={{ textAlign: 'center', color: 'var(--ink-faint)' }}>{msg}</div></div>;

  // Gates de sesión (solo en la nube).
  if (firebaseEnabled && !authReady) return card('Cargando…');
  if (firebaseEnabled && !authUser) return <Login />;
  if (firebaseEnabled && !cloudReady) return card('Conectando con la nube…');
  if (firebaseEnabled && !hasAccess) return (
    <div className="login-wrap"><div className="login-card" style={{ textAlign: 'center' }}>
      <div className="brand" style={{ justifyContent: 'center', fontSize: 20 }}><span className="glyph">A</span> Atenza</div>
      <p style={{ margin: '16px 0', color: 'var(--ink-soft)', fontSize: 14 }}>Sin acceso todavía.<br /><b>{authUser?.email}</b> no pertenece a ninguna instancia. Pide a un administrador que te invite.</p>
      <button className="ghost" onClick={() => doSignOut()}>Salir</button>
    </div></div>
  );
  if (firebaseEnabled && !tenant) return card('Sincronizando datos…');
  if (!tenant) return card('Sin datos.');

  const isReq = role === 'requester';
  const activeView: 'home' | 'tickets' | 'admin' = isReq ? 'tickets' : view;
  const openCount = tenant.tickets.length;
  const myReqCount = tenant.tickets.filter((t) => t.requesterId === effectiveUserId).length;

  return (
    <div>
      <div className="top">
        <div className="brand"><span className="glyph">A</span> Atenza <small>{firebaseEnabled ? 'nube' : 'local'}</small></div>
        {myTenants.length > 1 && (
          <select className="instsel" value={tenant.id} onChange={(e) => setTenant(e.target.value)} title="Instancia">
            {myTenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        )}
        <label className="searchbox">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" /></svg>
          <input placeholder="Buscar solicitudes, personas…" aria-label="Buscar" />
        </label>
        <div className="spring" />
        <button className="newtop" onClick={() => setShowNew(true)}>＋ Nueva solicitud</button>
        <button className="iconbtn" title="Notificaciones" aria-label="Notificaciones">🔔</button>
        <button className="iconbtn" onClick={toggleTheme} title="Tema" aria-label="Cambiar tema">◐</button>
        {firebaseEnabled ? <>
          <span className="who-mini">{displayMember?.name ?? authUser?.email}</span>
          <button className="ghost" onClick={() => doSignOut()}>Salir</button>
        </> : (
          <select value={currentUserId} onChange={(e) => { setUser(e.target.value); setView('home'); }} title="Identidad (demo)">
            {people.map((p) => <option key={p.uid} value={p.uid}>{p.name}</option>)}
          </select>
        )}
        <span className="rolebadge">{role === 'tenant_admin' ? 'Admin' : role === 'technician' ? 'Técnico' : 'Solicitante'}</span>
      </div>

      <div className="shell">
        <aside className="side">
          <div className="cap">Menú</div>
          {!isReq && <button className={'modlink' + (activeView === 'home' ? ' on' : '')} onClick={() => setView('home')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 10.5L12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /></svg>
            <span className="ml-l">Inicio</span></button>}
          <button className={'modlink' + (activeView === 'tickets' ? ' on' : '')} onClick={() => setView('tickets')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M8 4v16" /></svg>
            <span className="ml-l">{isReq ? 'Mis solicitudes' : 'Solicitudes'}</span><span className="n">{isReq ? myReqCount : openCount}</span></button>
          {role === 'tenant_admin' && <button className={'modlink' + (activeView === 'admin' ? ' on' : '')} onClick={() => setView('admin')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3" /><path d="M19 12a7 7 0 00-.1-1.1l2-1.5-2-3.4-2.3 1a7 7 0 00-1.9-1.1L14.3 2h-4l-.4 2.3a7 7 0 00-1.9 1.1l-2.3-1-2 3.4 2 1.5A7 7 0 005.6 12c0 .4 0 .7.1 1.1l-2 1.5 2 3.4 2.3-1c.6.5 1.2.8 1.9 1.1l.4 2.4h4l.4-2.4c.7-.3 1.3-.6 1.9-1.1l2.3 1 2-3.4-2-1.5c.1-.4.1-.7.1-1.1z" /></svg>
            <span className="ml-l">Administración</span></button>}
          <div className="foot">
            {myTenants.length > 1 ? 'Perteneces a varias instancias.' : `Instancia ${tenant.name}.`} Todo aquí es propio de <b>{tenant.name}</b>.
          </div>
        </aside>

        <main className="main">
          {activeView === 'home' && !isReq && <Dashboard tenant={tenant} user={user} go={(f) => { setFilter(f); setView('tickets'); }} />}
          {activeView === 'tickets' && <Workspace tenant={tenant} role={role} user={user} filter={filter} setFilter={setFilter} />}
          {activeView === 'admin' && role === 'tenant_admin' && <><AdminNav /><AdminArea tenant={tenant} /></>}
        </main>
      </div>

      {showNew && <NewTicket tenant={tenant} role={role} user={user} onClose={() => setShowNew(false)} />}
    </div>
  );
}

// Panel de inicio: KPIs + widgets calculados a partir de los datos reales del tenant.
function Dashboard({ tenant, user, go }: { tenant: TenantData; user: ReturnType<typeof buildUser>; go: (f: 'all' | 'unassigned' | 'mine') => void }) {
  const now = Date.now();
  const tickets = tenant.tickets;
  const isOverdue = (t: StoredTicket) => !!t.resolveDueAt && t.resolveDueAt < now;
  const unassigned = tickets.filter((t) => !t.technicianId).length;
  const overdue = tickets.filter(isOverdue).length;
  const mine = tickets.filter((t) => t.technicianId === user.uid).length;

  const techName = (uid: string) => tenant.members.find((m) => m.uid === uid)?.name ?? '—';
  const byTech = new Map<string, { open: number; over: number }>();
  for (const t of tickets) { if (!t.technicianId) continue; const e = byTech.get(t.technicianId) ?? { open: 0, over: 0 }; e.open++; if (isOverdue(t)) e.over++; byTech.set(t.technicianId, e); }
  const techRows = [...byTech.entries()].map(([uid, v]) => ({ uid, name: techName(uid), ...v })).sort((a, b) => b.open - a.open).slice(0, 8);

  const stateLabel = (t: StoredTicket) => { const lc = lifecycleOfTicket(tenant, t); const st = lc ? stateOf(lc, t.status) : undefined; return st?.label ?? t.status; };
  const byState = new Map<string, number>();
  for (const t of tickets) { const l = stateLabel(t); byState.set(l, (byState.get(l) ?? 0) + 1); }
  const stateRows = [...byState.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  const stateMax = Math.max(1, ...stateRows.map((r) => r[1]));
  const STC = ['var(--accent)', '#0891b2', 'var(--warn)', '#be185d', '#0f766e', 'var(--st-closed)'];

  const groupName = (id?: string | null) => tenant.groups.find((g) => g.id === id)?.name ?? 'Sin grupo';
  const byGroup = new Map<string, number>();
  for (const t of tickets) { const g = groupName(t.groupId); byGroup.set(g, (byGroup.get(g) ?? 0) + 1); }
  const groupRows = [...byGroup.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  const groupMax = Math.max(1, ...groupRows.map((r) => r[1]));

  return <>
    <div className="hd"><h1>Panel de servicio</h1><span className="sub">{tenant.name} · {tickets.length} solicitudes activas</span></div>
    <div className="kpis">
      <button className="kpi" onClick={() => go('all')}><div className="kl">Abiertas</div><div className="kv">{tickets.length}</div><div className="kstrip" style={{ background: 'var(--accent)' }} /></button>
      <button className="kpi" onClick={() => go('unassigned')}><div className="kl">Sin asignar</div><div className="kv" style={{ color: 'var(--warn)' }}>{unassigned}</div><div className="kstrip" style={{ background: 'var(--warn)' }} /></button>
      <button className="kpi" onClick={() => go('all')}><div className="kl">Vencidas (SLA)</div><div className="kv" style={{ color: 'var(--crit)' }}>{overdue}</div><div className="kstrip" style={{ background: 'var(--crit)' }} /></button>
      <button className="kpi" onClick={() => go('mine')}><div className="kl">Mías</div><div className="kv">{mine}</div><div className="kstrip" style={{ background: 'var(--ok)' }} /></button>
    </div>
    <div className="dgrid">
      <div className="card dwide">
        <h2>Solicitudes por técnico <span className="badge">⚡ carga vía OrganiZate</span></h2>
        <table className="dtbl"><thead><tr><th>Técnico</th><th className="num">Abiertas</th><th className="num">Vencidas</th><th className="num">Capacidad</th></tr></thead>
          <tbody>{techRows.map((r) => { const c = tenant.capacity[r.uid] ?? { used: 0, cap: 40 }; const p = c.cap ? Math.round((c.used / c.cap) * 100) : 0; const mem = tenant.members.find((m) => m.uid === r.uid); return <tr key={r.uid}>
            <td><div className="who">{mem ? <Avatar m={mem} /> : <span className="av" style={{ background: 'var(--ink-faint)' }}>?</span>} {r.name}</div></td>
            <td className="num mono">{r.open}</td>
            <td className="num"><span style={{ color: r.over ? 'var(--crit)' : 'var(--ink-faint)', fontWeight: 700, fontFamily: 'var(--mono)' }}>{r.over}</span></td>
            <td className="num"><div className="capmini"><span style={{ width: Math.min(p, 100) + '%', background: capColor(c) }} /></div></td>
          </tr>; })}
          {techRows.length === 0 && <tr><td colSpan={4} className="empty">Sin tickets asignados.</td></tr>}</tbody></table>
      </div>
      <div className="card">
        <h2>Por estado</h2>
        <div className="drows">{stateRows.map(([l, n], i) => <div key={l} className="drow">
          <span className="dl">{l}</span><span className="dbar"><span style={{ width: (n / stateMax * 100) + '%', background: STC[i % STC.length] }} /></span><span className="dn mono">{n}</span>
        </div>)}</div>
      </div>
      <div className="card">
        <h2>Cola por grupo de soporte</h2>
        <div className="drows">{groupRows.map(([l, n]) => <div key={l} className="drow">
          <span className="dl">{l}</span><span className="dbar"><span style={{ width: (n / groupMax * 100) + '%', background: 'var(--accent)' }} /></span><span className="dn mono">{n}</span>
        </div>)}</div>
      </div>
      <div className="card">
        <h2>Resumen</h2>
        <div className="facts" style={{ marginTop: 4 }}>
          <div><div className="k">Plantillas</div><b style={{ fontSize: 18 }}>{tenant.templates.length}</b></div>
          <div><div className="k">Flujos</div><b style={{ fontSize: 18 }}>{tenant.lifecycles.length}</b></div>
          <div><div className="k">Grupos</div><b style={{ fontSize: 18 }}>{tenant.groups.length}</b></div>
          <div><div className="k">Personas</div><b style={{ fontSize: 18 }}>{tenant.members.length}</b></div>
        </div>
      </div>
    </div>
  </>;
}

function Workspace({ tenant, role, user, filter, setFilter }:
  { tenant: TenantData; role: Role; user: ReturnType<typeof buildUser>; filter: 'all' | 'unassigned' | 'mine'; setFilter: (f: 'all' | 'unassigned' | 'mine') => void }) {
  const selectedId = useStore((s) => s.selectedTicketId);
  const select = useStore((s) => s.select);
  const isReq = role === 'requester';
  const all = tenant.tickets;
  let list = all;
  if (isReq) list = all.filter((t) => t.requesterId === user.uid);
  else if (filter === 'unassigned') list = all.filter((t) => !t.technicianId);
  else if (filter === 'mine') list = all.filter((t) => t.technicianId === user.uid);
  const selected = list.find((t) => t.id === selectedId) ?? null;
  const counts = { all: all.length, unassigned: all.filter((t) => !t.technicianId).length, mine: all.filter((t) => t.technicianId === user.uid).length };
  const tabs: [typeof filter, string][] = [['all', 'Todas'], ['unassigned', 'Sin asignar'], ['mine', 'Mías']];

  return <>
    <div className="hd">
      <h1>{isReq ? 'Mis solicitudes' : 'Solicitudes'}</h1>
      <span className="sub">{tenant.name} · {list.length} de {all.length}</span>
      {!isReq && <div className="tabs" style={{ marginLeft: 'auto', marginBottom: 0 }}>
        {tabs.map(([k, l]) => <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{l} <span className="tabn">{counts[k]}</span></button>)}
      </div>}
    </div>
    <div className="work">
      <div className="listwrap">
        {list.length === 0 && <div className="empty">No hay solicitudes en esta vista.</div>}
        {list.map((t) => <TicketRow key={t.id} tenant={tenant} t={t} sel={t.id === selectedId} onClick={() => select(t.id)} />)}
      </div>
      <div>
        {selected ? <TicketDetail tenant={tenant} t={selected} canAct={!isReq} />
          : <div className="card"><div className="empty">Selecciona una solicitud para ver el detalle.</div></div>}
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
  const group = tenant.groups.find((g) => g.id === t.groupId);
  // Perfilado: solo los técnicos del grupo del ticket son asignables (como SDP).
  // Si el ticket no tiene grupo o el grupo no tiene técnicos cargados, cae al roster completo.
  const allTechs = tenant.members.filter((m) => m.role === 'technician' || m.role === 'tenant_admin');
  const scoped = group ? allTechs.filter((m) => (m.groupIds ?? []).includes(group.id)) : [];
  const techs = (scoped.length ? scoped : allTechs)
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
        {group && <div><div className="k">Grupo</div><span style={{ fontSize: 13 }}>{group.name}</span></div>}
        {t.category && <div><div className="k">Categoría</div><span style={{ fontSize: 13 }}>{t.category}</span></div>}
      </div>
      {ss && <div style={{ marginTop: 12 }}>
        <div className="k">SLA de resolución {paused && '· ⏸ en pausa'}</div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: ss.breached ? 'var(--crit)' : 'var(--ink-soft)' }}>
          {fmtMins(ss.consumedMins)} de {fmtMins(ss.targetMins)} consumidos {ss.breached ? '· incumplido' : `· quedan ${fmtMins(Math.max(0, ss.remainingMins))}`}
        </div>
        <div className="slabar"><span style={{ width: pct + '%', background: ss.breached ? 'var(--crit)' : paused ? 'var(--warn)' : 'var(--ok)' }} /></div>
      </div>}
      {t.description && <div className="desc" style={{ whiteSpace: 'pre-wrap' }}>{richToText(t.description)}</div>}

      {canAct && <>
        {nexts.length > 0 && <>
          <div className="section-t">Mover a</div>
          <div className="trbtns">{nexts.map((tr) => <button key={tr.id} className="trbtn" onClick={() => transition(t.id, tr.to)}>{stateOf(lc!, tr.to)?.label} →</button>)}</div>
        </>}
        <div className="section-t">Asignar técnico <span className="badge">⚡ carga vía OrganiZate</span>{scoped.length > 0 && group && <span className="pill" style={{ marginLeft: 6 }}>grupo: {group.name}</span>}</div>
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

const tplGroup = (t: Template) => t.group ?? (t.type === 'incident' ? 'Incidencias' : 'Solicitudes de servicio');

function NewTicket({ tenant, role, user, onClose }: { tenant: TenantData; role: Role; user: ReturnType<typeof buildUser>; onClose: () => void }) {
  const create = useStore((s) => s.createTicket);
  const [tpl, setTpl] = useState<Template | null>(tenant.templates.length === 1 ? tenant.templates[0]! : null);
  const [q, setQ] = useState('');
  const [subject, setSubject] = useState('');
  const [category, setCategory] = useState(tenant.categories[0] ?? 'General');
  const [priority, setPriority] = useState<'high' | 'medium' | 'low'>('medium');
  const [description, setDescription] = useState('');
  const requesters = tenant.members.filter((m) => m.role === 'requester');
  const [requesterId, setRequesterId] = useState(role === 'requester' ? user.uid : requesters[0]?.uid ?? user.uid);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const groups = new Map<string, Template[]>();
  for (const t of tenant.templates) {
    if (q && !t.name.toLowerCase().includes(q.toLowerCase())) continue;
    const g = tplGroup(t); if (!groups.has(g)) groups.set(g, []); groups.get(g)!.push(t);
  }
  const grpList = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const submit = () => { if (!subject.trim() || !tpl) return; create({ subject, description, category, priority, requesterId, templateId: tpl.id }); onClose(); };

  return (
    <div className="scrim" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Nueva solicitud">
        <div className="drawer-h">
          <h2>{tpl ? 'Nueva solicitud' : 'Generar una solicitud'}</h2>
          <button className="dx" onClick={onClose} aria-label="Cerrar">×</button>
        </div>
        <div className="drawer-b">
          {!tpl ? <>
            <label className="searchbox drawer-search"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" /></svg><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar plantilla de solicitud" /></label>
            {grpList.map(([g, tps], i) => { const isOpen = open[g] ?? (i === 0 || !!q); return <div key={g} className={'catgrp' + (isOpen ? ' open' : '')}>
              <button className="catgrp-h" onClick={() => setOpen((o) => ({ ...o, [g]: !isOpen }))}>
                <span className="catgrp-ic" style={{ background: 'var(--accent)' }}>{g[0]}</span>
                <span className="catgrp-n">{g}</span><span className="catgrp-c">{tps.length}</span>
                <svg className="chev" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M9 6l6 6-6 6" /></svg>
              </button>
              {isOpen && <div className="catgrp-items">{tps.map((t) => <button key={t.id} className="catitem" onClick={() => { setTpl(t); setSubject(''); }}>
                <span className={'tdot ' + (t.type === 'incident' ? 'i' : 's')} /> {t.name}
                <span className="pill" style={{ marginLeft: 'auto' }}>{t.fields.length} campos</span>
              </button>)}</div>}
            </div>; })}
            {grpList.length === 0 && <div className="empty">Ninguna plantilla coincide con «{q}».</div>}
          </> : <div className="form">
            <button className="backbtn" onClick={() => setTpl(tenant.templates.length === 1 ? tpl : null)}>‹ {tplGroup(tpl)} · {tpl.name}</button>
            <label>Asunto<input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Resume la solicitud…" autoFocus /></label>
            <label>Descripción<textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} /></label>
            <label>Categoría<select value={category} onChange={(e) => setCategory(e.target.value)}>{tenant.categories.map((c) => <option key={c} value={c}>{c}</option>)}</select></label>
            <label>Prioridad<select value={priority} onChange={(e) => setPriority(e.target.value as 'high' | 'medium' | 'low')}><option value="high">Alta</option><option value="medium">Media</option><option value="low">Baja</option></select></label>
            {role !== 'requester' && <label>Solicitante<select value={requesterId} onChange={(e) => setRequesterId(e.target.value)}>{requesters.map((m) => <option key={m.uid} value={m.uid}>{m.name}</option>)}</select></label>}
            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              <button className="primary" onClick={submit} disabled={!subject.trim()}>Crear solicitud</button>
              <button className="ghost" onClick={onClose}>Cancelar</button>
            </div>
          </div>}
        </div>
      </aside>
    </div>
  );
}

function AdminNav() {
  const adminSec = useStore((s) => s.adminSec);
  const setAdminSec = useStore((s) => s.setAdminSec);
  const secs: [string, string][] = [['lifecycle', 'Ciclos de vida'], ['sla', 'SLA'], ['catalog', 'Catálogo'], ['members', 'Miembros']];
  return <>
    <div className="cap">Administración</div>
    {secs.map(([k, l]) => <button key={k} className={'qbtn' + (adminSec === k ? ' on' : '')} onClick={() => setAdminSec(k)}>{l}</button>)}
  </>;
}

function AdminArea({ tenant }: { tenant: TenantData }) {
  const adminSec = useStore((s) => s.adminSec);
  if (adminSec === 'sla') return <SlaAdmin tenant={tenant} />;
  if (adminSec === 'catalog') return <CatalogAdmin tenant={tenant} />;
  if (adminSec === 'members') return <MembersAdmin tenant={tenant} />;
  return <GraphEditor tenant={tenant} />;
}

function SlaAdmin({ tenant }: { tenant: TenantData }) {
  const addSla = useStore((s) => s.addSla);
  const updateSla = useStore((s) => s.updateSla);
  const removeSla = useStore((s) => s.removeSla);
  const addGroup = useStore((s) => s.addGroup);
  const removeGroup = useStore((s) => s.removeGroup);
  const [sn, setSn] = useState(''); const [sr, setSr] = useState(60); const [sx, setSx] = useState(480);
  const [gn, setGn] = useState('');
  return <div className="work">
    <div className="card"><h2>SLA <span className="badge">{tenant.slas.length}</span></h2>
      <div className="facts" style={{ gridTemplateColumns: '1fr 90px 90px auto', alignItems: 'center', rowGap: 8 }}>
        <div className="k">Nombre</div><div className="k">Resp. (min)</div><div className="k">Resol. (min)</div><div className="k" />
        {tenant.slas.map((s) => <Fragment key={s.id}>
          <input value={s.name} onChange={(e) => updateSla(s.id, { name: e.target.value })} style={{ fontSize: 13, fontWeight: 600 }} />
          <input type="number" min={0} value={s.responseMins} onChange={(e) => updateSla(s.id, { responseMins: +e.target.value })} className="mono" style={{ fontSize: 12, width: 84 }} title={fmtMins(s.responseMins)} />
          <input type="number" min={0} value={s.resolveMins} onChange={(e) => updateSla(s.id, { resolveMins: +e.target.value })} className="mono" style={{ fontSize: 12, width: 84 }} title={fmtMins(s.resolveMins)} />
          <button className="ghost" style={{ color: 'var(--crit)' }} onClick={() => removeSla(s.id)}>🗑</button>
        </Fragment>)}
      </div>
      <div className="designer">
        <input style={{ flex: 1, minWidth: 120 }} value={sn} onChange={(e) => setSn(e.target.value)} placeholder="Nuevo SLA…" />
        <input type="number" min={0} value={sr} onChange={(e) => setSr(+e.target.value)} style={{ width: 90 }} title="Respuesta (min)" />
        <input type="number" min={0} value={sx} onChange={(e) => setSx(+e.target.value)} style={{ width: 90 }} title="Resolución (min)" />
        <button className="primary" onClick={() => { if (sn.trim()) { addSla(sn.trim(), sr, sx); setSn(''); } }}>＋ SLA</button>
      </div>
      <div className="banner" style={{ marginTop: 12 }}>El SLA solo consume en estados <b>En curso</b>; se pausa en <b>Detener temporizador</b>. Verificado en el motor (sla.ts).</div>
    </div>
    <div className="card"><h2>Grupos de soporte <span className="badge">{tenant.groups.length}</span></h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 12 }}>
        {tenant.groups.map((g) => <div key={g.id} className="lcstate">
          <span style={{ flex: 1, fontSize: 13 }}>{g.name}</span>
          <button className="ghost" style={{ color: 'var(--crit)' }} onClick={() => removeGroup(g.id)}>🗑</button>
        </div>)}
      </div>
      <div className="designer">
        <input style={{ flex: 1, minWidth: 120 }} value={gn} onChange={(e) => setGn(e.target.value)} placeholder="Nuevo grupo…" />
        <button className="primary" onClick={() => { if (gn.trim()) { addGroup(gn.trim()); setGn(''); } }}>＋ Grupo</button>
      </div>
    </div>
  </div>;
}

function MembersAdmin({ tenant }: { tenant: TenantData }) {
  const addMember = useStore((s) => s.addMember);
  const updateMember = useStore((s) => s.updateMember);
  const removeMember = useStore((s) => s.removeMember);
  const [name, setName] = useState(''); const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('technician');
  const roleLabel: Record<Role, string> = { tenant_admin: 'Admin', technician: 'Técnico', requester: 'Solicitante' };
  const statusLabel: Record<string, string> = { active: 'Activo', invited: 'Invitado', disabled: 'Deshabilitado' };
  const corp = tenant.members[0]?.email.split('@')[1] ?? 'digloservicer.com';
  return <div className="card"><h2>Miembros <span className="badge">{tenant.members.length}</span></h2>
    <div className="banner" style={{ marginTop: 4 }}>Gestiona el acceso a esta instancia. El <b>onboarding real</b> (invitaciones por correo) se activará en producción; aquí defines rol, estado y quién es externo.</div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 12 }}>
      {tenant.members.map((m) => <div key={m.uid} className="lcstate">
        <span className="sdot" style={{ background: m.color }} />
        <span style={{ flex: 1, minWidth: 0 }}><b style={{ fontSize: 13 }}>{m.name}</b> <span style={{ color: 'var(--ink-soft)', fontSize: 12 }}>{m.email}</span>{m.external && <span className="pill" style={{ marginLeft: 6 }}>externo</span>}</span>
        <select value={m.role} onChange={(e) => updateMember(m.uid, { role: e.target.value as Role })} style={{ fontSize: 12 }}>
          {(['tenant_admin', 'technician', 'requester'] as Role[]).map((r) => <option key={r} value={r}>{roleLabel[r]}</option>)}
        </select>
        <select value={m.status} onChange={(e) => updateMember(m.uid, { status: e.target.value as UiMember['status'] })} style={{ fontSize: 12 }}>
          {['active', 'invited', 'disabled'].map((s) => <option key={s} value={s}>{statusLabel[s]}</option>)}
        </select>
        <button className="ghost" style={{ color: 'var(--crit)' }} onClick={() => removeMember(m.uid)}>🗑</button>
      </div>)}
    </div>
    <div className="designer">
      <input style={{ flex: 1, minWidth: 100 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="Nombre…" />
      <input style={{ flex: 1, minWidth: 120 }} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="correo@…" />
      <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
        {(['tenant_admin', 'technician', 'requester'] as Role[]).map((r) => <option key={r} value={r}>{roleLabel[r]}</option>)}
      </select>
      <button className="primary" onClick={() => { if (email.trim()) { const ext = !email.trim().toLowerCase().endsWith('@' + corp.toLowerCase()); addMember(name.trim(), email.trim(), role, ext); setName(''); setEmail(''); } }}>＋ Miembro</button>
    </div>
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
  const [openTpl, setOpenTpl] = useState<string | null>(null);
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
          {tenant.templates.map((tp) => <Fragment key={tp.id}>
            <div className="lcstate" style={{ cursor: 'pointer' }} onClick={() => setOpenTpl(openTpl === tp.id ? null : tp.id)}>
              <span className="sdot" style={{ background: tp.type === 'incident' ? 'var(--p-high)' : 'var(--p-med)' }} />
              <span style={{ flex: 1 }}><b style={{ fontSize: 13.5 }}>{tp.name}</b> <span className="pill">{tp.type === 'incident' ? 'Incidencia' : 'Solicitud'}</span>
                <span className="pill">{tenant.lifecycles.find((l) => l.id === tp.lifecycleId)?.name ?? 'sin flujo'}</span></span>
              <span className="pill">{tp.fields.length} campos</span>
              <span style={{ color: 'var(--ink-faint)', fontSize: 12 }}>{openTpl === tp.id ? '▾' : '▸'}</span>
            </div>
            {openTpl === tp.id && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '4px 0 10px 26px' }}>
              {tp.fields.length ? tp.fields.map((f, i) => <span key={i} className="pill">{f}</span>) : <span style={{ color: 'var(--ink-faint)', fontSize: 12 }}>Sin campos</span>}
            </div>}
          </Fragment>)}
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
