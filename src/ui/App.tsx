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
import type { SlaCategory, Stage, Template, FieldDef, FieldType } from '../model.js';
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
  const [view, setView] = useState<'home' | 'tickets' | 'assigned' | 'requests' | 'admin'>('home');
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
  const activeView: 'home' | 'tickets' | 'assigned' | 'requests' | 'admin' = isReq ? 'requests' : view;
  const openCount = tenant.tickets.length;
  const myAssignedCount = tenant.tickets.filter((t) => t.technicianId === effectiveUserId).length;
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
          <div className="side-top">
            <div className="cap">Menú</div>
            {!isReq && <button className={'modlink' + (activeView === 'home' ? ' on' : '')} onClick={() => setView('home')}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 10.5L12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /></svg>
              <span className="ml-l">Inicio</span></button>}
            {!isReq && <button className={'modlink' + (activeView === 'tickets' ? ' on' : '')} onClick={() => setView('tickets')}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M8 4v16" /></svg>
              <span className="ml-l">Solicitudes</span><span className="n">{openCount}</span></button>}
            {!isReq && <button className={'modlink' + (activeView === 'assigned' ? ' on' : '')} onClick={() => setView('assigned')}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 6L9 17l-5-5" /></svg>
              <span className="ml-l">Asignadas a mí</span><span className="n">{myAssignedCount}</span></button>}
            <button className={'modlink' + (activeView === 'requests' ? ' on' : '')} onClick={() => setView('requests')}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 4h16v16H4z" /><path d="M8 9h8M8 13h5" /></svg>
              <span className="ml-l">Mis solicitudes</span><span className="n">{myReqCount}</span></button>
          </div>
          <div className="side-bottom">
            {role === 'tenant_admin' && <button className={'modlink' + (activeView === 'admin' ? ' on' : '')} onClick={() => setView('admin')}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3" /><path d="M19 12a7 7 0 00-.1-1.1l2-1.5-2-3.4-2.3 1a7 7 0 00-1.9-1.1L14.3 2h-4l-.4 2.3a7 7 0 00-1.9 1.1l-2.3-1-2 3.4 2 1.5A7 7 0 005.6 12c0 .4 0 .7.1 1.1l-2 1.5 2 3.4 2.3-1c.6.5 1.2.8 1.9 1.1l.4 2.4h4l.4-2.4c.7-.3 1.3-.6 1.9-1.1l2.3 1 2-3.4-2-1.5c.1-.4.1-.7.1-1.1z" /></svg>
              <span className="ml-l">Administración</span></button>}
            <div className="foot">
              {myTenants.length > 1 ? 'Perteneces a varias instancias.' : `Instancia ${tenant.name}.`}
            </div>
          </div>
        </aside>

        <main className="main">
          {activeView === 'home' && !isReq && <Dashboard tenant={tenant} user={user} go={(v, f) => { if (f) setFilter(f); setView(v); }} />}
          {activeView === 'tickets' && !isReq && <Workspace tenant={tenant} role={role} user={user} filter={filter} setFilter={setFilter} scope="queue" />}
          {activeView === 'assigned' && !isReq && <Workspace tenant={tenant} role={role} user={user} filter={filter} setFilter={setFilter} scope="assigned" />}
          {activeView === 'requests' && <Workspace tenant={tenant} role={role} user={user} filter={filter} setFilter={setFilter} scope="requester" />}
          {activeView === 'admin' && role === 'tenant_admin' && <AdminConfig tenant={tenant} />}
        </main>
      </div>

      {showNew && <NewTicket tenant={tenant} role={role} user={user} onClose={() => setShowNew(false)} />}
    </div>
  );
}

// Panel de inicio: KPIs + widgets calculados a partir de los datos reales del tenant.
function Dashboard({ tenant, user, go }: { tenant: TenantData; user: ReturnType<typeof buildUser>; go: (v: 'tickets' | 'assigned', f?: 'all' | 'unassigned' | 'mine') => void }) {
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
      <button className="kpi" onClick={() => go('tickets', 'all')}><div className="kl">Abiertas</div><div className="kv">{tickets.length}</div><div className="kstrip" style={{ background: 'var(--accent)' }} /></button>
      <button className="kpi" onClick={() => go('tickets', 'unassigned')}><div className="kl">Sin asignar</div><div className="kv" style={{ color: 'var(--warn)' }}>{unassigned}</div><div className="kstrip" style={{ background: 'var(--warn)' }} /></button>
      <button className="kpi" onClick={() => go('tickets', 'all')}><div className="kl">Vencidas (SLA)</div><div className="kv" style={{ color: 'var(--crit)' }}>{overdue}</div><div className="kstrip" style={{ background: 'var(--crit)' }} /></button>
      <button className="kpi" onClick={() => go('assigned')}><div className="kl">Asignadas a mí</div><div className="kv">{mine}</div><div className="kstrip" style={{ background: 'var(--ok)' }} /></button>
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

function dueLabel(ms?: number | null): [string, string] {
  if (!ms) return ['—', ''];
  const diff = ms - Date.now();
  if (diff < 0) return ['vencido ' + fmtMins(Math.round(-diff / 60000)), 'crit'];
  return ['en ' + fmtMins(Math.round(diff / 60000)), diff < 2 * 3600000 ? 'warn' : ''];
}
const fmtDate = (ms: number) => new Date(ms).toLocaleString('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

function Workspace({ tenant, role, user, filter, setFilter, scope }:
  { tenant: TenantData; role: Role; user: ReturnType<typeof buildUser>; filter: 'all' | 'unassigned' | 'mine'; setFilter: (f: 'all' | 'unassigned' | 'mine') => void; scope: 'queue' | 'assigned' | 'requester' }) {
  const selectedId = useStore((s) => s.selectedTicketId);
  const select = useStore((s) => s.select);
  const [vw, setVw] = useState<'list' | 'kanban'>('list');
  const all = tenant.tickets;
  let list = all;
  if (scope === 'requester') list = all.filter((t) => t.requesterId === user.uid);
  else if (scope === 'assigned') list = all.filter((t) => t.technicianId === user.uid);
  else if (filter === 'unassigned') list = all.filter((t) => !t.technicianId);
  else if (filter === 'mine') list = all.filter((t) => t.technicianId === user.uid);
  const selected = tenant.tickets.find((t) => t.id === selectedId) ?? null;
  const counts = { all: all.length, unassigned: all.filter((t) => !t.technicianId).length, mine: all.filter((t) => t.technicianId === user.uid).length };
  const tabs: [typeof filter, string][] = [['all', 'Todas'], ['unassigned', 'Sin asignar'], ['mine', 'Mías']];
  const title = scope === 'requester' ? 'Mis solicitudes' : scope === 'assigned' ? 'Asignadas a mí' : 'Solicitudes';
  const canAct = scope !== 'requester' && role !== 'requester';
  const meName = tenant.members.find((m) => m.uid === user.uid)?.name ?? 'Yo';

  const stLabel = (t: StoredTicket) => { const lc = lifecycleOfTicket(tenant, t); const st = lc ? stateOf(lc, t.status) : undefined; return st?.label ?? t.status; };

  return <>
    <div className="hd">
      <h1>{title}</h1>
      <span className="sub">{tenant.name} · {list.length}{scope === 'queue' ? ` de ${all.length}` : ''}</span>
      <div style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <div className="seg">
          <button className={vw === 'list' ? 'on' : ''} onClick={() => setVw('list')}>Lista</button>
          <button className={vw === 'kanban' ? 'on' : ''} onClick={() => setVw('kanban')}>Kanban</button>
        </div>
        {scope === 'queue' && <div className="tabs" style={{ marginBottom: 0 }}>
          {tabs.map(([k, l]) => <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{l} <span className="tabn">{counts[k]}</span></button>)}
        </div>}
      </div>
    </div>

    {list.length === 0 ? <div className="card"><div className="empty">{scope === 'requester' ? 'No has creado ninguna solicitud todavía.' : scope === 'assigned' ? 'No tienes solicitudes asignadas.' : 'No hay solicitudes en esta vista.'}</div></div>
      : vw === 'list' ? <div className="listwrap tblwrap">
        <table className="mgmt">
          <thead><tr><th>ID</th><th>Asunto</th><th>Solicitante</th><th>Técnico</th><th>Grupo</th><th>Prioridad</th><th>Estado</th><th>Vence</th></tr></thead>
          <tbody>{list.map((t) => {
            const tech = tenant.members.find((m) => m.uid === t.technicianId);
            const req = tenant.members.find((m) => m.uid === t.requesterId);
            const [due, sev] = dueLabel(t.resolveDueAt);
            return <tr key={t.id} className={'mrow' + (t.id === selectedId ? ' sel' : '')} onClick={() => select(t.id)}>
              <td className="id">{t.id}</td>
              <td className="subj">{t.subject}</td>
              <td className="soft">{req?.name ?? '—'}</td>
              <td>{tech ? <span className="who"><Avatar m={tech} /> <span className="soft">{tech.name}</span></span> : <span className="soft">Sin asignar</span>}</td>
              <td className="soft">{tenant.groups.find((g) => g.id === t.groupId)?.name ?? '—'}</td>
              <td><span className={'chip p-' + t.priority}>{PRI[t.priority ?? 'low']}</span></td>
              <td><span className="soft">{stLabel(t)}</span></td>
              <td className={sev === 'crit' ? 'sev-crit' : sev === 'warn' ? 'sev-warn' : 'soft'} style={{ fontSize: 12, fontWeight: 600 }}>{due}</td>
            </tr>;
          })}</tbody>
        </table>
      </div>
      : <Kanban tenant={tenant} list={list} stLabel={stLabel} onSelect={(id) => select(id)} selectedId={selectedId} />}

    {selected && <div className="scrim" onClick={() => select(null)}>
      <aside className="drawer detail" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={'Solicitud ' + selected.id}>
        <div className="drawer-h"><h2>{selected.id} · {selected.type === 'incident' ? 'Incidencia' : 'Solicitud'}</h2><button className="dx" onClick={() => select(null)} aria-label="Cerrar">×</button></div>
        <div className="drawer-b"><TicketDetail tenant={tenant} t={selected} canAct={canAct} meName={meName} /></div>
      </aside>
    </div>}
  </>;
}

function Kanban({ tenant, list, stLabel, onSelect, selectedId }:
  { tenant: TenantData; list: StoredTicket[]; stLabel: (t: StoredTicket) => string; onSelect: (id: string) => void; selectedId: string | null }) {
  const cols = new Map<string, StoredTicket[]>();
  for (const t of list) { const l = stLabel(t); if (!cols.has(l)) cols.set(l, []); cols.get(l)!.push(t); }
  const ordered = [...cols.entries()].sort((a, b) => b[1].length - a[1].length);
  return <div className="kanban">{ordered.map(([label, items]) => <div key={label} className="kcol">
    <div className="kcol-h">{label} <span className="tabn">{items.length}</span></div>
    <div className="kcol-b">{items.map((t) => { const tech = tenant.members.find((m) => m.uid === t.technicianId); const [due, sev] = dueLabel(t.resolveDueAt); return <button key={t.id} className={'kcard' + (t.id === selectedId ? ' sel' : '')} onClick={() => onSelect(t.id)}>
      <div className="kcard-top"><span className="id">{t.id}</span><span className={'chip p-' + t.priority}>{PRI[t.priority ?? 'low']}</span></div>
      <div className="kcard-subj">{t.subject}</div>
      <div className="kcard-foot">{tech ? <Avatar m={tech} /> : <span className="av" style={{ background: 'var(--ink-faint)' }}>?</span>}<span className={sev === 'crit' ? 'sev-crit' : sev === 'warn' ? 'sev-warn' : 'soft'} style={{ fontSize: 11, marginLeft: 'auto', fontWeight: 600 }}>{due}</span></div>
    </button>; })}</div>
  </div>)}</div>;
}

function TicketDetail({ tenant, t, canAct, meName }: { tenant: TenantData; t: StoredTicket; canAct: boolean; meName: string }) {
  const transition = useStore((s) => s.transition);
  const assign = useStore((s) => s.assign);
  const addComment = useStore((s) => s.addComment);
  const setResolution = useStore((s) => s.setResolution);
  const addTask = useStore((s) => s.addTask);
  const toggleTask = useStore((s) => s.toggleTask);
  const moveTask = useStore((s) => s.moveTask);
  const [tab, setTab] = useState<'detalles' | 'resolucion' | 'historico' | 'tareas' | 'conversaciones'>('detalles');
  const [comment, setComment] = useState('');
  const [internal, setInternal] = useState(false);
  const [res, setRes] = useState(t.resolution ?? '');
  const [task, setTask] = useState('');

  const lc = lifecycleOfTicket(tenant, t);
  const st = lc ? stateOf(lc, t.status) : undefined;
  const cat = st ? CAT[st.category] : null;
  const sla = tenant.slas.find((s) => s.id === t.slaId);
  const ss = sla ? slaStatus(lc, t.statusHistory ?? [], sla.resolveMins, Date.now()) : null;
  const req = tenant.members.find((m) => m.uid === t.requesterId);
  const tech = tenant.members.find((m) => m.uid === t.technicianId);
  const nexts = canAct ? outgoing(lc, t.status) : [];
  const group = tenant.groups.find((g) => g.id === t.groupId);
  const allTechs = tenant.members.filter((m) => m.role === 'technician' || m.role === 'tenant_admin');
  const scoped = group ? allTechs.filter((m) => (m.groupIds ?? []).includes(group.id)) : [];
  const techs = (scoped.length ? scoped : allTechs)
    .sort((a, b) => (tenant.capacity[a.uid]?.off ? 1 : 0) - (tenant.capacity[b.uid]?.off ? 1 : 0)
      || ((tenant.capacity[a.uid]?.used ?? 0) / (tenant.capacity[a.uid]?.cap ?? 1)) - ((tenant.capacity[b.uid]?.used ?? 0) / (tenant.capacity[b.uid]?.cap ?? 1)));
  const pct = ss ? Math.min(100, Math.round((ss.consumedMins / ss.targetMins) * 100)) : 0;
  const paused = st?.category === 'stop_timer';
  const [due, dueSev] = dueLabel(t.resolveDueAt);
  const comments = t.comments ?? []; const tasks = t.tasks ?? [];
  const TABS: [typeof tab, string, number][] = [['detalles', 'Detalles', 0], ['resolucion', 'Resolución', 0], ['historico', 'Histórico', (t.statusHistory ?? []).length], ['tareas', 'Tareas', tasks.length], ['conversaciones', 'Conversaciones', comments.length]];

  return <div>
    <h3 style={{ fontSize: 16, marginBottom: 12 }}>{t.subject}</h3>
    <div className="tabs det-tabs">
      {TABS.map(([k, l, n]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}{n > 0 && <span className="tabn">{n}</span>}</button>)}
    </div>

    {tab === 'detalles' && <>
      <div className="facts">
        <div><div className="k">Prioridad</div><span className={'chip p-' + t.priority}>{PRI[t.priority ?? 'low']}</span></div>
        <div><div className="k">Estado</div>{cat ? <span className="cat" style={{ color: cat[1], background: cat[2] }}>{st?.label} · {cat[0]}</span> : <span className="soft">{t.status}</span>}</div>
        <div><div className="k">Solicitante</div><span style={{ fontSize: 13 }}>{req?.name ?? '—'}</span></div>
        <div><div className="k">Técnico</div><span style={{ fontSize: 13 }}>{tech?.name ?? 'Sin asignar'}</span></div>
        {group && <div><div className="k">Grupo</div><span style={{ fontSize: 13 }}>{group.name}</span></div>}
        {t.category && <div><div className="k">Categoría</div><span style={{ fontSize: 13 }}>{[t.category, t.subcategory, t.item].filter(Boolean).join(' › ')}</span></div>}
        <div><div className="k">Vencimiento</div><span className={dueSev === 'crit' ? 'sev-crit' : dueSev === 'warn' ? 'sev-warn' : ''} style={{ fontSize: 13, fontWeight: 600 }}>{due}</span></div>
      </div>
      {ss && <div style={{ marginTop: 12 }}>
        <div className="k">SLA de resolución {paused && '· ⏸ en pausa'}</div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: ss.breached ? 'var(--crit)' : 'var(--ink-soft)' }}>
          {fmtMins(ss.consumedMins)} de {fmtMins(ss.targetMins)} {ss.breached ? '· incumplido' : `· quedan ${fmtMins(Math.max(0, ss.remainingMins))}`}
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
    </>}

    {tab === 'resolucion' && <div style={{ marginTop: 4 }}>
      {canAct ? <>
        <div className="k">Resolución</div>
        <textarea value={res} onChange={(e) => setRes(e.target.value)} rows={7} style={{ width: '100%' }} placeholder="Describe la solución aplicada…" />
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button className="primary" onClick={() => setResolution(t.id, res)} disabled={res === (t.resolution ?? '')}>Guardar resolución</button>
        </div>
      </> : t.resolution ? <div className="desc" style={{ whiteSpace: 'pre-wrap' }}>{t.resolution}</div> : <div className="empty">Aún no hay resolución.</div>}
    </div>}

    {tab === 'historico' && <div className="timeline">
      {(t.statusHistory ?? []).length === 0 && <div className="empty">Sin historial de estados.</div>}
      {(t.statusHistory ?? []).map((h, i) => { const label = lc ? stateOf(lc, h.state)?.label ?? h.state : h.state; const durMin = Math.round(((h.to ?? Date.now()) - h.from) / 60000); return <div key={i} className="tl-item">
        <span className="tl-dot" /><div><div className="tl-state">{label}</div><div className="tl-meta">{fmtDate(h.from)} · {h.to ? fmtMins(durMin) : 'en curso'}</div></div>
      </div>; })}
    </div>}

    {tab === 'tareas' && <div style={{ marginTop: 4 }}>
      {tasks.length === 0 && <div className="empty">Sin tareas.</div>}
      {tasks.length > 1 && <div style={{ fontSize: 11, color: 'var(--ink-faint)', margin: '2px 0 6px' }}>Más reciente primero · reordena con ↑↓</div>}
      {tasks.map((k, i) => <div key={k.id} className="taskrow">
        <input type="checkbox" checked={k.done} disabled={!canAct} onChange={() => toggleTask(t.id, k.id)} />
        <span style={{ flex: 1, textDecoration: k.done ? 'line-through' : 'none', color: k.done ? 'var(--ink-faint)' : 'var(--ink)' }}>{k.text}</span>
        {canAct && <span className="taskmv"><button className="xbtn" disabled={i === 0} onClick={() => moveTask(t.id, k.id, -1)} aria-label="Subir">↑</button><button className="xbtn" disabled={i === tasks.length - 1} onClick={() => moveTask(t.id, k.id, 1)} aria-label="Bajar">↓</button></span>}
      </div>)}
      {canAct && <div className="designer" style={{ borderTop: 'none', paddingTop: 4 }}>
        <input style={{ flex: 1 }} value={task} onChange={(e) => setTask(e.target.value)} placeholder="Nueva tarea…" onKeyDown={(e) => { if (e.key === 'Enter' && task.trim()) { addTask(t.id, task); setTask(''); } }} />
        <button className="primary" onClick={() => { if (task.trim()) { addTask(t.id, task); setTask(''); } }}>Añadir</button>
      </div>}
    </div>}

    {tab === 'conversaciones' && <div style={{ marginTop: 4 }}>
      {comments.length === 0 && <div className="empty">Sin conversación todavía.</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>{comments.map((c, i) => <div key={i} className="comment">
        <div className="comment-h"><b>{c.authorName}</b>{c.internal && <span className="pill" style={{ marginLeft: 6 }}>nota interna</span>}<span className="comment-at">{fmtDate(c.at)}</span></div>
        <div className="comment-b" style={{ whiteSpace: 'pre-wrap' }}>{c.text}</div>
      </div>)}</div>
      <div style={{ marginTop: 12 }}>
        <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={3} style={{ width: '100%' }} placeholder={canAct ? 'Escribe una respuesta o nota…' : 'Escribe un comentario…'} />
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 8 }}>
          <button className="primary" onClick={() => { addComment(t.id, comment, meName, canAct && internal); setComment(''); }} disabled={!comment.trim()}>Comentar</button>
          {canAct && <label style={{ fontSize: 12, color: 'var(--ink-soft)', display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> Nota interna</label>}
        </div>
      </div>
    </div>}
  </div>;
}

const tplGroup = (t: Template) => t.group ?? (t.type === 'incident' ? 'Incidencias' : 'Solicitudes de servicio');

function NewTicket({ tenant, role, user, onClose }: { tenant: TenantData; role: Role; user: ReturnType<typeof buildUser>; onClose: () => void }) {
  const create = useStore((s) => s.createTicket);
  const [tpl, setTpl] = useState<Template | null>(tenant.templates.length === 1 ? tenant.templates[0]! : null);
  const [q, setQ] = useState('');
  const [subject, setSubject] = useState('');
  const tree = tenant.categoryTree ?? [];
  const [category, setCategory] = useState(tree[0]?.name ?? tenant.categories[0] ?? 'General');
  const [subcategory, setSubcategory] = useState('');
  const [item, setItem] = useState('');
  const catNode = tree.find((c) => c.name === category) ?? null;
  const subNode = catNode?.subs.find((s) => s.name === subcategory) ?? null;
  const [priority, setPriority] = useState<'high' | 'medium' | 'low'>('medium');
  const [description, setDescription] = useState('');
  const requesters = tenant.members.filter((m) => m.role === 'requester');
  const [requesterId, setRequesterId] = useState(role === 'requester' ? user.uid : requesters[0]?.uid ?? user.uid);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  // Perfilado de catálogo: el solicitante solo ve tipologías permitidas
  // (visibles para solicitante). Técnico/admin ven todas.
  const canSee = (t: Template) => role !== 'requester' || t.showToRequester !== false;
  const groups = new Map<string, Template[]>();
  for (const t of tenant.templates) {
    if (!canSee(t)) continue;
    if (q && !t.name.toLowerCase().includes(q.toLowerCase())) continue;
    const g = tplGroup(t); if (!groups.has(g)) groups.set(g, []); groups.get(g)!.push(t);
  }
  const grpList = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const submit = () => { if (!subject.trim() || !tpl) return; create({ subject, description, category, subcategory: subcategory || undefined, item: item || undefined, priority, requesterId, templateId: tpl.id }); onClose(); };

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
            <label>Categoría<select value={category} onChange={(e) => { setCategory(e.target.value); setSubcategory(''); setItem(''); }}>{(tree.length ? tree.map((c) => c.name) : tenant.categories).map((c) => <option key={c} value={c}>{c}</option>)}</select></label>
            {catNode && catNode.subs.length > 0 && <label>Subcategoría<select value={subcategory} onChange={(e) => { setSubcategory(e.target.value); setItem(''); }}><option value="">— Seleccionar —</option>{catNode.subs.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}</select></label>}
            {subNode && subNode.items.length > 0 && <label>Artículo<select value={item} onChange={(e) => setItem(e.target.value)}><option value="">— Seleccionar —</option>{subNode.items.map((it) => <option key={it} value={it}>{it}</option>)}</select></label>}
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

// Administración = landing de configuración por áreas (como SDP), no pestañas.
const ADMIN_AREAS: [string, string, [string, string | null][]][] = [
  ['Configuraciones de instancia', '🏢', [['Ajustes de instancia', null], ['Sitios', null], ['Horas operativas', null], ['Grupos de días festivos', null], ['Departamentos', null], ['Moneda', null]]],
  ['Usuarios y permisos', '👥', [['Roles', null], ['Usuarios', 'miembros'], ['Grupos de usuarios', null], ['Grupos de soporte', 'sla'], ['Acceso específico', null]]],
  ['Personalización', '🎨', [['Estado', null], ['Categoría › Subcategoría › Artículo', 'categoria'], ['Prioridad', null], ['Impacto', null], ['Urgencia', null], ['Campos adicionales', null]]],
  ['Plantillas y formularios', '📄', [['Plantillas y campos', 'plantillas'], ['Categoría de servicio', null], ['Reglas del formulario', null]]],
  ['Automatización', '⚙️', [['SLA y horarios', 'sla'], ['Ciclos de vida', 'ciclos'], ['Reglas de notificación', null], ['Asignación automática', null], ['Reglas de cierre', null], ['Flujos de trabajo', null]]],
  ['Configuración del correo', '✉️', [['Servidor de correo', null], ['Bandeja de correo', null], ['Plantillas de aviso', null]]],
];
const ADMIN_TITLE: Record<string, string> = { plantillas: 'Plantillas y formularios', categoria: 'Categoría › Subcategoría › Artículo', ciclos: 'Ciclos de vida', sla: 'SLA y grupos de soporte', miembros: 'Usuarios y miembros' };

// Editor de árbol Categoría › Subcategoría › Artículo (3 columnas, como SDP).
function CategoryAdmin({ tenant }: { tenant: TenantData }) {
  const setTree = useStore((s) => s.setCategoryTree);
  const tree = tenant.categoryTree ?? [];
  const [selCat, setSelCat] = useState<string | null>(tree[0]?.name ?? null);
  const [selSub, setSelSub] = useState<string | null>(null);
  const [nc, setNc] = useState(''); const [ns, setNs] = useState(''); const [ni, setNi] = useState('');
  const cat = tree.find((c) => c.name === selCat) ?? null;
  const sub = cat?.subs.find((s) => s.name === selSub) ?? null;

  const addCat = () => { const n = nc.trim(); if (!n || tree.some((c) => c.name === n)) return; setTree([...tree, { name: n, subs: [] }]); setNc(''); setSelCat(n); };
  const rmCat = (name: string) => { setTree(tree.filter((c) => c.name !== name)); if (selCat === name) { setSelCat(null); setSelSub(null); } };
  const addSub = () => { const n = ns.trim(); if (!cat || !n || cat.subs.some((s) => s.name === n)) return; setTree(tree.map((c) => (c.name === cat.name ? { ...c, subs: [...c.subs, { name: n, items: [] }] } : c))); setNs(''); setSelSub(n); };
  const rmSub = (name: string) => { if (!cat) return; setTree(tree.map((c) => (c.name === cat.name ? { ...c, subs: c.subs.filter((s) => s.name !== name) } : c))); if (selSub === name) setSelSub(null); };
  const addItem = () => { const n = ni.trim(); if (!cat || !sub || !n || sub.items.includes(n)) return; setTree(tree.map((c) => (c.name === cat.name ? { ...c, subs: c.subs.map((s) => (s.name === sub.name ? { ...s, items: [...s.items, n] } : s)) } : c))); setNi(''); };
  const rmItem = (name: string) => { if (!cat || !sub) return; setTree(tree.map((c) => (c.name === cat.name ? { ...c, subs: c.subs.map((s) => (s.name === sub.name ? { ...s, items: s.items.filter((i) => i !== name) } : s)) } : c))); };

  return <>
    <div className="banner" style={{ marginBottom: 14 }}>Jerarquía de 3 niveles como SDP: <b>Categoría › Subcategoría › Artículo</b>. Selecciona para desplegar y editar cada nivel.</div>
    <div className="tree">
      <div className="tcol">
        <div className="tcol-h">Categoría</div>
        {tree.map((c) => <div key={c.name} className={'titem' + (selCat === c.name ? ' on' : '')}>
          <button className="titem-b" onClick={() => { setSelCat(c.name); setSelSub(null); }}>{c.name}</button>
          <button className="xbtn" onClick={() => rmCat(c.name)} aria-label="Eliminar">✕</button><span className="chev">›</span></div>)}
        <div className="tadd"><input value={nc} onChange={(e) => setNc(e.target.value)} placeholder="Añadir categoría…" onKeyDown={(e) => e.key === 'Enter' && addCat()} /><button className="ghost" onClick={addCat}>＋</button></div>
      </div>
      <div className="tcol">
        <div className="tcol-h">Subcategoría</div>
        {!cat ? <div className="empty">Elige una categoría.</div> : <>
          {cat.subs.map((s) => <div key={s.name} className={'titem' + (selSub === s.name ? ' on' : '')}>
            <button className="titem-b" onClick={() => setSelSub(s.name)}>{s.name}</button>
            <button className="xbtn" onClick={() => rmSub(s.name)} aria-label="Eliminar">✕</button><span className="chev">›</span></div>)}
          <div className="tadd"><input value={ns} onChange={(e) => setNs(e.target.value)} placeholder="Añadir subcategoría…" onKeyDown={(e) => e.key === 'Enter' && addSub()} /><button className="ghost" onClick={addSub}>＋</button></div>
        </>}
      </div>
      <div className="tcol">
        <div className="tcol-h">Artículo</div>
        {!sub ? <div className="empty">Elige una subcategoría.</div> : <>
          {sub.items.map((it) => <div key={it} className="titem">
            <span className="titem-b" style={{ padding: '9px 13px' }}>{it}</span>
            <button className="xbtn" onClick={() => rmItem(it)} aria-label="Eliminar">✕</button></div>)}
          <div className="tadd"><input value={ni} onChange={(e) => setNi(e.target.value)} placeholder="Añadir artículo…" onKeyDown={(e) => e.key === 'Enter' && addItem()} /><button className="ghost" onClick={addItem}>＋</button></div>
        </>}
      </div>
    </div>
  </>;
}

function AdminConfig({ tenant }: { tenant: TenantData }) {
  const [sec, setSec] = useState<string | null>(null);
  if (!sec) return <div>
    <div className="hd"><h1>Administración · {tenant.name}</h1><span className="sub">Configura sin código, por áreas.</span></div>
    <div className="cfg-grid">
      {ADMIN_AREAS.map((a) => <div key={a[0]} className="cfg-cat">
        <h3><span className="cfg-ic">{a[1]}</span>{a[0]}</h3>
        <div className="cfg-links">{a[2].map(([l, k], i) => <Fragment key={l}>{i > 0 && <span className="sep">·</span>}<button className={k ? 'cfg-lk' : 'cfg-lk soon'} disabled={!k} onClick={() => k && setSec(k)}>{l}</button></Fragment>)}</div>
      </div>)}
    </div>
    <p className="cfg-note">Las opciones atenuadas llegan en el siguiente pase (Estado, jerarquía de Categorías, Reglas de notificación) — ya están en la maqueta.</p>
  </div>;
  return <div>
    <div className="crumb"><button className="crumb-b" onClick={() => setSec(null)}>‹ Configuración</button><span className="sep">·</span><b>{ADMIN_TITLE[sec] ?? sec}</b></div>
    {sec === 'plantillas' && <CatalogAdmin tenant={tenant} />}
    {sec === 'categoria' && <CategoryAdmin tenant={tenant} />}
    {sec === 'ciclos' && <GraphEditor tenant={tenant} />}
    {sec === 'sla' && <SlaAdmin tenant={tenant} />}
    {sec === 'miembros' && <MembersAdmin tenant={tenant} />}
  </div>;
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

const FIELD_TYPES: [FieldType, string][] = [['text', 'Texto'], ['textarea', 'Texto largo'], ['select', 'Desplegable'], ['bool', 'Sí/No'], ['date', 'Fecha'], ['number', 'Número'], ['person', 'Persona'], ['attachment', 'Adjunto'], ['reference', 'Referencia']];
const ftLabel = (t: FieldType) => FIELD_TYPES.find((x) => x[0] === t)?.[1] ?? t;
const defsOf = (tp: Template): FieldDef[] => tp.fieldDefs ?? tp.fields.map((label, i) => ({ id: 'f' + i, label, type: 'text' as FieldType, requesterVisible: true }));

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
  const [sel, setSel] = useState<string | null>(tenant.templates[0]?.id ?? null);
  const tpl = tenant.templates.find((t) => t.id === sel) ?? null;
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
    <div className="admin-cat">
      <div className="card tpl-listcard">
        <h2>Plantillas <span className="badge">{tenant.templates.length}</span></h2>
        <div className="tpl-list">
          {tenant.templates.map((tp) => <button key={tp.id} className={'tpl' + (sel === tp.id ? ' sel' : '')} onClick={() => setSel(tp.id)}>
            <span className={'tdot ' + (tp.type === 'incident' ? 'i' : 's')} />
            <span style={{ flex: 1, minWidth: 0 }}><span className="tpl-nm">{tp.name}</span><span className="tpl-mt">{tenant.lifecycles.find((l) => l.id === tp.lifecycleId)?.name ?? 'sin flujo'} · {defsOf(tp).length} campos</span></span>
            {tp.showToRequester === false && <span className="pill">staff</span>}
          </button>)}
        </div>
        <div className="designer">
          <input style={{ flex: 1, minWidth: 110 }} value={tname} onChange={(e) => setTname(e.target.value)} placeholder="Nueva plantilla…" />
          <select value={ttype} onChange={(e) => setTtype(e.target.value as 'incident' | 'service_request')}><option value="incident">Incidencia</option><option value="service_request">Solicitud</option></select>
          <button className="primary" onClick={() => { if (tname.trim()) { addTemplate(tname.trim(), ttype, tlc); setTname(''); } }}>＋</button>
        </div>
      </div>
      <div>{tpl ? <TemplateEditor tenant={tenant} tpl={tpl} onDeleted={() => setSel(tenant.templates.find((t) => t.id !== tpl.id)?.id ?? null)} /> : <div className="card"><div className="empty">Selecciona una plantilla para editarla.</div></div>}</div>
    </div>

    <div className="work" style={{ marginTop: 16 }}>
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
      <div className="card">
        <h2>Importar datos de SDP</h2>
        <div className="banner" style={{ marginTop: 10 }}>Pega el <code>imported-seed.json</code> del importador (API v3). Reemplaza categorías, plantillas, SLAs y grupos de <b>{tenant.name}</b>.</div>
        <textarea value={raw} onChange={(e) => setRaw(e.target.value)} rows={4} placeholder='{ "categories": [...], "templates": [...] }' style={{ width: '100%', fontFamily: 'var(--mono)', fontSize: 12 }} />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
          <button className="primary" onClick={doImport} disabled={!raw.trim()}>Importar</button>
          {msg && <span style={{ fontSize: 12.5, color: msg.startsWith('✓') ? 'var(--ok)' : 'var(--crit)' }}>{msg}</span>}
        </div>
      </div>
    </div>
  </div>;
}

function TemplateEditor({ tenant, tpl, onDeleted }: { tenant: TenantData; tpl: Template; onDeleted: () => void }) {
  const updateTemplate = useStore((s) => s.updateTemplate);
  const removeTemplate = useStore((s) => s.removeTemplate);
  const setTemplateFields = useStore((s) => s.setTemplateFields);
  const defs = defsOf(tpl);
  const commit = (next: FieldDef[]) => setTemplateFields(tpl.id, next);
  const [nf, setNf] = useState('');
  const [nft, setNft] = useState<FieldType>('text');
  const move = (i: number, d: number) => { const j = i + d; if (j < 0 || j >= defs.length) return; const next = defs.slice(); [next[i], next[j]] = [next[j]!, next[i]!]; commit(next); };
  const preview = defs.filter((f) => f.requesterVisible !== false);
  const pvInput = (f: FieldDef) => {
    if (f.type === 'textarea') return f.label.toLowerCase().startsWith('descrip')
      ? <div className="pv-rte"><div className="pv-bar"><b>B</b> <i>I</i> <u>U</u><span style={{ opacity: .5 }}> · PT Sans ▾ · 🔗 🖼</span></div><div className="pv-area" /></div>
      : <div className="pv-inp tall" />;
    if (f.type === 'bool') return <div className="pv-inp">◯ Sí&nbsp;&nbsp;&nbsp;◯ No</div>;
    if (f.type === 'select' || f.type === 'reference') return <div className="pv-inp">Seleccionar… <span className="chev">▾</span></div>;
    if (f.type === 'person') return <div className="pv-inp">Seleccionar persona… <span className="chev">▾</span></div>;
    if (f.type === 'attachment') return <div className="pv-inp">📎 Adjuntar archivo</div>;
    if (f.type === 'date') return <div className="pv-inp">dd/mm/aaaa</div>;
    if (f.type === 'number') return <div className="pv-inp mono">0</div>;
    return <div className="pv-inp" />;
  };

  return <div className="card">
    <div className="te-head">
      <input className="te-name" value={tpl.name} onChange={(e) => updateTemplate(tpl.id, { name: e.target.value })} />
      <button className="xbtn" style={{ marginLeft: 'auto' }} onClick={() => { if (confirm(`¿Eliminar la plantilla "${tpl.name}"?`)) { removeTemplate(tpl.id); onDeleted(); } }}>🗑 Eliminar</button>
    </div>
    <div className="te-meta">
      <label>Tipo<select value={tpl.type} onChange={(e) => updateTemplate(tpl.id, { type: e.target.value as 'incident' | 'service_request' })}><option value="incident">Incidencia</option><option value="service_request">Solicitud</option></select></label>
      <label>Flujo<select value={tpl.lifecycleId ?? ''} onChange={(e) => updateTemplate(tpl.id, { lifecycleId: e.target.value || null })}><option value="">— sin flujo —</option>{tenant.lifecycles.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
      <label>Categoría del catálogo<input value={tpl.group ?? ''} onChange={(e) => updateTemplate(tpl.id, { group: e.target.value })} placeholder="p. ej. Peticiones" /></label>
      <label className="te-vis"><span>Visible para solicitante</span><button className={'toggle' + (tpl.showToRequester !== false ? ' on' : '')} onClick={() => updateTemplate(tpl.id, { showToRequester: tpl.showToRequester === false })} aria-label="Visible para solicitante" /></label>
    </div>

    <div className="banner" style={{ marginTop: 4 }}>Constructor de formularios: arrastra/ordena, marca <b>obligatorio</b> y <b>quién lo ve</b>. La vista previa es lo que verá quien crea la solicitud.</div>
    <div className="fb">
      <div className="fb-list">
        {defs.map((f, i) => <div key={f.id} className="field">
          <span className="grip" aria-hidden>⣿</span>
          <div className="fmeta">
            <input className="fname" value={f.label} onChange={(e) => commit(defs.map((x) => (x.id === f.id ? { ...x, label: e.target.value } : x)))} />
            <select className="ftype" value={f.type} onChange={(e) => commit(defs.map((x) => (x.id === f.id ? { ...x, type: e.target.value as FieldType } : x)))}>{FIELD_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          </div>
          <label className="fctl">Oblig.<button className={'toggle' + (f.mandatory ? ' on' : '')} onClick={() => commit(defs.map((x) => (x.id === f.id ? { ...x, mandatory: !x.mandatory } : x)))} /></label>
          <label className="fctl">Solic.<button className={'toggle' + (f.requesterVisible !== false ? ' on' : '')} onClick={() => commit(defs.map((x) => (x.id === f.id ? { ...x, requesterVisible: x.requesterVisible === false } : x)))} /></label>
          <span className="fmove"><button className="xbtn" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Subir">↑</button><button className="xbtn" onClick={() => move(i, 1)} disabled={i === defs.length - 1} aria-label="Bajar">↓</button></span>
          <button className="xbtn" onClick={() => commit(defs.filter((x) => x.id !== f.id))} aria-label="Eliminar campo">✕</button>
        </div>)}
        {defs.length === 0 && <div className="empty">Sin campos. Añade el primero abajo.</div>}
        <div className="add-field">
          <input value={nf} onChange={(e) => setNf(e.target.value)} placeholder="Nombre del nuevo campo…" onKeyDown={(e) => { if (e.key === 'Enter' && nf.trim()) { commit([...defs, { id: 'f-' + Date.now(), label: nf.trim(), type: nft, requesterVisible: true }]); setNf(''); } }} />
          <select value={nft} onChange={(e) => setNft(e.target.value as FieldType)}>{FIELD_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          <button className="primary" onClick={() => { if (nf.trim()) { commit([...defs, { id: 'f-' + Date.now(), label: nf.trim(), type: nft, requesterVisible: true }]); setNf(''); } }}>＋ Campo</button>
        </div>
      </div>
      <div className="preview">
        <div className="pv-head">Vista previa · formulario del solicitante</div>
        <div className="pv-body">
          <div className="pv-sec-t">Detalles de la solicitud</div>
          {preview.length === 0 ? <div className="empty">Ningún campo visible para el solicitante.</div>
            : <div className="pv-grid">{preview.map((f) => <div key={f.id} className={'pv-field' + (f.type === 'textarea' ? ' full' : '')}><label>{f.label}{f.mandatory && <span className="pv-req"> *</span>}</label>{pvInput(f)}</div>)}</div>}
        </div>
      </div>
    </div>
  </div>;
}
