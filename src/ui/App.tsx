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
import { isClosingStatus, closureBlockers, CLOSURE_RULE_LABELS, type ClosureRules } from '../closure.js';
import { madridHolidayDates } from '../holidays.js';
import { RULE_FIELDS, RULE_OPS, RULE_ACTIONS, type BusinessRule, type RuleActionType } from '../rules.js';
import { FORM_OPS, FORM_ACTIONS, evaluateFormRules, type FormRule, type FormActionType, type FormScope, type FieldEffects } from '../formrules.js';
import type { SlaCategory, Stage, Template, FieldDef, FieldType, ReplyTemplate, NotifEvent, TaskTemplate, ApprovalLevelDef, ChecklistItemDef } from '../model.js';
import type { Webhook } from '../webhooks.js';
import { searchKb, type KbArticle } from '../kb.js';
import { visibleAnnouncements, type Announcement, type Audience } from '../announce.js';
import { auditLabel } from '../audit.js';
import { parseInbound } from '../inbound.js';
import { DEFAULT_CAPS, CAP_LIST, type TenantData, type StoredTicket, type UiMember, type Capacity, type Picklists, type PickVal, type RoleDef, type RoleBase, type Cap } from '../data/seed.js';

const CAT: Record<SlaCategory, [string, string, string]> = {
  in_progress: ['En curso', 'var(--ok)', 'var(--ok-bg)'],
  stop_timer: ['Detener temporizador', 'var(--warn)', 'var(--warn-bg)'],
  completed: ['Completado', 'var(--st-closed)', 'var(--sink)'],
};

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
// Renderiza el icono de una categoría de servicio: imagen (SVG inline o data URL)
// si existe, si no el emoji. Para el modo simplificado con iconos de marca.
function catIconEl(c: { icon?: string; iconImage?: string } | undefined, size = 18): import('react').ReactNode {
  if (!c) return null;
  const img = c.iconImage?.trim();
  if (img) {
    if (img.startsWith('<svg')) return <span className="cicon" style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html: img }} />;
    return <img className="cicon" src={img} alt="" style={{ width: size, height: size, objectFit: 'contain' }} />;
  }
  return c.icon ? <span style={{ fontSize: size - 2 }}>{c.icon}</span> : null;
}
// Sanea HTML del editor enriquecido para mostrarlo sin riesgo (allowlist de etiquetas,
// sin scripts ni atributos on*/style peligrosos). Las imágenes de servlet de SDP se marcan.
function sanitizeHtml(html: string): string {
  if (!html || !/[<&]/.test(html)) return (html ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>');
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const ALLOW = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'BR', 'P', 'DIV', 'UL', 'OL', 'LI', 'A', 'SPAN', 'H3', 'H4', 'BLOCKQUOTE']);
    // 1) elementos peligrosos fuera (imágenes de SDP → nota).
    doc.body.querySelectorAll('img').forEach((im) => im.replaceWith(doc.createTextNode('🖼 [imagen adjunta en SDP]')));
    doc.body.querySelectorAll('script,style,iframe,object,embed,link,meta').forEach((e) => e.remove());
    // 2) limpiar atributos (solo href seguro en enlaces).
    doc.body.querySelectorAll('*').forEach((el) => {
      [...el.attributes].forEach((a) => {
        const n = a.name.toLowerCase();
        if (el.tagName === 'A' && n === 'href' && /^(https?:|mailto:)/i.test(a.value)) return;
        el.removeAttribute(a.name);
      });
      if (el.tagName === 'A') { el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener noreferrer'); }
    });
    // 3) desenvolver etiquetas no permitidas, de la más profunda a la menos (evita
    //    desanclar padres antes que hijos).
    Array.from(doc.body.querySelectorAll('*')).reverse().forEach((el) => {
      if (!ALLOW.has(el.tagName) && el.parentNode) el.replaceWith(...Array.from(el.childNodes));
    });
    return doc.body.innerHTML;
  } catch { return richToText(html).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>'); }
}
// Editor de texto enriquecido mínimo (negrita/cursiva/subrayado/listas/enlace),
// como la barra del formulario de SDP. Devuelve HTML; se muestra saneado.
function RichText({ value, onChange, placeholder, disabled }: { value: string; onChange: (html: string) => void; placeholder?: string; disabled?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (ref.current && ref.current.innerHTML !== (value || '')) ref.current.innerHTML = value || ''; /* init una vez */ }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const exec = (c: string, val?: string) => { ref.current?.focus(); document.execCommand(c, false, val); onChange(ref.current?.innerHTML ?? ''); };
  const btns: [string, string][] = [['bold', 'B'], ['italic', 'I'], ['underline', 'U'], ['insertUnorderedList', '☰'], ['insertOrderedList', '№']];
  return <div className={'rte' + (disabled ? ' dis' : '')}>
    <div className="rte-tb">
      {btns.map(([c, l]) => <button key={c} type="button" tabIndex={-1} onMouseDown={(e) => { e.preventDefault(); exec(c); }} title={c}>{l}</button>)}
      <button type="button" tabIndex={-1} onMouseDown={(e) => { e.preventDefault(); const u = prompt('URL del enlace:'); if (u) exec('createLink', u); }} title="Enlace">🔗</button>
    </div>
    <div ref={ref} className="rte-body" contentEditable={!disabled} suppressContentEditableWarning role="textbox" aria-multiline data-ph={placeholder ?? ''} onInput={() => onChange(ref.current?.innerHTML ?? '')} />
  </div>;
}
const initials = (n: string) => n.replace(/\(.*?\)/g, '').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
const fmtMins = (m: number) => (m >= 1440 ? Math.round(m / 1440) + 'd' : m >= 60 ? Math.round(m / 60) + 'h' : m + 'm');
/** Duración exacta para el registro de tiempo: 90→"1h 30m", 45→"45m", 120→"2h". */
const fmtDur = (m: number) => { const h = Math.floor(m / 60), mm = m % 60; return h && mm ? `${h}h ${mm}m` : h ? `${h}h` : `${mm}m`; };
const fmtSize = (b: number) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : b >= 1024 ? Math.round(b / 1024) + ' KB' : b + ' B');
function capState(c: Capacity): [string, string] {
  if (c.off) return ['off', 'De vacaciones'];
  const p = c.cap ? Math.round((c.used / c.cap) * 100) : 0;
  return p > 100 ? ['over', 'Sobrecargado'] : p >= 85 ? ['tight', 'Al límite'] : ['free', 'Con hueco'];
}
function capColor(c: Capacity) { const [s] = capState(c); return s === 'over' ? 'var(--crit)' : s === 'tight' ? 'var(--warn)' : s === 'off' ? 'var(--ink-faint)' : 'var(--ok)'; }
const Avatar = ({ m }: { m: UiMember }) => <span className="av" style={{ background: m.color }}>{initials(m.name)}</span>;

/** Resuelve el estado visible de un ticket: prioriza el catálogo de estados del
 *  tenant (nombre real · temporizador · color); si no, cae al estado del ciclo. */
function statusView(tenant: TenantData, t: StoredTicket): { label: string; timer?: SlaCategory; color: string } {
  const cs = (tenant.statuses ?? []).find((x) => x.name === t.status);
  if (cs) return { label: cs.name, timer: cs.timer, color: cs.color };
  const lc = lifecycleOfTicket(tenant, t);
  const st = lc ? stateOf(lc, t.status) : undefined;
  if (st) return { label: st.label, timer: st.category, color: CAT[st.category][1] };
  return { label: t.status, color: 'var(--ink-faint)' };
}
/** Resolutor de temporizador por catálogo para el motor de SLA. */
const timerOfTenant = (tenant: TenantData) => (name: string) => (tenant.statuses ?? []).find((x) => x.name === name)?.timer;
/** Calendario laboral del tenant para el SLA por horario (o undefined = 24×7). */
const calOf = (tenant: TenantData) => tenant.businessHours ? { ...tenant.businessHours, holidays: tenant.holidays ?? [] } : undefined;
/** Capacidades (permisos de app) del usuario: del rol granular si lo tiene, si no
 *  las por defecto de su nivel base. El superadmin tiene todas. */
function capsOf(tenant: TenantData, uid: string, platformAdmin: boolean): Cap[] {
  if (platformAdmin) return DEFAULT_CAPS.tenant_admin;
  const m = tenant.members.find((x) => x.uid === uid);
  if (!m) return [];
  const rd = m.roleName ? (tenant.roles ?? []).find((r) => r.name === m.roleName) : undefined;
  return rd?.caps ?? DEFAULT_CAPS[rd?.base ?? m.role];
}

// Prioridad desde el catálogo (con color). Fallback a valores legacy high/med/low.
const LEGACY_PRI: Record<string, string> = { high: 'Alta', medium: 'Media', low: 'Baja' };
function priorityView(tenant: TenantData, name?: string): { label: string; color: string } {
  const n = name ? (LEGACY_PRI[name] ?? name) : '';
  const p = (tenant.picklists?.priority ?? []).find((x) => x.name === n);
  if (p) return { label: p.name, color: p.color ?? 'var(--ink-soft)' };
  return { label: n || '—', color: 'var(--ink-soft)' };
}
const badge = (label: string, color: string) => <span className="stbadge" style={{ color, background: `color-mix(in srgb, ${color} 15%, transparent)` }}>{label}</span>;
/** Multiselección compacta: chips conmutables. */
function ChipMulti({ options, selected, onChange }: { options: string[]; selected: string[]; onChange: (next: string[]) => void }) {
  if (options.length === 0) return <span className="empty" style={{ padding: 4 }}>Sin grupos definidos.</span>;
  const toggle = (o: string) => onChange(selected.includes(o) ? selected.filter((x) => x !== o) : [...selected, o]);
  return <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
    {options.map((o) => <button key={o} type="button" className={'chipsel' + (selected.includes(o) ? ' on' : '')} onClick={() => toggle(o)}>{o}</button>)}
  </div>;
}

// Buscador global de la barra superior: encuentra tickets por id/asunto/solicitante/
// técnico y los abre. Reemplaza al input decorativo de la maqueta.
function GlobalSearch({ tenant, onOpen }: { tenant: TenantData; onOpen: (id: string) => void }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const ql = q.trim().toLowerCase();
  const nameOf = (uid?: string | null) => tenant.members.find((m) => m.uid === uid)?.name ?? '';
  const results = ql ? tenant.tickets.filter((t) => `${t.id} ${t.subject} ${nameOf(t.requesterId)} ${nameOf(t.technicianId)}`.toLowerCase().includes(ql)).slice(0, 8) : [];
  return <div className="gsearch">
    <label className="searchbox">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" /></svg>
      <input value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} placeholder="Buscar solicitudes, personas…" aria-label="Buscar" />
    </label>
    {open && ql && <div className="gsearch-dd">
      {results.length === 0 ? <div className="gsearch-empty">Sin resultados para «{q}».</div>
        : results.map((t) => <button key={t.id} className="gsearch-item" onMouseDown={() => { onOpen(t.id); setQ(''); setOpen(false); }}>
          <span className="mono gs-id">{t.id}</span><span className="gs-subj">{t.subject}</span><span className="gs-req">{nameOf(t.requesterId) || '—'}</span>
        </button>)}
    </div>}
  </div>;
}

export function App() {
  const db = useStore((s) => s.db);
  const currentUserId = useStore((s) => s.currentUserId);
  const activeTenantId = useStore((s) => s.activeTenantId);
  const setUser = useStore((s) => s.setUser);
  const select = useStore((s) => s.select);
  const setTenant = useStore((s) => s.setTenant);
  const cloudReady = useStore((s) => s.cloudReady);
  const hasAccess = useStore((s) => s.hasAccess);
  const startCloud = useStore((s) => s.startCloud);
  const authUser = useAuth((s) => s.user);
  const authReady = useAuth((s) => s.ready);
  useEffect(() => { void useAuth.getState().init(); }, []);
  useEffect(() => { if (firebaseEnabled && authUser) void startCloud(authUser.uid); }, [authUser?.uid, startCloud]);
  const [, setTheme] = useState<'light' | 'dark' | null>(null);
  const [view, setView] = useState<'home' | 'tickets' | 'assigned' | 'requests' | 'kb' | 'admin'>('home');
  const [dismissedAnn, setDismissedAnn] = useState<string[]>([]);
  const [filter, setFilter] = useState<'all' | 'unassigned' | 'mine'>('all');
  const [showNew, setShowNew] = useState(false);

  // Identidad: en la nube = uid del usuario autenticado (los docs de miembro van
  // keyados por ese uid); en local = selector de personas (demo).
  const realUserId = firebaseEnabled ? (authUser?.uid ?? '') : currentUserId;
  // Un admin puede "representar" a otro usuario: ve el portal como ese usuario en
  // modo SOLO LECTURA (readOnly desactiva toda acción).
  const impersonateUid = useStore((s) => s.impersonateUid);
  const setImpersonate = useStore((s) => s.setImpersonate);
  const readOnly = !!impersonateUid;
  const effectiveUserId = impersonateUid ?? realUserId;
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
  const caps = capsOf(tenant, effectiveUserId, !!user.platformAdmin);
  const canManageConfig = caps.includes('manageConfig');
  const activeView: 'home' | 'tickets' | 'assigned' | 'requests' | 'kb' | 'admin' = isReq && view !== 'kb' ? 'requests' : view;
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
        <GlobalSearch tenant={tenant} onOpen={(id) => { select(id); setView(isReq ? 'requests' : 'tickets'); }} />
        <div className="spring" />
        <button className="newtop" onClick={() => setShowNew(true)} title={readOnly ? 'Ver el catálogo que ve este usuario (solo lectura)' : ''}>＋ Nueva solicitud</button>
        <Bell tenant={tenant} meUid={effectiveUserId} />
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

      {readOnly && <div className="imp-banner">
        <span>👁 Estás viendo el portal <b>como {displayMember?.name ?? effectiveUserId}</b> ({role === 'requester' ? 'Solicitante' : role === 'technician' ? 'Técnico' : 'Admin'}) · solo lectura</span>
        <button className="ghost" onClick={() => { setImpersonate(null); setView('home'); }}>Salir de la representación</button>
      </div>}

      <div className="shell">
        <aside className="side">
          <div className="side-top">
            <div className="cap">Menú</div>
            {!isReq && <button title="Inicio" className={'modlink' + (activeView === 'home' ? ' on' : '')} onClick={() => setView('home')}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 10.5L12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /></svg>
              <span className="ml-l">Inicio</span></button>}
            {!isReq && caps.includes('viewAllTickets') && <button title="Solicitudes" className={'modlink' + (activeView === 'tickets' ? ' on' : '')} onClick={() => setView('tickets')}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M8 4v16" /></svg>
              <span className="ml-l">Solicitudes</span><span className="n">{openCount}</span></button>}
            {!isReq && <button title="Asignadas a mí" className={'modlink' + (activeView === 'assigned' ? ' on' : '')} onClick={() => setView('assigned')}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 6L9 17l-5-5" /></svg>
              <span className="ml-l">Asignadas a mí</span><span className="n">{myAssignedCount}</span></button>}
            <button title="Mis solicitudes" className={'modlink' + (activeView === 'requests' ? ' on' : '')} onClick={() => setView('requests')}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 4h16v16H4z" /><path d="M8 9h8M8 13h5" /></svg>
              <span className="ml-l">Mis solicitudes</span><span className="n">{myReqCount}</span></button>
            <button title="Base de conocimiento" className={'modlink' + (activeView === 'kb' ? ' on' : '')} onClick={() => setView('kb')}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 5a2 2 0 012-2h12v18H6a2 2 0 01-2-2z" /><path d="M8 7h8M8 11h6" /></svg>
              <span className="ml-l">Base de conocimiento</span></button>
          </div>
          <div className="side-bottom">
            {canManageConfig && <button title="Administración" className={'modlink' + (activeView === 'admin' ? ' on' : '')} onClick={() => setView('admin')}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3" /><path d="M19 12a7 7 0 00-.1-1.1l2-1.5-2-3.4-2.3 1a7 7 0 00-1.9-1.1L14.3 2h-4l-.4 2.3a7 7 0 00-1.9 1.1l-2.3-1-2 3.4 2 1.5A7 7 0 005.6 12c0 .4 0 .7.1 1.1l-2 1.5 2 3.4 2.3-1c.6.5 1.2.8 1.9 1.1l.4 2.4h4l.4-2.4c.7-.3 1.3-.6 1.9-1.1l2.3 1 2-3.4-2-1.5c.1-.4.1-.7.1-1.1z" /></svg>
              <span className="ml-l">Administración</span></button>}
          </div>
        </aside>

        <main className="main">
          {visibleAnnouncements(tenant.announcements, !isReq).filter((a) => !dismissedAnn.includes(a.id)).map((a) => <div key={a.id} className="announce">
            <span className="ann-ic">📣</span>
            <div style={{ flex: 1 }}><b>{a.title}</b><div className="ann-b">{a.body}</div></div>
            <button className="xbtn" onClick={() => setDismissedAnn([...dismissedAnn, a.id])} aria-label="Descartar">✕</button>
          </div>)}
          {activeView === 'home' && !isReq && (caps.includes('viewReports')
            ? <Dashboard tenant={tenant} user={user} go={(v, f) => { if (f) setFilter(f); setView(v); }} />
            : <Workspace tenant={tenant} role={role} user={user} filter={filter} setFilter={setFilter} scope="assigned" caps={caps} readOnly={readOnly} />)}
          {activeView === 'tickets' && !isReq && <Workspace tenant={tenant} role={role} user={user} filter={filter} setFilter={setFilter} scope="queue" caps={caps} readOnly={readOnly} />}
          {activeView === 'assigned' && !isReq && <Workspace tenant={tenant} role={role} user={user} filter={filter} setFilter={setFilter} scope="assigned" caps={caps} readOnly={readOnly} />}
          {activeView === 'requests' && <Workspace tenant={tenant} role={role} user={user} filter={filter} setFilter={setFilter} scope="requester" caps={caps} readOnly={readOnly} />}
          {activeView === 'kb' && <KbModule tenant={tenant} canManage={role !== 'requester' && !readOnly} meName={tenant.members.find((m) => m.uid === currentUserId)?.name ?? 'Yo'} />}
          {activeView === 'admin' && canManageConfig && <AdminConfig tenant={tenant} />}
        </main>
      </div>

      {showNew && (tenant.operationMode === 'simplified'
        ? <NewTicketSimplified tenant={tenant} role={role} user={user} readOnly={readOnly} onClose={() => setShowNew(false)} />
        : <NewTicket tenant={tenant} role={role} user={user} readOnly={readOnly} onClose={() => setShowNew(false)} />)}
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

  const stateLabel = (t: StoredTicket) => statusView(tenant, t).label;
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

function Workspace({ tenant, role, user, filter, setFilter, scope, caps, readOnly }:
  { tenant: TenantData; role: Role; user: ReturnType<typeof buildUser>; filter: 'all' | 'unassigned' | 'mine'; setFilter: (f: 'all' | 'unassigned' | 'mine') => void; scope: 'queue' | 'assigned' | 'requester'; caps: string[]; readOnly: boolean }) {
  const selectedId = useStore((s) => s.selectedTicketId);
  const select = useStore((s) => s.select);
  const [vw, setVw] = useState<'list' | 'kanban'>('list');
  const [q, setQ] = useState('');
  const all = tenant.tickets;
  let list = all;
  if (scope === 'requester') list = all.filter((t) => t.requesterId === user.uid);
  else if (scope === 'assigned') list = all.filter((t) => t.technicianId === user.uid);
  else if (filter === 'unassigned') list = all.filter((t) => !t.technicianId);
  else if (filter === 'mine') list = all.filter((t) => t.technicianId === user.uid);
  // buscador por id / asunto / solicitante / técnico
  const ql = q.trim().toLowerCase();
  if (ql) list = list.filter((t) => {
    const req = tenant.members.find((m) => m.uid === t.requesterId)?.name ?? '';
    const tech = tenant.members.find((m) => m.uid === t.technicianId)?.name ?? '';
    return `${t.id} ${t.subject} ${req} ${tech}`.toLowerCase().includes(ql);
  });
  // orden por defecto: descendente por id (= orden de creación, más reciente primero)
  const idNum = (id: string) => parseInt(id.replace(/\D/g, ''), 10) || 0;
  list = [...list].sort((a, b) => idNum(b.id) - idNum(a.id));
  const selected = tenant.tickets.find((t) => t.id === selectedId) ?? null;
  const counts = { all: all.length, unassigned: all.filter((t) => !t.technicianId).length, mine: all.filter((t) => t.technicianId === user.uid).length };
  const tabs: [typeof filter, string][] = [['all', 'Todas'], ['unassigned', 'Sin asignar'], ['mine', 'Mías']];
  const title = scope === 'requester' ? 'Mis solicitudes' : scope === 'assigned' ? 'Asignadas a mí' : 'Solicitudes';
  const canAct = scope !== 'requester' && role !== 'requester' && !readOnly;
  const meName = tenant.members.find((m) => m.uid === user.uid)?.name ?? 'Yo';

  const stLabel = (t: StoredTicket) => statusView(tenant, t).label;

  return <>
    <div className="hd">
      <h1>{title}</h1>
      <span className="sub">{tenant.name} · {list.length}{scope === 'queue' ? ` de ${all.length}` : ''}</span>
      <div style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <label className="searchbox"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" /></svg><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar por solicitante, asunto, id…" /></label>
        <div className="seg">
          <button className={vw === 'list' ? 'on' : ''} onClick={() => setVw('list')}>Lista</button>
          <button className={vw === 'kanban' ? 'on' : ''} onClick={() => setVw('kanban')}>Kanban</button>
        </div>
        {scope === 'queue' && <div className="tabs" style={{ marginBottom: 0 }}>
          {tabs.map(([k, l]) => <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{l} <span className="tabn">{counts[k]}</span></button>)}
        </div>}
      </div>
    </div>

    {vw === 'list'
      ? <div className="listwrap tblwrap">
        {list.length === 0 ? <div className="empty" style={{ padding: 30 }}>{scope === 'requester' ? 'No has creado ninguna solicitud todavía.' : scope === 'assigned' ? 'No tienes solicitudes asignadas.' : 'No hay solicitudes en esta vista.'}</div>
          : <table className="mgmt">
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
                <td>{badge(priorityView(tenant, t.priority).label, priorityView(tenant, t.priority).color)}</td>
                <td>{(() => { const sv = statusView(tenant, t); return <span className="stbadge" style={{ color: sv.color, background: `color-mix(in srgb, ${sv.color} 14%, transparent)` }}>{sv.label}</span>; })()}</td>
                <td className={sev === 'crit' ? 'sev-crit' : sev === 'warn' ? 'sev-warn' : 'soft'} style={{ fontSize: 12, fontWeight: 600 }}>{due}</td>
              </tr>;
            })}</tbody>
          </table>}
      </div>
      : (list.length === 0 ? <div className="card"><div className="empty">No hay solicitudes en esta vista.</div></div>
        : <Kanban tenant={tenant} list={list} stLabel={stLabel} onSelect={(id) => select(id)} selectedId={selectedId} />)}

    {/* Detalle en MODAL amplio centrado (sustituye al drawer/panel estrecho). */}
    {selected && <div className="scrim tmodal-scrim" onClick={() => select(null)}>
      <div className="tmodal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={'Solicitud ' + selected.id}>
        <div className="tmodal-h">
          <span className={'tchip-type ' + (selected.type === 'incident' ? 'inc' : 'pet')}>{selected.type === 'incident' ? '🛠️ Incidencia' : '📥 Petición'}</span>
          <b className="tmodal-title"><span className="id">{selected.id}</span> · {selected.subject}</b>
          <button className="dx" onClick={() => select(null)} aria-label="Cerrar">×</button>
        </div>
        <div className="tmodal-b"><TicketDetail tenant={tenant} t={selected} canAct={canAct} caps={caps} readOnly={readOnly} meName={meName} meUid={user.uid} /></div>
      </div>
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
      <div className="kcard-top"><span className="id">{t.id}</span>{badge(priorityView(tenant, t.priority).label, priorityView(tenant, t.priority).color)}</div>
      <div className="kcard-subj">{t.subject}</div>
      <div className="kcard-foot">{tech ? <Avatar m={tech} /> : <span className="av" style={{ background: 'var(--ink-faint)' }}>?</span>}<span className={sev === 'crit' ? 'sev-crit' : sev === 'warn' ? 'sev-warn' : 'soft'} style={{ fontSize: 11, marginLeft: 'auto', fontWeight: 600 }}>{due}</span></div>
    </button>; })}</div>
  </div>)}</div>;
}

function TicketDetail({ tenant, t, canAct, caps, readOnly, meName, meUid }: { tenant: TenantData; t: StoredTicket; canAct: boolean; caps: string[]; readOnly: boolean; meName: string; meUid: string }) {
  const canAssign = canAct && caps.includes('assign');
  const canChangeStatus = canAct && caps.includes('changeStatus');
  const canClose = caps.includes('close');
  const transition = useStore((s) => s.transition);
  const assign = useStore((s) => s.assign);
  const addComment = useStore((s) => s.addComment);
  const setResolution = useStore((s) => s.setResolution);
  const addTask = useStore((s) => s.addTask);
  const toggleTask = useStore((s) => s.toggleTask);
  const toggleChecklistItem = useStore((s) => s.toggleChecklistItem);
  const moveTask = useStore((s) => s.moveTask);
  const updateTask = useStore((s) => s.updateTask);
  const addWorklog = useStore((s) => s.addWorklog);
  const requestApproval = useStore((s) => s.requestApproval);
  const decideApproval = useStore((s) => s.decideApproval);
  const autoAssign = useStore((s) => s.autoAssign);
  const submitSurvey = useStore((s) => s.submitSurvey);
  const [surveyRating, setSurveyRating] = useState(0);
  const [surveyComment, setSurveyComment] = useState('');
  const uploadAttachment = useStore((s) => s.uploadAttachment);
  const removeAttachment = useStore((s) => s.removeAttachment);
  const setStatus = useStore((s) => s.setStatus);
  const [tab, setTab] = useState<'detalles' | 'resolucion' | 'historico' | 'tareas' | 'tiempo' | 'aprobaciones' | 'adjuntos' | 'conversaciones'>('detalles');
  const [comment, setComment] = useState('');
  const [internal, setInternal] = useState(false);
  const [res, setRes] = useState(t.resolution ?? '');
  const [task, setTask] = useState('');
  const [taskAssignee, setTaskAssignee] = useState('');
  const [taskDue, setTaskDue] = useState('');
  const [taskType, setTaskType] = useState('');
  const [wlMins, setWlMins] = useState(30);
  const [wlNote, setWlNote] = useState('');
  const [apprSel, setApprSel] = useState<string[]>([]);
  const [apprNote, setApprNote] = useState('');
  const [apprComment, setApprComment] = useState<Record<string, string>>({});
  const [uploading, setUploading] = useState(false);
  const [closeErr, setCloseErr] = useState('');

  const lc = lifecycleOfTicket(tenant, t);
  const sv = statusView(tenant, t);
  const sla = tenant.slas.find((s) => s.id === t.slaId);
  const ss = sla ? slaStatus(lc, t.statusHistory ?? [], sla.resolveMins, Date.now(), timerOfTenant(tenant), calOf(tenant)) : null;
  const req = tenant.members.find((m) => m.uid === t.requesterId);
  const tech = tenant.members.find((m) => m.uid === t.technicianId);
  const nexts = canAct ? outgoing(lc, t.status) : [];
  const statuses = tenant.statuses ?? [];
  const group = tenant.groups.find((g) => g.id === t.groupId);
  const allTechs = tenant.members.filter((m) => m.role === 'technician' || m.role === 'tenant_admin');
  const scoped = group ? allTechs.filter((m) => (m.groupIds ?? []).includes(group.id)) : [];
  const techs = (scoped.length ? scoped : allTechs)
    .sort((a, b) => (tenant.capacity[a.uid]?.off ? 1 : 0) - (tenant.capacity[b.uid]?.off ? 1 : 0)
      || ((tenant.capacity[a.uid]?.used ?? 0) / (tenant.capacity[a.uid]?.cap ?? 1)) - ((tenant.capacity[b.uid]?.used ?? 0) / (tenant.capacity[b.uid]?.cap ?? 1)));
  const pct = ss ? Math.min(100, Math.round((ss.consumedMins / ss.targetMins) * 100)) : 0;
  const paused = sv.timer === 'stop_timer';
  const [due, dueSev] = dueLabel(t.resolveDueAt);
  const comments = t.comments ?? []; const tasks = t.tasks ?? []; const worklog = t.worklog ?? []; const approvals = t.approvals ?? []; const attachments = t.attachments ?? [];
  const totalMins = worklog.reduce((a, w) => a + w.mins, 0);
  const pendingAppr = approvals.filter((a) => a.status === 'pending').length;
  const closeMissing = closureBlockers(tenant.closureRules, t);
  const memberName = (uid?: string | null) => tenant.members.find((m) => m.uid === uid)?.name;
  const TABS: [typeof tab, string, number][] = [['detalles', 'Detalles', 0], ['resolucion', 'Resolución', 0], ['historico', 'Histórico', (t.statusHistory ?? []).length], ['tareas', 'Tareas', tasks.length], ['tiempo', 'Tiempo', worklog.length], ['aprobaciones', 'Aprobaciones', pendingAppr], ['adjuntos', 'Adjuntos', attachments.length], ['conversaciones', 'Conversaciones', comments.length]];

  return <div>
    <h3 style={{ fontSize: 16, marginBottom: 12 }}>{t.subject}</h3>
    <div className="tabs det-tabs">
      {TABS.map(([k, l, n]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}{n > 0 && <span className="tabn">{n}</span>}</button>)}
    </div>

    {tab === 'detalles' && <>
      <div className="facts">
        <div><div className="k">Prioridad</div>{badge(priorityView(tenant, t.priority).label, priorityView(tenant, t.priority).color)}</div>
        <div><div className="k">Estado</div><span className="stbadge" style={{ color: sv.color, background: `color-mix(in srgb, ${sv.color} 15%, transparent)` }}>{sv.label}{sv.timer === 'stop_timer' ? ' · ⏸' : ''}</span></div>
        <div><div className="k">Solicitante</div><span style={{ fontSize: 13 }}>{req?.name ?? '—'}</span></div>
        <div><div className="k">Técnico</div><span style={{ fontSize: 13 }}>{tech?.name ?? 'Sin asignar'}</span></div>
        {group && <div><div className="k">Grupo</div><span style={{ fontSize: 13 }}>{group.name}</span></div>}
        {t.serviceCategory && <div><div className="k">Categoría de servicio</div><span style={{ fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6 }}>{catIconEl((tenant.serviceCategories ?? []).find((c) => c.id === t.serviceCategoryId), 16)}{t.serviceCategory}</span></div>}
        {t.category && <div><div className="k">Categoría</div><span style={{ fontSize: 13 }}>{[t.category, t.subcategory, t.item].filter(Boolean).join(' › ')}</span></div>}
        <div><div className="k">Vencimiento</div><span className={dueSev === 'crit' ? 'sev-crit' : dueSev === 'warn' ? 'sev-warn' : ''} style={{ fontSize: 13, fontWeight: 600 }}>{due}</span></div>
        {t.impact && <div><div className="k">Impacto</div><span style={{ fontSize: 13 }}>{t.impact}</span></div>}
        {t.urgency && <div><div className="k">Urgencia</div><span style={{ fontSize: 13 }}>{t.urgency}</span></div>}
        {t.mode && <div><div className="k">Modo</div><span style={{ fontSize: 13 }}>{t.mode}</span></div>}
        {(t.site || req?.site) && <div><div className="k">Sede</div><span style={{ fontSize: 13 }}>{t.site ?? req?.site}</span></div>}
        {req?.department && <div><div className="k">Departamento</div><span style={{ fontSize: 13 }}>{req.department}</span></div>}
      </div>
      {ss && <div style={{ marginTop: 12 }}>
        <div className="k">SLA de resolución {paused && '· ⏸ en pausa'}</div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: ss.breached ? 'var(--crit)' : 'var(--ink-soft)' }}>
          {fmtMins(ss.consumedMins)} de {fmtMins(ss.targetMins)} {ss.breached ? '· incumplido' : `· quedan ${fmtMins(Math.max(0, ss.remainingMins))}`}
        </div>
        <div className="slabar"><span style={{ width: pct + '%', background: ss.breached ? 'var(--crit)' : paused ? 'var(--warn)' : 'var(--ok)' }} /></div>
      </div>}
      {t.description && <div className="desc rich" dangerouslySetInnerHTML={{ __html: sanitizeHtml(t.description) }} />}
      {t.udf && Object.keys(t.udf).length > 0 && (() => {
        const tpl = tenant.templates.find((x) => x.id === t.templateId);
        const scat = t.serviceCategoryId ? (tenant.serviceCategories ?? []).find((c) => c.id === t.serviceCategoryId) : undefined;
        const labelOf = (id: string) => tpl?.fieldDefs?.find((f) => f.id === id)?.label ?? scat?.fields?.find((f) => f.id === id)?.label ?? id;
        const nameOf = (id: string) => tenant.members.find((m) => m.uid === id)?.name;
        const entries = Object.entries(t.udf).filter(([, v]) => v !== '' && v != null);
        return entries.length > 0 ? <div style={{ marginTop: 12 }}>
          <div className="k">Campos adicionales</div>
          <div className="facts" style={{ marginTop: 6 }}>{entries.map(([id, v]) => <div key={id}>
            <div className="k">{labelOf(id)}</div><span style={{ fontSize: 13 }}>{v === 'true' ? 'Sí' : v === 'false' ? 'No' : (nameOf(v) ?? v)}</span>
          </div>)}</div>
        </div> : null;
      })()}
      {(t.checklist ?? []).length > 0 && (() => {
        const tpl = tenant.templates.find((x) => x.id === t.templateId);
        const done = t.checklist!.filter((c) => c.done).length; const total = t.checklist!.length;
        return <div style={{ marginTop: 12 }}>
          <div className="k">Lista de comprobación <span className="pill">{done}/{total}</span>{tpl?.checklistGate && done < total && <span className="pill" style={{ background: 'var(--crit-bg)', color: 'var(--crit)', marginLeft: 4 }}>bloquea el cierre</span>}</div>
          <div className="ck-list">{t.checklist!.map((c) => <label key={c.id} className={'ck-item' + (c.done ? ' on' : '')}>
            <input type="checkbox" checked={c.done} disabled={readOnly} onChange={() => toggleChecklistItem(t.id, c.id)} />
            <span>{c.text}</span>
          </label>)}</div>
        </div>;
      })()}
      {isClosingStatus(tenant.statuses, t.status) && (t.survey
        ? <div className="survey-box"><div className="k">Satisfacción (CSAT)</div>
            <div className="stars ro">{[1, 2, 3, 4, 5].map((n) => <span key={n} className={n <= t.survey!.rating ? 'on' : ''}>★</span>)}<b style={{ marginLeft: 8 }}>{t.survey!.rating}/5</b></div>
            {t.survey!.comment && <div style={{ fontSize: 13, color: 'var(--ink-soft)', marginTop: 4 }}>{t.survey!.comment}</div>}
          </div>
        : t.requesterId === meUid && !readOnly
          ? <div className="survey-box"><div className="k">¿Qué tal resolvimos tu solicitud?</div>
              <div className="stars">{[1, 2, 3, 4, 5].map((n) => <span key={n} className={n <= surveyRating ? 'on' : ''} onClick={() => setSurveyRating(n)}>★</span>)}</div>
              <textarea rows={2} value={surveyComment} onChange={(e) => setSurveyComment(e.target.value)} placeholder="Comentario (opcional)…" style={{ width: '100%', marginTop: 6 }} />
              <button className="primary" style={{ marginTop: 6 }} disabled={!surveyRating} onClick={() => submitSurvey(t.id, surveyRating, surveyComment)}>Enviar valoración</button>
            </div>
          : null)}
      {canAct && <>
        {nexts.length > 0 && canChangeStatus && <>
          <div className="section-t">Mover a <span className="pill">según flujo</span></div>
          <div className="trbtns">{nexts.map((tr) => {
            const closing = isClosingStatus(tenant.statuses, tr.to);
            const noClose = closing && !canClose;
            const blocked = noClose || (closing && closeMissing.length > 0);
            return <button key={tr.id} className="trbtn" disabled={blocked} title={noClose ? 'No tienes permiso para cerrar/resolver' : blocked ? `Falta: ${closeMissing.join(', ')}` : ''} onClick={() => { setCloseErr(''); transition(t.id, tr.to); }}>{stateOf(lc!, tr.to)?.label} →</button>;
          })}</div>
        </>}
        {statuses.length > 0 && canChangeStatus && <>
          <div className="section-t">Cambiar estado</div>
          <select className="statussel" value={statuses.some((s) => s.name === t.status) ? t.status : ''} onChange={(e) => {
            const to = e.target.value; if (!to) return;
            if (isClosingStatus(tenant.statuses, to) && !canClose) { setCloseErr('No tienes permiso para cerrar/resolver.'); return; }
            if (isClosingStatus(tenant.statuses, to) && closeMissing.length) { setCloseErr(`Para pasar a «${to}» falta: ${closeMissing.join(', ')}.`); return; }
            setCloseErr(''); setStatus(t.id, to);
          }}>
            <option value="">— Selecciona estado —</option>
            {(['in_progress', 'stop_timer', 'completed'] as SlaCategory[]).map((g) => <optgroup key={g} label={CAT[g][0]}>
              {statuses.filter((s) => s.timer === g).map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
            </optgroup>)}
          </select>
          {closeErr && <div className="closeerr">⚠ {closeErr}</div>}
        </>}
        {canAssign && <>
        <div className="section-t">Asignar técnico <span className="badge">⚡ carga vía OrganiZate</span>{scoped.length > 0 && group && <span className="pill" style={{ marginLeft: 6 }}>grupo: {group.name}</span>}<button className="linkbtn" style={{ marginLeft: 'auto' }} onClick={() => autoAssign(t.id)} title="Asigna al técnico menos cargado del grupo">⚡ Auto-asignar</button></div>
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
      {(t.statusHistory ?? []).map((h, i) => { const label = statuses.find((x) => x.name === h.state)?.name ?? (lc ? stateOf(lc, h.state)?.label : undefined) ?? h.state; const durMin = Math.round(((h.to ?? Date.now()) - h.from) / 60000); return <div key={i} className="tl-item">
        <span className="tl-dot" /><div><div className="tl-state">{label}</div><div className="tl-meta">{fmtDate(h.from)} · {h.to ? fmtMins(durMin) : 'en curso'}</div></div>
      </div>; })}
    </div>}

    {tab === 'tareas' && (() => {
      const techs = tenant.members.filter((m) => m.role === 'technician' || m.role === 'tenant_admin');
      const taskTypes = tenant.picklists?.taskType ?? [];
      const done = tasks.filter((k) => k.done).length;
      const addNow = () => {
        if (!task.trim()) return;
        addTask(t.id, task, { assigneeUid: taskAssignee || undefined, dueAt: taskDue ? new Date(taskDue).getTime() : undefined, type: taskType || undefined });
        setTask(''); setTaskAssignee(''); setTaskDue(''); setTaskType('');
      };
      return <div style={{ marginTop: 4 }}>
        {tasks.length === 0 && <div className="empty">Sin tareas.</div>}
        {tasks.length > 0 && <div style={{ fontSize: 11, color: 'var(--ink-faint)', margin: '2px 0 6px' }}>{done}/{tasks.length} completadas · más reciente primero</div>}
        {tasks.map((k, i) => <div key={k.id} className="taskrow">
          <input type="checkbox" checked={k.done} disabled={!canAct} onChange={() => toggleTask(t.id, k.id)} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <span style={{ textDecoration: k.done ? 'line-through' : 'none', color: k.done ? 'var(--ink-faint)' : 'var(--ink)' }}>{k.text}</span>
            {(k.type || k.assigneeUid || k.dueAt) && <div className="taskmeta">
              {k.type && <span className="tchip">{k.type}</span>}
              {k.assigneeUid && <span className="tmeta">👤 {memberName(k.assigneeUid) ?? '—'}</span>}
              {k.dueAt && <span className="tmeta" style={{ color: !k.done && k.dueAt < Date.now() ? 'var(--crit)' : undefined }}>📅 {fmtDate(k.dueAt)}</span>}
            </div>}
          </div>
          {canAct && <span className="taskmv"><button className="xbtn" disabled={i === 0} onClick={() => moveTask(t.id, k.id, -1)} aria-label="Subir">↑</button><button className="xbtn" disabled={i === tasks.length - 1} onClick={() => moveTask(t.id, k.id, 1)} aria-label="Bajar">↓</button></span>}
        </div>)}
        {canAct && <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <input value={task} onChange={(e) => setTask(e.target.value)} placeholder="Nueva tarea…" onKeyDown={(e) => { if (e.key === 'Enter') addNow(); }} />
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <select value={taskType} onChange={(e) => setTaskType(e.target.value)}><option value="">Tipo…</option>{taskTypes.map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}</select>
            <select value={taskAssignee} onChange={(e) => setTaskAssignee(e.target.value)}><option value="">Asignar a…</option>{techs.map((m) => <option key={m.uid} value={m.uid}>{m.name}</option>)}</select>
            <input type="date" value={taskDue} onChange={(e) => setTaskDue(e.target.value)} title="Vencimiento" />
            <button className="primary" onClick={addNow} disabled={!task.trim()}>Añadir</button>
          </div>
        </div>}
      </div>;
    })()}

    {tab === 'tiempo' && <div style={{ marginTop: 4 }}>
      {worklog.length === 0 && <div className="empty">Sin tiempo registrado.</div>}
      {worklog.length > 0 && <div style={{ fontSize: 11, color: 'var(--ink-faint)', margin: '2px 0 6px' }}>Total: <b style={{ color: 'var(--ink)' }}>{fmtDur(totalMins)}</b> en {worklog.length} {worklog.length === 1 ? 'registro' : 'registros'}</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{worklog.map((w) => <div key={w.id} className="wlrow">
        <div><b>{fmtDur(w.mins)}</b> · {w.techName}{w.note && <span style={{ color: 'var(--ink-soft)' }}> — {w.note}</span>}</div>
        <span className="comment-at">{fmtDate(w.at)}</span>
      </div>)}</div>
      {canAct && <div style={{ marginTop: 12, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <input type="number" min={5} step={5} value={wlMins} onChange={(e) => setWlMins(Number(e.target.value))} style={{ width: 90 }} title="Minutos" />
        <span style={{ fontSize: 12, color: 'var(--ink-soft)' }}>min</span>
        <input style={{ flex: 1, minWidth: 160 }} value={wlNote} onChange={(e) => setWlNote(e.target.value)} placeholder="Nota (opcional)…" />
        <button className="primary" onClick={() => { addWorklog(t.id, wlMins, wlNote, meName); setWlNote(''); setWlMins(30); }} disabled={!wlMins || wlMins <= 0}>Registrar tiempo</button>
      </div>}
    </div>}

    {tab === 'aprobaciones' && (() => {
      const candidates = tenant.members.filter((m) => m.status === 'active' && m.uid !== meUid);
      const toggle = (uid: string) => setApprSel(apprSel.includes(uid) ? apprSel.filter((x) => x !== uid) : [...apprSel, uid]);
      const send = () => { if (apprSel.length) { requestApproval(t.id, apprSel, apprNote); setApprSel([]); setApprNote(''); } };
      const APV: Record<string, [string, string]> = { pending: ['Pendiente', 'var(--warn)'], approved: ['Aprobada', 'var(--ok)'], rejected: ['Rechazada', 'var(--crit)'], waiting: ['En espera del nivel anterior', 'var(--ink-faint)'] };
      return <div style={{ marginTop: 4 }}>
        {approvals.length === 0 && <div className="empty">Sin solicitudes de aprobación.</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{approvals.map((a) => {
          const [lbl, col] = APV[a.status] ?? APV.pending!;
          const canDecide = a.status === 'pending' && a.approverUid === meUid && !readOnly;
          return <div key={a.id} className={'approw' + (a.status === 'waiting' ? ' waiting' : '')}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
              <b>{a.approverName}{a.level ? <span className="pill" style={{ marginLeft: 6 }}>Nivel {a.level}</span> : null}</b>
              <span className="pill" style={{ color: col, borderColor: col }}>{lbl}</span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--ink-soft)', marginTop: 2 }}>Solicitada por {a.requestedByName} · {fmtDate(a.requestedAt)}</div>
            {a.note && <div style={{ fontSize: 13, marginTop: 4 }}>{a.note}</div>}
            {a.decidedAt && <div style={{ fontSize: 12, color: 'var(--ink-soft)', marginTop: 4 }}>{lbl} · {fmtDate(a.decidedAt)}{a.comment ? ` — ${a.comment}` : ''}</div>}
            {canDecide && <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <input style={{ flex: 1, minWidth: 140 }} value={apprComment[a.id] ?? ''} onChange={(e) => setApprComment({ ...apprComment, [a.id]: e.target.value })} placeholder="Comentario (opcional)…" />
              <button className="primary" onClick={() => decideApproval(t.id, a.id, 'approved', apprComment[a.id] ?? '')}>Aprobar</button>
              <button className="xbtn" style={{ color: 'var(--crit)' }} onClick={() => decideApproval(t.id, a.id, 'rejected', apprComment[a.id] ?? '')}>Rechazar</button>
            </div>}
          </div>;
        })}</div>
        {canAct && <div style={{ marginTop: 12, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
          <div style={{ fontSize: 12, color: 'var(--ink-soft)', marginBottom: 6 }}>Solicitar aprobación a:</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {candidates.map((m) => <button key={m.uid} type="button" className={'chipsel' + (apprSel.includes(m.uid) ? ' on' : '')} onClick={() => toggle(m.uid)}>{m.name}</button>)}
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
            <input style={{ flex: 1, minWidth: 160 }} value={apprNote} onChange={(e) => setApprNote(e.target.value)} placeholder="Motivo (opcional)…" />
            <button className="primary" onClick={send} disabled={apprSel.length === 0}>Solicitar aprobación</button>
          </div>
          <div style={{ fontSize: 11, color: 'var(--ink-faint)', marginTop: 6 }}>Al solicitar, la solicitud pasa a «Pendiente Aprobación» (pausa el SLA).</div>
        </div>}
      </div>;
    })()}

    {tab === 'adjuntos' && <div style={{ marginTop: 4 }}>
      {attachments.length === 0 && <div className="empty">Sin adjuntos.</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{attachments.map((a) => <div key={a.id} className="atrow">
        <span className="atname">📎 {(a.url || a.dataUrl) ? <a href={a.url || a.dataUrl} download={a.name} target="_blank" rel="noreferrer">{a.name}</a> : a.name}</span>
        <span className="atmeta">{fmtSize(a.size)} · {a.uploadedByName} · {fmtDate(a.at)}</span>
        {canAct && <button className="xbtn" style={{ color: 'var(--crit)' }} onClick={() => removeAttachment(t.id, a.id)} aria-label="Eliminar">✕</button>}
      </div>)}</div>
      {canAct && <div style={{ marginTop: 12 }}>
        <label className="filebtn">
          {uploading ? 'Subiendo…' : '＋ Añadir adjunto'}
          <input type="file" style={{ display: 'none' }} disabled={uploading} onChange={async (e) => {
            const f = e.target.files?.[0]; if (!f) return;
            if (f.size > 10 * 1024 * 1024) { alert('El fichero supera 10 MB.'); e.target.value = ''; return; }
            setUploading(true);
            try { await uploadAttachment(t.id, f, meName); } finally { setUploading(false); e.target.value = ''; }
          }} />
        </label>
        <div style={{ fontSize: 11, color: 'var(--ink-faint)', marginTop: 6 }}>Máximo 10 MB por fichero.</div>
      </div>}
    </div>}

    {tab === 'conversaciones' && <div style={{ marginTop: 4 }}>
      {comments.length === 0 && <div className="empty">Sin conversación todavía.</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>{comments.map((c, i) => <div key={i} className="comment">
        <div className="comment-h"><b>{c.authorName}</b>{c.internal && <span className="pill" style={{ marginLeft: 6 }}>nota interna</span>}<span className="comment-at">{fmtDate(c.at)}</span></div>
        <div className="comment-b" style={{ whiteSpace: 'pre-wrap' }}>{c.text}</div>
      </div>)}</div>
      <div style={{ marginTop: 12 }}>
        {canAct && (tenant.replyTemplates ?? []).length > 0 && <select className="statussel" style={{ marginBottom: 6 }} value="" onChange={(e) => {
          const rt = (tenant.replyTemplates ?? []).find((x) => x.id === e.target.value); if (rt) setComment(comment ? comment + '\n\n' + rt.body : rt.body);
        }}>
          <option value="">↳ Insertar respuesta predefinida…</option>
          {(tenant.replyTemplates ?? []).map((rt) => <option key={rt.id} value={rt.id}>{rt.title}</option>)}
        </select>}
        {readOnly ? <div className="empty" style={{ fontSize: 12 }}>Modo lectura: no puedes comentar mientras representas a un usuario.</div> : <>
        <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={3} style={{ width: '100%' }} placeholder={canAct ? 'Escribe una respuesta o nota…' : 'Escribe un comentario…'} />
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 8 }}>
          <button className="primary" onClick={() => { addComment(t.id, comment, meName, canAct && internal); setComment(''); }} disabled={!comment.trim()}>Comentar</button>
          {canAct && <label style={{ fontSize: 12, color: 'var(--ink-soft)', display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> Nota interna</label>}
        </div></>}
      </div>
    </div>}
  </div>;
}

const tplGroup = (t: Template) => t.group ?? (t.type === 'incident' ? 'Incidencias' : 'Solicitudes de servicio');

function NewTicket({ tenant, role, user, readOnly, onClose }: { tenant: TenantData; role: Role; user: ReturnType<typeof buildUser>; readOnly?: boolean; onClose: () => void }) {
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
  const pls = tenant.picklists;
  const [priority, setPriority] = useState(pls?.priority.some((p) => p.name === 'Media') ? 'Media' : pls?.priority[0]?.name ?? 'Media');
  const [impact, setImpact] = useState('');
  const [urgency, setUrgency] = useState('');
  const [mode, setMode] = useState('');
  const [site, setSite] = useState('');
  const [description, setDescription] = useState('');
  const requesters = tenant.members.filter((m) => m.role === 'requester');
  const [requesterId, setRequesterId] = useState(role === 'requester' ? user.uid : requesters[0]?.uid ?? user.uid);
  const [udf, setUdf] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});

  // Matriz de prioridades: al elegir impacto + urgencia, calcula la prioridad
  // (el técnico puede cambiarla luego a mano).
  useEffect(() => { if (impact && urgency) { const p = tenant.priorityMatrix?.[impact]?.[urgency]; if (p) setPriority(p); } }, [impact, urgency, tenant.priorityMatrix]);

  // Perfilado de catálogo: el solicitante solo ve tipologías permitidas (visibles
  // para solicitante Y, si la plantilla restringe por grupos de usuarios, que el
  // solicitante pertenezca a alguno). Técnico/admin ven todas.
  const myUG = tenant.members.find((m) => m.uid === user.uid)?.userGroups ?? [];
  const canSee = (t: Template) => {
    if (role !== 'requester') return true;
    if (t.showToRequester === false) return false;
    if (!t.userGroups || t.userGroups.length === 0) return true;
    return t.userGroups.some((g) => myUG.includes(g));
  };
  const groups = new Map<string, Template[]>();
  for (const t of tenant.templates) {
    if (!canSee(t)) continue;
    if (q && !t.name.toLowerCase().includes(q.toLowerCase())) continue;
    const g = tplGroup(t); if (!groups.has(g)) groups.set(g, []); groups.get(g)!.push(t);
  }
  const grpList = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  // --- Formulario dinámico: renderiza el layout de la plantilla (fieldDefs) ---
  const defs = tpl?.fieldDefs ?? [];
  const hasDefs = defs.length > 0;
  const visDefs = defs.filter((f) => !(role === 'requester' && f.requesterVisible === false));
  const hasSubject = visDefs.some((f) => sysRoleOf(f.label) === 'subject');
  const setU = (id: string, v: string) => setUdf((u) => ({ ...u, [id]: v }));

  // valor actual de un campo (por id de FieldDef), para las reglas del formulario y la validación.
  const valueOf = (f: FieldDef): string => {
    switch (sysRoleOf(f.label)) {
      case 'subject': return subject; case 'description': return description; case 'category': return category;
      case 'priority': return priority; case 'impact': return impact; case 'urgency': return urgency;
      case 'mode': return mode; case 'site': return site; case 'requester': return requesterId;
      default: return udf[f.id] ?? '';
    }
  };
  // Reglas del formulario: se evalúan en cada render (=> reaccionan al cambiar cualquier campo).
  const frValues: Record<string, string> = {};
  for (const f of defs) frValues[f.id] = valueOf(f);
  const effects: FieldEffects = tpl ? evaluateFormRules(tenant.formRules, { templateId: tpl.id, role, values: frValues }) : {};
  // campos que no se rellenan al crear o quedan ocultos por rol/regla
  const roleHidden = (f: FieldDef) => { const r = sysRoleOf(f.label); if (r === 'skip' || r === 'subcategory' || r === 'item') return true; if ((r === 'mode' || r === 'requester') && role === 'requester') return true; return false; };
  const isHidden = (f: FieldDef) => effects[f.id]?.hidden === true || roleHidden(f);
  const isMandatory = (f: FieldDef) => effects[f.id]?.mandatory ?? !!f.mandatory;
  const isDisabled = (f: FieldDef) => effects[f.id]?.disabled === true;

  // valida obligatorios visibles (base + los que una regla marque obligatorios)
  const missingReq = visDefs.some((f) => isMandatory(f) && !isHidden(f) && !valueOf(f).trim());
  const canSubmit = !!subject.trim() && !!tpl && !missingReq && !readOnly;
  const submit = () => { if (!canSubmit || !tpl) return; create({ subject, description, category, subcategory: subcategory || undefined, item: item || undefined, priority, impact: impact || undefined, urgency: urgency || undefined, mode: mode || undefined, site: site || undefined, requesterId, templateId: tpl.id, udf }); onClose(); };

  const reqStar = (f: FieldDef) => isMandatory(f) ? <span className="req" title="Obligatorio">*</span> : null;
  // clasificación (categoría → subcategoría → artículo) en cascada, un solo bloque
  const catControl = <Fragment key="__cat">
    <label>Categoría<select value={category} onChange={(e) => { setCategory(e.target.value); setSubcategory(''); setItem(''); }}>{(tree.length ? tree.map((c) => c.name) : tenant.categories).map((c) => <option key={c} value={c}>{c}</option>)}</select></label>
    {catNode && catNode.subs.length > 0 && <label>Subcategoría<select value={subcategory} onChange={(e) => { setSubcategory(e.target.value); setItem(''); }}><option value="">— Seleccionar —</option>{catNode.subs.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}</select></label>}
    {subNode && subNode.items.length > 0 && <label>Artículo<select value={item} onChange={(e) => setItem(e.target.value)}><option value="">— Seleccionar —</option>{subNode.items.map((it) => <option key={it} value={it}>{it}</option>)}</select></label>}
  </Fragment>;
  const customControl = (f: FieldDef, dis: boolean) => {
    const v = udf[f.id] ?? ''; const lbl = <>{f.label}{reqStar(f)}</>;
    switch (f.type) {
      case 'textarea': return <label key={f.id}>{lbl}<textarea value={v} onChange={(e) => setU(f.id, e.target.value)} rows={3} disabled={dis} /></label>;
      case 'bool': return <label key={f.id} className="nf-bool"><input type="checkbox" checked={v === 'true'} onChange={(e) => setU(f.id, e.target.checked ? 'true' : 'false')} disabled={dis} /> {f.label}{reqStar(f)}</label>;
      case 'date': return <label key={f.id}>{lbl}<input type="date" value={v} onChange={(e) => setU(f.id, e.target.value)} disabled={dis} /></label>;
      case 'number': return <label key={f.id}>{lbl}<input type="number" value={v} onChange={(e) => setU(f.id, e.target.value)} disabled={dis} /></label>;
      case 'person': return <label key={f.id}>{lbl}<select value={v} onChange={(e) => setU(f.id, e.target.value)} disabled={dis}><option value="">— Seleccionar —</option>{tenant.members.map((m) => <option key={m.uid} value={m.uid}>{m.name}</option>)}</select></label>;
      case 'attachment': return <label key={f.id}>{lbl}<span className="soft" style={{ fontSize: 12 }}>Se adjunta tras crear la solicitud</span></label>;
      default: return <label key={f.id}>{lbl}<input value={v} onChange={(e) => setU(f.id, e.target.value)} disabled={dis} /></label>;
    }
  };
  const control = (f: FieldDef): import('react').ReactNode => {
    if (isHidden(f)) return null;
    const dis = isDisabled(f);
    switch (sysRoleOf(f.label)) {
      case 'subject': return <label key={f.id} className="nf-span">{f.label}{reqStar(f)}<input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Resume la solicitud…" disabled={dis} autoFocus /></label>;
      case 'description': return <label key={f.id} className="nf-span">{f.label}{reqStar(f)}<textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} disabled={dis} /></label>;
      case 'category': return catControl;
      case 'priority': return <label key={f.id}>{f.label}{reqStar(f)}<select value={priority} onChange={(e) => setPriority(e.target.value)} disabled={dis}>{(pls?.priority ?? [{ name: 'Media' }]).map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}</select></label>;
      case 'impact': return <label key={f.id}>{f.label}{reqStar(f)}<select value={impact} onChange={(e) => setImpact(e.target.value)} disabled={dis}><option value="">— Seleccionar —</option>{(pls?.impact ?? []).map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}</select></label>;
      case 'urgency': return <label key={f.id}>{f.label}{reqStar(f)}<select value={urgency} onChange={(e) => setUrgency(e.target.value)} disabled={dis}><option value="">— Seleccionar —</option>{(pls?.urgency ?? []).map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}</select></label>;
      case 'mode': return <label key={f.id}>{f.label}{reqStar(f)}<select value={mode} onChange={(e) => setMode(e.target.value)} disabled={dis}><option value="">— Seleccionar —</option>{(pls?.mode ?? []).map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}</select></label>;
      case 'site': return <label key={f.id}>{f.label}{reqStar(f)}<select value={site} onChange={(e) => setSite(e.target.value)} disabled={dis}><option value="">— Seleccionar —</option>{(tenant.sites ?? []).map((x) => <option key={x} value={x}>{x}</option>)}</select></label>;
      case 'requester': return <label key={f.id}>{f.label}{reqStar(f)}<select value={requesterId} onChange={(e) => setRequesterId(e.target.value)} disabled={dis}>{requesters.map((m) => <option key={m.uid} value={m.uid}>{m.name}</option>)}</select></label>;
      default: return customControl(f, dis);
    }
  };
  const dynSections = visDefs.reduce<string[]>((a, f) => { const s = secOf(f); if (!a.includes(s)) a.push(s); return a; }, []);
  const colFieldsOf = (sec: string, col: 1 | 2) => visDefs.filter((f) => secOf(f) === sec && !f.full && (f.col === 2 ? 2 : 1) === col);
  const fullFieldsOf = (sec: string) => visDefs.filter((f) => secOf(f) === sec && f.full);

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
                <span className={'catgrp-ic' + ((tenant.serviceCategoryIcons ?? {})[g] ? ' emoji' : '')} style={(tenant.serviceCategoryIcons ?? {})[g] ? undefined : { background: 'var(--accent)' }}>{(tenant.serviceCategoryIcons ?? {})[g] ?? g[0]}</span>
                <span className="catgrp-n">{g}</span><span className="catgrp-c">{tps.length}</span>
                <svg className="chev" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M9 6l6 6-6 6" /></svg>
              </button>
              {isOpen && <div className="catgrp-items">{tps.map((t) => <button key={t.id} className="catitem" onClick={() => { setTpl(t); setSubject(''); }}>
                <span className={'tdot ' + (t.type === 'incident' ? 'i' : 's')} /> {t.name}
                <span className="pill" style={{ marginLeft: 'auto' }}>{t.fields.length} campos</span>
              </button>)}</div>}
            </div>; })}
            {grpList.length === 0 && <div className="empty">Ninguna plantilla coincide con «{q}».</div>}
          </> : <div className="form nf-form">
            <button className="backbtn" onClick={() => setTpl(tenant.templates.length === 1 ? tpl : null)}>‹ {tplGroup(tpl)} · {tpl.name}</button>
            {hasDefs ? <>
              {!hasSubject && <div className="nf-sec"><label>Asunto<span className="req" title="Obligatorio">*</span><input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Resume la solicitud…" autoFocus /></label></div>}
              {dynSections.map((sec) => <div key={sec} className="nf-sec">
                <div className="nf-sec-h">{sec}</div>
                <div className="nf-cols">
                  <div className="nf-col">{colFieldsOf(sec, 1).map(control)}</div>
                  <div className="nf-col">{colFieldsOf(sec, 2).map(control)}</div>
                </div>
                {fullFieldsOf(sec).map(control)}
              </div>)}
            </> : <>
              <label>Asunto<input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Resume la solicitud…" autoFocus /></label>
              <label>Descripción<textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={4} /></label>
              <label>Categoría<select value={category} onChange={(e) => { setCategory(e.target.value); setSubcategory(''); setItem(''); }}>{(tree.length ? tree.map((c) => c.name) : tenant.categories).map((c) => <option key={c} value={c}>{c}</option>)}</select></label>
              {catNode && catNode.subs.length > 0 && <label>Subcategoría<select value={subcategory} onChange={(e) => { setSubcategory(e.target.value); setItem(''); }}><option value="">— Seleccionar —</option>{catNode.subs.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}</select></label>}
              {subNode && subNode.items.length > 0 && <label>Artículo<select value={item} onChange={(e) => setItem(e.target.value)}><option value="">— Seleccionar —</option>{subNode.items.map((it) => <option key={it} value={it}>{it}</option>)}</select></label>}
              <label>Prioridad<select value={priority} onChange={(e) => setPriority(e.target.value)}>{(pls?.priority ?? [{ name: 'Media' }]).map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}</select></label>
              {pls && pls.impact.length > 0 && <label>Impacto<select value={impact} onChange={(e) => setImpact(e.target.value)}><option value="">— Seleccionar —</option>{pls.impact.map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}</select></label>}
              {pls && pls.urgency.length > 0 && <label>Urgencia<select value={urgency} onChange={(e) => setUrgency(e.target.value)}><option value="">— Seleccionar —</option>{pls.urgency.map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}</select></label>}
              {role !== 'requester' && pls && pls.mode.length > 0 && <label>Modo<select value={mode} onChange={(e) => setMode(e.target.value)}><option value="">— Seleccionar —</option>{pls.mode.map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}</select></label>}
              {(tenant.sites ?? []).length > 0 && <label>Sede<select value={site} onChange={(e) => setSite(e.target.value)}><option value="">— Seleccionar —</option>{(tenant.sites ?? []).map((x) => <option key={x} value={x}>{x}</option>)}</select></label>}
              {role !== 'requester' && <label>Solicitante<select value={requesterId} onChange={(e) => setRequesterId(e.target.value)}>{requesters.map((m) => <option key={m.uid} value={m.uid}>{m.name}</option>)}</select></label>}
            </>}
            {readOnly && <div className="empty" style={{ fontSize: 12, marginTop: 4 }}>👁 Modo lectura: estás viendo el catálogo que ve este usuario; no puedes crear la solicitud.</div>}
            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              <button className="primary" onClick={submit} disabled={!canSubmit}>Crear solicitud</button>
              <button className="ghost" onClick={onClose}>Cancelar</button>
            </div>
          </div>}
        </div>
      </aside>
    </div>
  );
}

// Alta en MODO SIMPLIFICADO: 1 plantilla · Tipo (Incidencia/Petición) + Categoría de
// servicio (filtrada por permisos). Los campos propios de la categoría se muestran en
// una sección aparte; la categoría define el ciclo de vida (y el SLA por tipo).
function NewTicketSimplified({ tenant, role, user, readOnly, onClose }: { tenant: TenantData; role: Role; user: ReturnType<typeof buildUser>; readOnly?: boolean; onClose: () => void }) {
  const create = useStore((s) => s.createTicket);
  const pls = tenant.picklists;
  const [tipo, setTipo] = useState<'incident' | 'service_request'>('incident');
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState(pls?.priority.some((p) => p.name === 'Media') ? 'Media' : pls?.priority[0]?.name ?? 'Media');
  const [site, setSite] = useState('');
  const requesters = tenant.members.filter((m) => m.role === 'requester');
  const [requesterId, setRequesterId] = useState(role === 'requester' ? user.uid : requesters[0]?.uid ?? user.uid);
  const [udf, setUdf] = useState<Record<string, string>>({});
  const setU = (id: string, v: string) => setUdf((u) => ({ ...u, [id]: v }));
  const uploadAttachment = useStore((s) => s.uploadAttachment);
  const meName = tenant.members.find((m) => m.uid === user.uid)?.name ?? user.uid;
  // Clasificación Categoría › Subcategoría › Artículo (como SDP; independiente de la
  // categoría de servicio, que es el eje del modo simplificado).
  const tree = tenant.categoryTree ?? [];
  const [category, setCategory] = useState(tree[0]?.name ?? tenant.categories[0] ?? 'General');
  const [subcategory, setSubcategory] = useState('');
  const [item, setItem] = useState('');
  const catNode = tree.find((c) => c.name === category) ?? null;
  const subNode = catNode?.subs.find((s) => s.name === subcategory) ?? null;
  const [files, setFiles] = useState<File[]>([]);
  const [dragOver, setDragOver] = useState(false);

  const myUG = tenant.members.find((m) => m.uid === user.uid)?.userGroups ?? [];
  const canSee = (c: import('../data/seed.js').ServiceCategoryDef) => role !== 'requester' || !c.userGroups?.length || c.userGroups.some((g) => myUG.includes(g));
  const cats = (tenant.serviceCategories ?? []).filter((c) => !!c[tipo]).filter(canSee);
  const [catId, setCatId] = useState('');
  const cat = cats.find((c) => c.id === catId) ?? cats[0];
  useEffect(() => { if (!cats.some((c) => c.id === catId)) setCatId(cats[0]?.id ?? ''); }, [tipo, cats, catId]);

  const lcId = cat ? cat[tipo]?.lifecycleId ?? null : null;
  const lcName = lcId ? tenant.lifecycles.find((l) => l.id === lcId)?.name ?? lcId : null;
  const catFields = cat?.fields ?? [];
  // Reglas del formulario POR CATEGORÍA: se evalúan en vivo sobre los valores de los
  // campos de la categoría (muestran/ocultan/obligan/deshabilitan).
  const frValues: Record<string, string> = {}; for (const f of catFields) frValues[f.id] = udf[f.id] ?? '';
  const effects: FieldEffects = cat ? evaluateFormRules(tenant.formRules, { templateId: 'unified', serviceCategoryId: cat.id, role, values: frValues }) : {};
  const isHidden = (f: FieldDef) => effects[f.id]?.hidden === true;
  const isMand = (f: FieldDef) => effects[f.id]?.mandatory ?? !!f.mandatory;
  const isDis = (f: FieldDef) => effects[f.id]?.disabled === true;
  const visCatFields = catFields.filter((f) => !isHidden(f));
  const missingCat = visCatFields.some((f) => isMand(f) && !(udf[f.id] ?? '').trim());
  const canSubmit = !!subject.trim() && !!cat && !missingCat && !readOnly;
  const submit = async () => {
    if (!canSubmit || !cat) return;
    const id = create({ subject, description, category, subcategory: subcategory || undefined, item: item || undefined, priority, site: site || undefined, requesterId, serviceCategoryId: cat.id, type: tipo, udf });
    if (id) for (const f of files) { try { await uploadAttachment(id, f, meName); } catch { /* ignora fallo de subida individual */ } }
    onClose();
  };
  const onDrop = (e: import('react').DragEvent<HTMLDivElement>) => { e.preventDefault(); setDragOver(false); setFiles((fs) => [...fs, ...Array.from(e.dataTransfer.files)]); };

  const widget = (f: FieldDef) => {
    const v = udf[f.id] ?? ''; const dis = isDis(f);
    switch (f.type) {
      case 'textarea': return <textarea value={v} rows={3} disabled={dis} onChange={(e) => setU(f.id, e.target.value)} />;
      case 'bool': return <label className="nf-bool"><input type="checkbox" checked={v === 'true'} disabled={dis} onChange={(e) => setU(f.id, e.target.checked ? 'true' : 'false')} /> Sí</label>;
      case 'date': return <input type="date" value={v} disabled={dis} onChange={(e) => setU(f.id, e.target.value)} />;
      case 'number': return <input type="number" value={v} disabled={dis} onChange={(e) => setU(f.id, e.target.value)} />;
      case 'person': return <select value={v} disabled={dis} onChange={(e) => setU(f.id, e.target.value)}><option value="">— Seleccionar —</option>{tenant.members.map((m) => <option key={m.uid} value={m.uid}>{m.name}</option>)}</select>;
      case 'select': return (f.options ?? []).length ? <select value={v} disabled={dis} onChange={(e) => setU(f.id, e.target.value)}><option value="">— Seleccionar —</option>{f.options!.map((o) => <option key={o} value={o}>{o}</option>)}</select> : <input value={v} disabled={dis} onChange={(e) => setU(f.id, e.target.value)} />;
      default: return <input value={v} disabled={dis} onChange={(e) => setU(f.id, e.target.value)} />;
    }
  };

  return (
    <div className="scrim" onClick={onClose}>
      <aside className="drawer wide" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Nueva solicitud">
        <div className="drawer-h"><h2>Nueva solicitud</h2><button className="dx" onClick={onClose} aria-label="Cerrar">×</button></div>
        <div className="drawer-b"><div className="form nf-form">
          <div className="nf-sec">
            <label>Tipo de solicitud
              <div className="seg" style={{ marginTop: 4 }}>
                <button type="button" className={tipo === 'incident' ? 'on' : ''} onClick={() => setTipo('incident')}>🛠️ Incidencia</button>
                <button type="button" className={tipo === 'service_request' ? 'on' : ''} onClick={() => setTipo('service_request')}>📥 Petición</button>
              </div>
            </label>
            <label>Categoría de servicio
              <span className="cat-pick">
                {cat && <span className="cat-pick-ic">{catIconEl(cat, 22)}</span>}
                <select value={cat?.id ?? ''} onChange={(e) => setCatId(e.target.value)}>
                  {cats.map((c) => <option key={c.id} value={c.id}>{!c.iconImage && c.icon ? c.icon + ' ' : ''}{c.name}</option>)}
                  {cats.length === 0 && <option value="">— sin categorías para este tipo —</option>}
                </select>
              </span>
            </label>
            {lcName ? <div className="lc-hint">⚙️ Ciclo de vida: <b>{lcName}</b></div> : cat && <div className="lc-hint">⚙️ Sin flujo (estado libre)</div>}
          </div>
          <div className="nf-sec">
            <div className="nf-sec-h">Datos de la solicitud</div>
            <label>Asunto<span className="req">*</span><input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Resume la solicitud…" autoFocus /></label>
            <div className="nf-cols">
              <div className="nf-col">
                <label>Prioridad<span className="req">*</span><select value={priority} onChange={(e) => setPriority(e.target.value)}>{(pls?.priority ?? [{ name: 'Media' }]).map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}</select></label>
                <label>Categoría<select value={category} onChange={(e) => { setCategory(e.target.value); setSubcategory(''); setItem(''); }}>{(tree.length ? tree.map((c) => c.name) : tenant.categories).map((c) => <option key={c} value={c}>{c}</option>)}</select></label>
                {subNode && subNode.items.length > 0 && <label>Artículo<select value={item} onChange={(e) => setItem(e.target.value)}><option value="">— Seleccionar —</option>{subNode.items.map((it) => <option key={it} value={it}>{it}</option>)}</select></label>}
              </div>
              <div className="nf-col">
                {(tenant.sites ?? []).length > 0 && <label>Sede<select value={site} onChange={(e) => setSite(e.target.value)}><option value="">— Seleccionar —</option>{(tenant.sites ?? []).map((x) => <option key={x} value={x}>{x}</option>)}</select></label>}
                {catNode && catNode.subs.length > 0 && <label>Subcategoría<select value={subcategory} onChange={(e) => { setSubcategory(e.target.value); setItem(''); }}><option value="">— Seleccionar —</option>{catNode.subs.map((sn) => <option key={sn.name} value={sn.name}>{sn.name}</option>)}</select></label>}
              </div>
            </div>
            {role !== 'requester' && <label>Solicitante<select value={requesterId} onChange={(e) => setRequesterId(e.target.value)}>{requesters.map((m) => <option key={m.uid} value={m.uid}>{m.name}</option>)}</select></label>}
            <label>Descripción<RichText value={description} onChange={setDescription} placeholder="Describe la solicitud con detalle…" disabled={readOnly} /></label>
          </div>
          {visCatFields.length > 0 && <div className="nf-sec">
            <div className="nf-sec-h">Campos de la categoría · {cat?.name}</div>
            <div className="nf-cols">
              <div className="nf-col">{visCatFields.filter((f) => (f.col ?? 1) === 1).map((f) => <label key={f.id}>{f.label}{isMand(f) && <span className="req">*</span>}{widget(f)}</label>)}</div>
              <div className="nf-col">{visCatFields.filter((f) => f.col === 2).map((f) => <label key={f.id}>{f.label}{isMand(f) && <span className="req">*</span>}{widget(f)}</label>)}</div>
            </div>
          </div>}
          <div className="nf-sec">
            <div className="nf-sec-h">Archivos adjuntos</div>
            <div className={'dropzone' + (dragOver ? ' over' : '')} onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={onDrop}>
              <label className="dz-pick">Arrastra y suelta archivos aquí, o <span className="linkbtn">selecciónalos</span>
                <input type="file" multiple style={{ display: 'none' }} onChange={(e) => { setFiles((fs) => [...fs, ...Array.from(e.target.files ?? [])]); e.target.value = ''; }} />
              </label>
            </div>
            {files.length > 0 && <div className="dz-list">{files.map((f, i) => <span key={i} className="dz-file">📎 {f.name} <span className="soft">({fmtSize(f.size)})</span><button className="xbtn" onClick={() => setFiles((fs) => fs.filter((_, j) => j !== i))} aria-label="Quitar">✕</button></span>)}</div>}
          </div>
          {readOnly && <div className="empty" style={{ fontSize: 12 }}>👁 Modo lectura: no puedes crear la solicitud.</div>}
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <button className="primary" onClick={submit} disabled={!canSubmit}>Crear solicitud</button>
            <button className="ghost" onClick={onClose}>Cancelar</button>
          </div>
        </div></div>
      </aside>
    </div>
  );
}

// Configuración del MODO DE OPERACIÓN (clásico ↔ simplificado). Mismo backend.
function ModeAdmin({ tenant }: { tenant: TenantData }) {
  const setMode = useStore((s) => s.setOperationMode);
  const mode = tenant.operationMode ?? 'classic';
  const cats = tenant.serviceCategories ?? [];
  return <div className="card" style={{ padding: 16 }}>
    <p className="cfg-lead">Cómo opera esta instancia. Ambos modos usan los <b>mismos datos</b> (tickets, ciclos, miembros); puedes alternar para comparar y decidir. Cambiar de modo no borra nada.</p>
    <div className="mode-opts">
      <button className={'mode-opt' + (mode === 'classic' ? ' on' : '')} onClick={() => setMode('classic')}>
        <b>Clásico</b><span>Muchas plantillas (estilo SDP). <b>{tenant.templates.length}</b> plantillas.</span>
      </button>
      <button className={'mode-opt' + (mode === 'simplified' ? ' on' : '')} onClick={() => setMode('simplified')}>
        <b>Simplificado</b><span>1 plantilla + Tipo + Categoría de servicio. <b>{cats.length}</b> categorías.</span>
      </button>
    </div>
    <div className="banner" style={{ marginTop: 14 }}>Modo actual: <b>{mode === 'simplified' ? 'Simplificado' : 'Clásico'}</b>. En simplificado, «＋ Nueva solicitud» pide <b>Tipo + Categoría</b>, los campos se adaptan a la categoría y esta define el <b>ciclo de vida</b> (y el SLA por tipo: la Incidencia lleva SLA de resolución; la Petición no).</div>
  </div>;
}

// Admin de CATEGORÍAS DE SERVICIO (modo simplificado): el eje editable. Cada
// categoría define tipos permitidos + ciclo por tipo, permisos por grupo y campos.
function ServiceCategoriesAdmin({ tenant }: { tenant: TenantData }) {
  const setCats = useStore((s) => s.setServiceCategories);
  const cats = tenant.serviceCategories ?? [];
  const [open, setOpen] = useState<string | null>(cats[0]?.id ?? null);
  const replace = (id: string, nc: import('../data/seed.js').ServiceCategoryDef) => setCats(cats.map((c) => (c.id === id ? nc : c)));
  const upd = (id: string, patch: Partial<import('../data/seed.js').ServiceCategoryDef>) => setCats(cats.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  const addCat = () => { const id = 'sc-' + Date.now(); setCats([...cats, { id, name: 'Nueva categoría', service_request: { lifecycleId: null } }]); setOpen(id); };
  const del = (id: string) => { if (confirm('¿Eliminar la categoría?')) setCats(cats.filter((c) => c.id !== id)); };
  const setType = (c: import('../data/seed.js').ServiceCategoryDef, type: 'incident' | 'service_request', on: boolean) => {
    const nc = { ...c }; if (on) nc[type] = { lifecycleId: nc[type]?.lifecycleId ?? null }; else delete nc[type]; replace(c.id, nc);
  };
  const lcOpts = (type: 'incident' | 'service_request') => tenant.lifecycles.filter((l) => l.type === type);
  const FT = FIELD_TYPES;
  return <div className="card" style={{ padding: 16 }}>
    <p className="cfg-lead">Categorías de servicio del <b>modo simplificado</b>. Cada una define qué <b>tipos</b> admite y su <b>ciclo de vida</b> por tipo, quién la <b>ve</b> (permiso por grupo) y sus <b>campos</b> propios. Es lo que sustituye a las 36 plantillas.</p>
    <div className="svc-cats">{cats.map((c) => { const isOpen = open === c.id; return <div key={c.id} className={'svc-cat' + (isOpen ? ' on' : '')}>
      <div className="svc-head" style={{ cursor: 'default' }}>
        <span className="cat-pick-ic" style={{ width: 26 }}>{catIconEl(c, 22) ?? <input value={c.icon ?? ''} onChange={(e) => upd(c.id, { icon: e.target.value.slice(0, 2) })} placeholder="📁" style={{ width: 34, textAlign: 'center', fontSize: 15 }} maxLength={2} />}</span>
        <input className="svc-name" style={{ border: 'none', background: 'none', fontWeight: 600, flex: 1 }} value={c.name} onChange={(e) => upd(c.id, { name: e.target.value })} />
        {c.incident && <span className="inc-tag">INC</span>}{c.service_request && <span className="pet-tag">PET</span>}
        <button className="ghost sm" onClick={() => setOpen(isOpen ? null : c.id)}>{isOpen ? 'Cerrar' : 'Editar'}</button>
        <button className="xbtn" style={{ color: 'var(--crit)' }} onClick={() => del(c.id)}>✕</button>
      </div>
      {isOpen && <div className="svc-body">
        <div className="rule-row"><span className="rule-lbl">Icono</span>
          <span className="cat-pick-ic" style={{ width: 30 }}>{catIconEl(c, 26)}</span>
          <input value={c.icon ?? ''} onChange={(e) => upd(c.id, { icon: e.target.value.slice(0, 2) })} placeholder="emoji" style={{ width: 56, textAlign: 'center' }} maxLength={2} />
          <label className="ghost sm" style={{ cursor: 'pointer' }}>Subir imagen (SVG/PNG)
            <input type="file" accept=".svg,image/*" style={{ display: 'none' }} onChange={(e) => { const file = e.target.files?.[0]; if (!file) return; const svg = file.type === 'image/svg+xml' || file.name.toLowerCase().endsWith('.svg'); const r = new FileReader(); r.onload = () => upd(c.id, { iconImage: String(r.result) }); svg ? r.readAsText(file) : r.readAsDataURL(file); e.target.value = ''; }} />
          </label>
          {c.iconImage && <button className="xbtn" onClick={() => { const nc = { ...c }; delete nc.iconImage; replace(c.id, nc); }} title="Quitar imagen">quitar imagen ✕</button>}
        </div>
        <div className="rule-row"><span className="rule-lbl">Tipos y ciclo</span></div>
        {(['incident', 'service_request'] as const).map((tp) => { const en = !!c[tp]; return <div key={tp} className="rule-row cond">
          <label className="chipsel" style={{ cursor: 'pointer' }}><input type="checkbox" checked={en} onChange={(e) => setType(c, tp, e.target.checked)} style={{ marginRight: 5 }} />{tp === 'incident' ? '🛠️ Incidencia' : '📥 Petición'}</label>
          {en && <select value={c[tp]!.lifecycleId ?? ''} onChange={(e) => replace(c.id, { ...c, [tp]: { lifecycleId: e.target.value || null } })}>
            <option value="">— sin flujo (estado libre) —</option>{lcOpts(tp).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>}
        </div>; })}
        <div className="rule-row" style={{ marginTop: 8 }}><span className="rule-lbl">Ven la categoría</span>
          <ChipMulti options={tenant.userGroups ?? []} selected={c.userGroups ?? []} onChange={(ug) => upd(c.id, { userGroups: ug })} />
        </div>
        {(c.userGroups ?? []).length === 0 && <div className="soft" style={{ fontSize: 12, paddingLeft: 74 }}>vacío = la ven todos</div>}
        <div className="rule-row" style={{ marginTop: 8 }}><span className="rule-lbl">Campos propios</span></div>
        <div className="tt-list">{(c.fields ?? []).map((f, i) => <div key={f.id} className="cfield-row">
          <input value={f.label} onChange={(e) => replace(c.id, { ...c, fields: (c.fields ?? []).map((x) => (x.id === f.id ? { ...x, label: e.target.value } : x)) })} placeholder="Etiqueta" style={{ flex: 1 }} />
          <select value={f.type} onChange={(e) => replace(c.id, { ...c, fields: (c.fields ?? []).map((x) => (x.id === f.id ? { ...x, type: e.target.value as FieldType } : x)) })} style={{ width: 120 }}>{FT.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          {f.type === 'select' && <input value={(f.options ?? []).join(', ')} onChange={(e) => replace(c.id, { ...c, fields: (c.fields ?? []).map((x) => (x.id === f.id ? { ...x, options: e.target.value.split(',').map((o) => o.trim()).filter(Boolean) } : x)) })} placeholder="opción1, opción2…" style={{ width: 150 }} title="Opciones del desplegable" />}
          <label className="chipsel" style={{ cursor: 'pointer' }} title="Obligatorio"><input type="checkbox" checked={!!f.mandatory} onChange={(e) => replace(c.id, { ...c, fields: (c.fields ?? []).map((x) => (x.id === f.id ? { ...x, mandatory: e.target.checked } : x)) })} style={{ marginRight: 4 }} />oblig.</label>
          <button className="xbtn" style={{ color: 'var(--crit)' }} onClick={() => replace(c.id, { ...c, fields: (c.fields ?? []).filter((x) => x.id !== f.id) })}>✕</button>
        </div>)}</div>
        <button className="linkbtn" onClick={() => replace(c.id, { ...c, fields: [...(c.fields ?? []), { id: 'cf-' + Date.now(), label: 'Nuevo campo', type: 'text', requesterVisible: true, section: 'Campos de la categoría', col: 1 }] })}>＋ campo</button>
      </div>}
    </div>; })}</div>
    {cats.length === 0 && <div className="empty">Sin categorías. Añade la primera.</div>}
    <button className="primary" style={{ marginTop: 12 }} onClick={addCat}>＋ Añadir categoría</button>
  </div>;
}

// Campana de avisos en pantalla (los del usuario actual).
function Bell({ tenant, meUid }: { tenant: TenantData; meUid: string }) {
  const markRead = useStore((s) => s.markNotifRead);
  const markAll = useStore((s) => s.markAllNotifsRead);
  const select = useStore((s) => s.select);
  const [open, setOpen] = useState(false);
  const mine = (tenant.notifications ?? []).filter((n) => n.forUid === meUid);
  const unread = mine.filter((n) => !n.read).length;
  return <div className="bellwrap">
    <button className="iconbtn" title="Avisos" aria-label="Avisos" onClick={() => setOpen((o) => !o)}>🔔{unread > 0 && <span className="belldot">{unread > 9 ? '9+' : unread}</span>}</button>
    {open && <>
      <div className="bell-scrim" onClick={() => setOpen(false)} />
      <div className="bell-pop">
        <div className="bell-h"><b>Avisos</b>{unread > 0 && <button className="linkbtn" onClick={() => markAll()}>Marcar todo leído</button>}</div>
        <div className="bell-list">
          {mine.length === 0 && <div className="empty">Sin avisos.</div>}
          {mine.slice(0, 30).map((n) => <button key={n.id} className={'bell-item' + (n.read ? '' : ' unread')} onClick={() => { markRead(n.id); select(n.ticketId); setOpen(false); }}>
            <div className="bell-txt">{n.text}</div>
            <div className="bell-sub">{n.subject}</div>
          </button>)}
        </div>
      </div>
    </>}
  </div>;
}

const NOTIF_EVENTS: [import('../model.js').NotifEvent, string][] = [
  ['created', 'Solicitud creada'], ['assigned', 'Asignada a técnico'], ['status', 'Cambio de estado'],
  ['resolved', 'Resuelta'], ['comment', 'Respuesta / comentario'], ['internal_note', 'Nota interna'], ['sla_breach', 'SLA incumplido'],
];
// Reglas de notificación: matriz evento × destinatario × canal (pantalla/correo).
function NotifAdmin({ tenant }: { tenant: TenantData }) {
  const setRules = useStore((s) => s.setNotifRules);
  const rules = tenant.notifRules ?? [];
  const get = (ev: string) => rules.find((r) => r.event === ev) ?? { event: ev as import('../model.js').NotifEvent, requester: {}, technician: {}, group: {} };
  const toggle = (ev: string, who: 'requester' | 'technician' | 'group', ch: 'screen' | 'mail') => {
    const cur = get(ev); const next = { ...cur, [who]: { ...cur[who], [ch]: !cur[who][ch] } };
    const others = rules.filter((r) => r.event !== ev);
    setRules([...others, next].sort((a, b) => NOTIF_EVENTS.findIndex((e) => e[0] === a.event) - NOTIF_EVENTS.findIndex((e) => e[0] === b.event)));
  };
  const cell = (ev: string, who: 'requester' | 'technician' | 'group') => { const c = get(ev)[who]; return <div className="ncell">
    <button className={'cbtn' + (c.screen ? ' on' : '')} onClick={() => toggle(ev, who, 'screen')}>pantalla</button>
    <button className={'cbtn mail' + (c.mail ? ' on' : '')} onClick={() => toggle(ev, who, 'mail')}>correo</button>
  </div>; };
  return <>
    <div className="banner" style={{ marginBottom: 14 }}>Quién recibe aviso en cada evento y por qué canal. <b>pantalla</b> = campana en la app (activa) · <b>correo</b> = email (requiere la extensión de envío; se activa a continuación).</div>
    <div className="card" style={{ overflow: 'hidden' }}>
      <table className="mgmt ntbl"><thead><tr><th style={{ width: '30%' }}>Evento</th><th>Solicitante</th><th>Técnico asignado</th><th>Grupo de soporte</th></tr></thead>
        <tbody>{NOTIF_EVENTS.map(([ev, label]) => <tr key={ev}>
          <td style={{ fontWeight: 600 }}>{label}{ev === 'sla_breach' && <span className="pill" style={{ marginLeft: 6 }}>programado</span>}</td>
          <td>{cell(ev, 'requester')}</td><td>{cell(ev, 'technician')}</td><td>{cell(ev, 'group')}</td>
        </tr>)}</tbody>
      </table>
    </div>
  </>;
}

// Administración = landing de configuración por áreas (como SDP), no pestañas.
const ADMIN_AREAS: [string, string, [string, string | null][]][] = [
  ['Configuraciones de instancia', '🏢', [['Modo de operación', 'modo'], ['Sitios', 'maestros'], ['Horas operativas', 'horario'], ['Grupos de días festivos', 'horario'], ['Departamentos', 'maestros'], ['Moneda', null]]],
  ['Usuarios y permisos', '👥', [['Roles', 'roles'], ['Usuarios', 'miembros'], ['Traspaso a Atenza', 'traspaso'], ['Grupos de usuarios', 'maestros'], ['Grupos de soporte', 'sla'], ['Acceso específico', null]]],
  ['Personalización', '🎨', [['Estado', 'estado'], ['Categoría › Subcategoría › Artículo', 'categoria'], ['Valores (prioridad, impacto, urgencia, nivel, modo, tipos)', 'valores'], ['Matriz de prioridades', 'matriz'], ['Campos adicionales', 'campos']]],
  ['Plantillas y formularios', '📄', [['Plantillas y campos', 'plantillas'], ['Categoría de servicio', 'servicios'], ['Categorías (modo simplificado)', 'catservicio'], ['Reglas del formulario', 'formreglas']]],
  ['Autoservicio y anuncios', '📣', [['Base de conocimiento', null], ['Anuncios', 'anuncios'], ['Encuestas de satisfacción', null]]],
  ['Automatización', '⚙️', [['Reglas de negocio', 'reglas'], ['SLA y horarios', 'sla'], ['Ciclos de vida', 'ciclos'], ['Reglas de notificación', 'notif'], ['Reglas de cierre', 'cierre'], ['Activadores · webhooks', 'webhooks'], ['Asignación automática', null]]],
  ['Configuración del correo', '✉️', [['Correo entrante → ticket', 'entrante'], ['Servidor de correo', null], ['Respuestas predefinidas', 'respuestas'], ['Plantillas de aviso', null]]],
  ['Gobierno y auditoría', '🛡️', [['Registro de auditoría', 'auditoria'], ['Sincronización SDP', 'sync'], ['Integración OrganiZate', 'organizate'], ['Exportar / archivar', null]]],
];
const ADMIN_TITLE: Record<string, string> = { plantillas: 'Plantillas y formularios', categoria: 'Categoría › Subcategoría › Artículo', estado: 'Estado', valores: 'Valores del servicio de asistencia', matriz: 'Matriz de prioridades', horario: 'Horario laboral y festivos', maestros: 'Datos maestros · sedes, departamentos y grupos de usuarios', roles: 'Roles y permisos', notif: 'Reglas de notificación', ciclos: 'Ciclos de vida', sla: 'SLA y grupos de soporte', miembros: 'Usuarios y miembros', cierre: 'Reglas de cierre', respuestas: 'Respuestas predefinidas', traspaso: 'Traspaso a Atenza · habilitación escalonada', reglas: 'Reglas de negocio', webhooks: 'Activadores · webhooks salientes', anuncios: 'Anuncios', auditoria: 'Registro de auditoría', entrante: 'Correo entrante → ticket', campos: 'Campos adicionales', servicios: 'Categoría de servicio', sync: 'Sincronización SDP → Atenza', formreglas: 'Reglas del formulario', organizate: 'Integración con OrganiZate', modo: 'Modo de operación', catservicio: 'Categorías de servicio (modo simplificado)' };

// Catálogo de estados: los 15 reales agrupados por temporizador, editables.
function StatusAdmin({ tenant }: { tenant: TenantData }) {
  const setStatuses = useStore((s) => s.setStatuses);
  const list = tenant.statuses ?? [];
  const commit = (next: import('../model.js').StatusDef[]) => setStatuses(next);
  const [nn, setNn] = useState(''); const [nt, setNt] = useState<SlaCategory>('in_progress');
  const groups: [SlaCategory, string][] = [['in_progress', 'En curso'], ['stop_timer', 'Detener temporizador'], ['completed', 'Completado']];
  return <>
    <div className="banner" style={{ marginBottom: 14 }}>Estados de la solicitud. La <b>categoría de temporizador</b> decide el SLA: <b>En curso</b> consume, <b>Detener</b> lo pausa, <b>Completado</b> lo cierra.</div>
    <div className="card" style={{ overflow: 'hidden' }}>
      <table className="mgmt"><thead><tr><th>Nombre</th><th>Temporizador</th><th>Color</th><th /></tr></thead>
        <tbody>
          {groups.map(([g, gl]) => <Fragment key={g}>
            <tr><td colSpan={4} className="grp-h">{gl}</td></tr>
            {list.filter((s) => s.timer === g).map((s) => { const idx = list.indexOf(s); return <tr key={s.name}>
              <td><input className="cell-in" value={s.name} onChange={(e) => commit(list.map((x, i) => (i === idx ? { ...x, name: e.target.value } : x)))} /></td>
              <td><select className="cell-in" value={s.timer} onChange={(e) => commit(list.map((x, i) => (i === idx ? { ...x, timer: e.target.value as SlaCategory } : x)))}>{groups.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></td>
              <td><input type="color" className="colorin" value={s.color} onChange={(e) => commit(list.map((x, i) => (i === idx ? { ...x, color: e.target.value } : x)))} /></td>
              <td><button className="xbtn" onClick={() => commit(list.filter((_, i) => i !== idx))} aria-label="Eliminar">✕</button></td>
            </tr>; })}
          </Fragment>)}
        </tbody>
      </table>
      <div className="designer">
        <input style={{ flex: 1, minWidth: 120 }} value={nn} onChange={(e) => setNn(e.target.value)} placeholder="Nuevo estado…" />
        <select value={nt} onChange={(e) => setNt(e.target.value as SlaCategory)}>{groups.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        <button className="primary" onClick={() => { if (nn.trim() && !list.some((s) => s.name === nn.trim())) { commit([...list, { name: nn.trim(), timer: nt, color: '#4f46e5' }]); setNn(''); } }}>＋ Estado</button>
      </div>
    </div>
  </>;
}

// Roles y capacidades: nivel base (gobierna reglas) + capacidades de app.
const ROLE_BASES: [RoleBase, string][] = [['tenant_admin', 'Admin'], ['technician', 'Técnico'], ['requester', 'Solicitante']];
function RolesAdmin({ tenant }: { tenant: TenantData }) {
  const setRoles = useStore((s) => s.setRoles);
  const roles = tenant.roles ?? [];
  const [nn, setNn] = useState(''); const [nb, setNb] = useState<RoleBase>('technician');
  const commit = (next: RoleDef[]) => setRoles(next);
  const toggleCap = (i: number, cap: Cap) => { const r = roles[i]!; const cur = r.caps ?? DEFAULT_CAPS[r.base]; const caps = cur.includes(cap) ? cur.filter((c) => c !== cap) : [...cur, cap]; commit(roles.map((x, idx) => (idx === i ? { ...x, caps } : x))); };
  return <>
    <div className="banner" style={{ marginBottom: 14 }}>Cada rol tiene un <b>nivel base</b> (Admin/Técnico/Solicitante) que gobierna el acceso en <b>servidor</b> (reglas de Firestore) y unas <b>capacidades</b> que gobiernan la app. <span style={{ color: 'var(--ink-faint)' }}>El enforcement fino en servidor (por capacidad) es un endurecimiento posterior.</span></div>
    <div className="card" style={{ overflowX: 'auto' }}>
      <table className="mgmt"><thead><tr><th>Rol</th><th style={{ width: 130 }}>Nivel base</th><th>Capacidades</th><th style={{ width: 44 }} /></tr></thead>
        <tbody>{roles.map((r, i) => { const active = r.caps ?? DEFAULT_CAPS[r.base]; return <tr key={r.name}>
          <td style={{ fontWeight: 600 }}>{r.name}</td>
          <td><select className="cell-in" value={r.base} onChange={(e) => commit(roles.map((x, idx) => (idx === i ? { ...x, base: e.target.value as RoleBase } : x)))}>{ROLE_BASES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></td>
          <td><div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>{CAP_LIST.map(([c, l]) => <button key={c} className={'chipsel' + (active.includes(c) ? ' on' : '')} onClick={() => toggleCap(i, c)}>{l}</button>)}</div></td>
          <td><button className="xbtn" onClick={() => commit(roles.filter((_, idx) => idx !== i))} aria-label="Eliminar">✕</button></td>
        </tr>; })}</tbody>
      </table>
      <div className="designer">
        <input style={{ flex: 1, minWidth: 140 }} value={nn} onChange={(e) => setNn(e.target.value)} placeholder="Nuevo rol…" />
        <select value={nb} onChange={(e) => setNb(e.target.value as RoleBase)}>{ROLE_BASES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        <button className="primary" onClick={() => { if (nn.trim() && !roles.some((r) => r.name === nn.trim())) { commit([...roles, { name: nn.trim(), base: nb }]); setNn(''); } }}>＋ Rol</button>
      </div>
    </div>
  </>;
}

// Catálogos de valores (customizer): Prioridad/Impacto/Urgencia/Nivel/Modo/Tipos.
const VALUE_LISTS: [keyof Picklists, string, boolean][] = [
  ['priority', 'Prioridad', true], ['impact', 'Impacto', false], ['urgency', 'Urgencia', false],
  ['level', 'Nivel', false], ['mode', 'Modo', false], ['requestType', 'Tipo de solicitud', false], ['taskType', 'Tipo de tarea', true],
];
function ValuesAdmin({ tenant }: { tenant: TenantData }) {
  const setPicklist = useStore((s) => s.setPicklist);
  const [tab, setTab] = useState<keyof Picklists>('priority');
  const list = tenant.picklists?.[tab] ?? [];
  const hasColor = VALUE_LISTS.find((v) => v[0] === tab)?.[2];
  const [nn, setNn] = useState('');
  const commit = (next: PickVal[]) => setPicklist(tab, next);
  return <>
    <div className="banner" style={{ marginBottom: 14 }}>Catálogos de valores del servicio de asistencia. La <b>Prioridad</b> lleva color (se usa en los chips) y alimenta la <b>matriz de prioridades</b> (Impacto × Urgencia).</div>
    <div className="tabs" style={{ marginBottom: 14 }}>{VALUE_LISTS.map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => { setTab(k); setNn(''); }}>{l}</button>)}</div>
    <div className="card" style={{ overflow: 'hidden' }}>
      <table className="mgmt"><thead><tr><th>Nombre</th>{hasColor && <th style={{ width: 90 }}>Color</th>}<th style={{ width: 50 }} /></tr></thead>
        <tbody>{list.map((v, idx) => <tr key={idx}>
          <td><input className="cell-in" value={v.name} onChange={(e) => commit(list.map((x, i) => (i === idx ? { ...x, name: e.target.value } : x)))} /></td>
          {hasColor && <td><input type="color" className="colorin" value={v.color ?? '#4f46e5'} onChange={(e) => commit(list.map((x, i) => (i === idx ? { ...x, color: e.target.value } : x)))} /></td>}
          <td><button className="xbtn" onClick={() => commit(list.filter((_, i) => i !== idx))} aria-label="Eliminar">✕</button></td>
        </tr>)}
          {list.length === 0 && <tr><td colSpan={3} className="empty">Sin valores.</td></tr>}</tbody>
      </table>
      <div className="designer">
        <input style={{ flex: 1, minWidth: 140 }} value={nn} onChange={(e) => setNn(e.target.value)} placeholder="Nuevo valor…" onKeyDown={(e) => { if (e.key === 'Enter' && nn.trim() && !list.some((x) => x.name === nn.trim())) { commit([...list, hasColor ? { name: nn.trim(), color: '#4f46e5' } : { name: nn.trim() }]); setNn(''); } }} />
        <button className="primary" onClick={() => { if (nn.trim() && !list.some((x) => x.name === nn.trim())) { commit([...list, hasColor ? { name: nn.trim(), color: '#4f46e5' } : { name: nn.trim() }]); setNn(''); } }}>＋ Valor</button>
      </div>
    </div>
  </>;
}

// Matriz de prioridades: rejilla Impacto (filas) × Urgencia (columnas) → Prioridad.
function MatrixAdmin({ tenant }: { tenant: TenantData }) {
  const setMatrix = useStore((s) => s.setPriorityMatrix);
  const matrix = tenant.priorityMatrix ?? {};
  const imp = tenant.picklists?.impact ?? [];
  const urg = tenant.picklists?.urgency ?? [];
  const pri = tenant.picklists?.priority ?? [];
  const priColor = (name: string) => pri.find((p) => p.name === name)?.color ?? 'var(--ink)';
  const setCell = (i: string, u: string, v: string) => setMatrix({ ...matrix, [i]: { ...(matrix[i] ?? {}), [u]: v } });
  return <>
    <div className="banner" style={{ marginBottom: 14 }}>Cada combinación de <b>Impacto</b> × <b>Urgencia</b> determina la <b>Prioridad</b>. En el alta se calcula sola al elegir impacto y urgencia (el técnico puede cambiarla).</div>
    <div className="card" style={{ overflowX: 'auto' }}>
      <table className="mgmt"><thead><tr><th>Impacto \ Urgencia</th>{urg.map((u) => <th key={u.name}>{u.name}</th>)}</tr></thead>
        <tbody>{imp.map((i) => <tr key={i.name}>
          <td style={{ fontWeight: 600 }}>{i.name}</td>
          {urg.map((u) => { const v = matrix[i.name]?.[u.name] ?? ''; return <td key={u.name}>
            <select className="cell-in" style={{ fontWeight: 700, color: v ? priColor(v) : 'var(--ink-faint)' }} value={v} onChange={(e) => setCell(i.name, u.name, e.target.value)}>
              <option value="">—</option>{pri.map((p) => <option key={p.name} value={p.name} style={{ color: 'var(--ink)' }}>{p.name}</option>)}
            </select>
          </td>; })}
        </tr>)}</tbody>
      </table>
    </div>
  </>;
}

// Datos maestros: sedes y departamentos (listas de nombres, con búsqueda).
function StringListCard({ title, list, onChange, placeholder, search }: { title: string; list: string[]; onChange: (l: string[]) => void; placeholder: string; search?: boolean }) {
  const [q, setQ] = useState(''); const [nv, setNv] = useState('');
  const shown = search && q ? list.filter((x) => x.toLowerCase().includes(q.toLowerCase())) : list;
  const add = () => { const v = nv.trim(); if (v && !list.includes(v)) { onChange([...list, v]); setNv(''); } };
  return <div className="card"><h2>{title} <span className="badge">{list.length}</span></h2>
    {search && <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar…" style={{ width: '100%', marginTop: 10 }} />}
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 12, maxHeight: 260, overflowY: 'auto' }}>
      {shown.slice(0, 200).map((x) => <span key={x} className="pill">{x}<button className="xbtn" style={{ marginLeft: 4 }} onClick={() => onChange(list.filter((y) => y !== x))}>✕</button></span>)}
      {shown.length === 0 && <span className="empty" style={{ padding: 8 }}>Sin resultados.</span>}
    </div>
    {shown.length > 200 && <div className="empty" style={{ padding: 6 }}>… {shown.length} resultados (mostrando 200). Usa la búsqueda para acotar.</div>}
    <div className="designer"><input style={{ flex: 1, minWidth: 140 }} value={nv} onChange={(e) => setNv(e.target.value)} placeholder={placeholder} onKeyDown={(e) => e.key === 'Enter' && add()} /><button className="primary" onClick={add}>＋</button></div>
  </div>;
}
function MasterDataAdmin({ tenant }: { tenant: TenantData }) {
  const setSites = useStore((s) => s.setSites);
  const setDepartments = useStore((s) => s.setDepartments);
  const setUserGroups = useStore((s) => s.setUserGroups);
  return <>
    <div className="work">
      <StringListCard title="Sedes" list={tenant.sites ?? []} onChange={setSites} placeholder="Nueva sede…" />
      <StringListCard title="Departamentos" list={tenant.departments ?? []} onChange={setDepartments} placeholder="Nuevo departamento…" search />
    </div>
    <div className="work" style={{ marginTop: 16 }}>
      <StringListCard title="Grupos de usuarios" list={tenant.userGroups ?? []} onChange={setUserGroups} placeholder="Nuevo grupo de usuarios…" />
      <div className="card"><div className="banner" style={{ margin: 0 }}>Los <b>grupos de usuarios</b> perfilan el catálogo: en cada plantilla (Plantillas → editar) eliges qué grupos pueden verla, y en cada persona (Miembros) a qué grupos pertenece. Sin restricción, la plantilla la ve cualquier solicitante.</div></div>
    </div>
  </>;
}

// Calendario laboral (horas operativas + festivos) → alimenta el SLA por horario.
const DOW: [number, string][] = [[1, 'Lun'], [2, 'Mar'], [3, 'Mié'], [4, 'Jue'], [5, 'Vie'], [6, 'Sáb'], [0, 'Dom']];
function CalendarAdmin({ tenant }: { tenant: TenantData }) {
  const setBH = useStore((s) => s.setBusinessHours);
  const setHol = useStore((s) => s.setHolidays);
  const bh = tenant.businessHours ?? { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' };
  const holidays = tenant.holidays ?? [];
  const [nh, setNh] = useState('');
  const [ny, setNy] = useState(String(new Date().getFullYear()));
  const loadMadrid = () => { const y = Number(ny); if (!y) return; const add = madridHolidayDates([y]).filter((d) => !holidays.includes(d)); if (add.length) setHol([...holidays, ...add].sort()); };
  const toggleDay = (d: number) => setBH({ ...bh, days: bh.days.includes(d) ? bh.days.filter((x) => x !== d) : [...bh.days, d].sort() });
  return <div className="work">
    <div className="card"><h2>Horario laboral</h2>
      <div className="banner" style={{ marginTop: 10 }}>El SLA solo consume dentro de esta franja y los días marcados; fuera de horario y en festivos, el reloj se para.</div>
      <div className="k" style={{ marginTop: 14 }}>Días laborables</div>
      <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>{DOW.map(([d, l]) => <button key={d} className={'daybtn' + (bh.days.includes(d) ? ' on' : '')} onClick={() => toggleDay(d)}>{l}</button>)}</div>
      <div style={{ display: 'flex', gap: 16, marginTop: 14 }}>
        <label style={{ fontSize: 12, color: 'var(--ink-soft)', display: 'flex', flexDirection: 'column', gap: 5 }}>Desde<input type="time" value={bh.start} onChange={(e) => setBH({ ...bh, start: e.target.value })} /></label>
        <label style={{ fontSize: 12, color: 'var(--ink-soft)', display: 'flex', flexDirection: 'column', gap: 5 }}>Hasta<input type="time" value={bh.end} onChange={(e) => setBH({ ...bh, end: e.target.value })} /></label>
      </div>
    </div>
    <div className="card"><h2>Festivos <span className="badge">{holidays.length}</span></h2>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 12 }}>
        {holidays.slice().sort().map((h) => <span key={h} className="pill">{h}<button className="xbtn" style={{ marginLeft: 4 }} onClick={() => setHol(holidays.filter((x) => x !== h))}>✕</button></span>)}
        {holidays.length === 0 && <span className="empty" style={{ padding: 8 }}>Sin festivos.</span>}
      </div>
      <div className="designer">
        <input type="date" value={nh} onChange={(e) => setNh(e.target.value)} />
        <button className="primary" onClick={() => { if (nh && !holidays.includes(nh)) { setHol([...holidays, nh]); setNh(''); } }}>＋ Festivo</button>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="number" value={ny} onChange={(e) => setNy(e.target.value)} style={{ width: 78 }} title="Año" />
          <button className="ghost" onClick={loadMadrid} title="Añade los festivos oficiales de Madrid (nacionales + Comunidad + capital) de ese año">🏛️ Cargar festivos de Madrid</button>
        </span>
      </div>
      <p className="soft" style={{ fontSize: 12, marginTop: 8 }}>Festivos de Madrid como referencia (nacionales + Comunidad de Madrid + Madrid capital), con Semana Santa calculada. El SLA no cuenta estos días.</p>
    </div>
  </div>;
}

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

function KbModule({ tenant, canManage, meName }: { tenant: TenantData; canManage: boolean; meName: string }) {
  const save = useStore((s) => s.saveKbArticle);
  const remove = useStore((s) => s.removeKbArticle);
  const viewArt = useStore((s) => s.viewKbArticle);
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [editing, setEditing] = useState<KbArticle | null>(null);
  const results = searchKb(tenant.kbArticles, q, canManage);
  const open = (tenant.kbArticles ?? []).find((a) => a.id === openId) ?? null;
  const openArticle = (a: KbArticle) => { setOpenId(a.id); if (a.status === 'published') viewArt(a.id); };
  const startNew = () => setEditing({ id: 'kb-' + Date.now(), title: '', body: '', category: '', tags: [], status: 'draft', authorName: meName, createdAt: Date.now(), updatedAt: Date.now() });
  const commit = () => { if (editing && editing.title.trim()) { save({ ...editing, updatedAt: Date.now() }); setEditing(null); setOpenId(null); } };

  if (editing) {
    const e = editing;
    return <div className="kb-wrap"><div className="kb-head"><button className="crumb-b" onClick={() => setEditing(null)}>‹ Base de conocimiento</button></div>
      <div className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <input style={{ fontSize: 17, fontWeight: 700 }} value={e.title} onChange={(ev) => setEditing({ ...e, title: ev.target.value })} placeholder="Título de la solución" />
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input value={e.category ?? ''} onChange={(ev) => setEditing({ ...e, category: ev.target.value })} placeholder="Categoría" />
          <input style={{ flex: 1, minWidth: 160 }} value={(e.tags ?? []).join(', ')} onChange={(ev) => setEditing({ ...e, tags: ev.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} placeholder="Etiquetas (coma)" />
          <select value={e.status} onChange={(ev) => setEditing({ ...e, status: ev.target.value as KbArticle['status'] })}><option value="draft">Borrador</option><option value="published">Publicado</option></select>
        </div>
        <textarea rows={12} value={e.body} onChange={(ev) => setEditing({ ...e, body: ev.target.value })} placeholder="Contenido de la solución…" />
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="primary" onClick={commit} disabled={!e.title.trim()}>Guardar</button>
          <button className="xbtn" onClick={() => setEditing(null)}>Cancelar</button>
        </div>
      </div></div>;
  }

  if (open) {
    return <div className="kb-wrap"><div className="kb-head"><button className="crumb-b" onClick={() => setOpenId(null)}>‹ Base de conocimiento</button>{canManage && <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}><button className="xbtn" onClick={() => setEditing(open)}>Editar</button><button className="xbtn" style={{ color: 'var(--crit)' }} onClick={() => { remove(open.id); setOpenId(null); }}>Eliminar</button></span>}</div>
      <article className="card kb-article">
        <h2>{open.title}{open.status === 'draft' && <span className="pill" style={{ marginLeft: 8 }}>borrador</span>}</h2>
        <div className="kb-meta">{open.category && <span className="tchip">{open.category}</span>}{(open.tags ?? []).map((t) => <span key={t} className="tag-kb">#{t}</span>)}<span style={{ marginLeft: 'auto' }}>{open.authorName} · {open.views ?? 0} vistas</span></div>
        <div className="kb-body" style={{ whiteSpace: 'pre-wrap' }}>{open.body}</div>
      </article></div>;
  }

  return <div className="kb-wrap">
    <div className="kb-head">
      <input className="kb-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar soluciones…" />
      {canManage && <button className="primary" onClick={startNew}>＋ Nueva solución</button>}
    </div>
    {results.length === 0 && <div className="card"><div className="empty">{q ? 'Sin resultados.' : 'Sin soluciones publicadas.'}</div></div>}
    <div className="kb-list">{results.map((a) => <button key={a.id} className="kb-item" onClick={() => openArticle(a)}>
      <div className="kb-item-t">{a.title}{a.status === 'draft' && <span className="pill">borrador</span>}</div>
      <div className="kb-item-b">{a.body.slice(0, 140)}{a.body.length > 140 ? '…' : ''}</div>
      <div className="kb-meta">{a.category && <span className="tchip">{a.category}</span>}{(a.tags ?? []).map((t) => <span key={t} className="tag-kb">#{t}</span>)}<span style={{ marginLeft: 'auto' }}>{a.views ?? 0} vistas</span></div>
    </button>)}</div>
  </div>;
}

const ADMIN_FIRST = ADMIN_AREAS.flatMap((a) => a[2]).find(([, k]) => k)?.[1] ?? 'plantillas';
function AdminConfig({ tenant }: { tenant: TenantData }) {
  const [sec, setSec] = useState<string>(ADMIN_FIRST);
  return <div className="adm">
    <nav className="adm-nav">
      {ADMIN_AREAS.map((a) => <Fragment key={a[0]}>
        <div className="adm-g"><span className="adm-ic">{a[1]}</span>{a[0]}</div>
        {a[2].map(([l, k]) => <button key={l} className={'adm-i' + (k ? '' : ' dim') + (k && k === sec ? ' on' : '')} disabled={!k} onClick={() => k && setSec(k)}>{l}{!k && <span className="soon">pronto</span>}</button>)}
      </Fragment>)}
    </nav>
    <div className="adm-pane">
      <div className="adm-crumb">{ADMIN_TITLE[sec] ?? sec}</div>
    {sec === 'plantillas' && <CatalogAdmin tenant={tenant} />}
    {sec === 'categoria' && <CategoryAdmin tenant={tenant} />}
    {sec === 'estado' && <StatusAdmin tenant={tenant} />}
    {sec === 'valores' && <ValuesAdmin tenant={tenant} />}
    {sec === 'roles' && <RolesAdmin tenant={tenant} />}
    {sec === 'matriz' && <MatrixAdmin tenant={tenant} />}
    {sec === 'horario' && <CalendarAdmin tenant={tenant} />}
    {sec === 'maestros' && <MasterDataAdmin tenant={tenant} />}
    {sec === 'notif' && <NotifAdmin tenant={tenant} />}
    {sec === 'ciclos' && <GraphEditor tenant={tenant} />}
    {sec === 'sla' && <SlaAdmin tenant={tenant} />}
    {sec === 'miembros' && <MembersAdmin tenant={tenant} />}
    {sec === 'cierre' && <ClosureAdmin tenant={tenant} />}
    {sec === 'respuestas' && <ReplyTemplatesAdmin tenant={tenant} />}
    {sec === 'traspaso' && <EnablementAdmin tenant={tenant} />}
    {sec === 'reglas' && <BusinessRulesAdmin tenant={tenant} />}
    {sec === 'webhooks' && <WebhooksAdmin tenant={tenant} />}
    {sec === 'anuncios' && <AnnouncementsAdmin tenant={tenant} />}
    {sec === 'auditoria' && <AuditAdmin tenant={tenant} />}
    {sec === 'entrante' && <InboundAdmin tenant={tenant} />}
    {sec === 'campos' && <CustomFieldsAdmin tenant={tenant} />}
    {sec === 'servicios' && <ServiceCatalogAdmin tenant={tenant} nav={setSec} />}
    {sec === 'formreglas' && <FormRulesAdmin tenant={tenant} />}
    {sec === 'sync' && <SyncAdmin tenant={tenant} />}
    {sec === 'organizate' && <OrganizateAdmin tenant={tenant} />}
    {sec === 'modo' && <ModeAdmin tenant={tenant} />}
    {sec === 'catservicio' && <ServiceCategoriesAdmin tenant={tenant} />}
    </div>
  </div>;
}

// Paleta de iconos sugeridos para categorías de servicio (IT).
const ICON_PALETTE = ['🛠️', '📥', '💻', '🖥️', '🖨️', '📧', '🔐', '🔑', '🌐', '📶', '🗄️', '📁', '📦', '⚙️', '🧰', '🎫', '🛡️', '🚨', '☁️', '🔧', '👤', '👥', '📞', '💳', '🏢', '📝'];

// Categoría de servicio: agrupa las plantillas del catálogo de «Nueva solicitud».
// Se listan las categorías reales (de las plantillas). Cada categoría se despliega
// para (a) elegir su icono y (b) ver/abrir sus plantillas en el editor.
function ServiceCatalogAdmin({ tenant, nav }: { tenant: TenantData; nav: (s: string) => void }) {
  const setServiceIcon = useStore((s) => s.setServiceIcon);
  const setAdminTemplate = useStore((s) => s.setAdminTemplate);
  const icons = tenant.serviceCategoryIcons ?? {};
  const cats = [...new Set(tenant.templates.map((t) => tplGroup(t)))].sort((a, b) => a.localeCompare(b));
  const tplsOf = (c: string) => tenant.templates.filter((t) => tplGroup(t) === c);
  const [open, setOpen] = useState<string | null>(cats[0] ?? null);
  const openEditor = (id: string) => { setAdminTemplate(id); nav('plantillas'); };
  return <div className="card" style={{ padding: 16 }}>
    <p className="cfg-lead">Categorías de servicio del catálogo de «Nueva solicitud» (importadas de SDP). Cada plantilla pertenece a una. Despliega una categoría para elegir su <b>icono</b> (se muestra en el catálogo) y abrir sus plantillas en el editor de formularios. Los iconos originales de SDP son imágenes protegidas del servlet y no se pueden reutilizar directamente; aquí eliges uno editable.</p>
    <div className="svc-cats">{cats.map((c) => {
      const tpls = tplsOf(c); const isOpen = open === c;
      return <div key={c} className={'svc-cat' + (isOpen ? ' on' : '')}>
        <button className="svc-head" onClick={() => setOpen(isOpen ? null : c)}>
          <span className="svc-ic">{icons[c] || '📁'}</span>
          <span className="svc-name">{c}</span>
          <span className="badge">{tpls.length}</span>
          <span className="svc-chev">{isOpen ? '▾' : '▸'}</span>
        </button>
        {isOpen && <div className="svc-body">
          <div className="svc-icon-row">
            <span className="soft" style={{ fontSize: 12 }}>Icono:</span>
            {ICON_PALETTE.map((e) => <button key={e} className={'svc-emo' + (icons[c] === e ? ' sel' : '')} onClick={() => setServiceIcon(c, e)} title={e}>{e}</button>)}
            <input value={icons[c] ?? ''} onChange={(e) => setServiceIcon(c, e.target.value.slice(0, 2))} placeholder="✎" style={{ width: 40, textAlign: 'center', fontSize: 15 }} maxLength={2} title="Escribe otro emoji" />
          </div>
          <div className="svc-tpls">{tpls.map((t) => <div key={t.id} className="svc-tpl">
            <span className={'chip ' + (t.type === 'incident' ? 'inc' : 'srv')}>{t.type === 'incident' ? 'Incidencia' : 'Solicitud'}</span>
            <span className="svc-tpl-name">{t.name}</span>
            <span className="soft" style={{ fontSize: 11 }}>{(t.fieldDefs ?? t.fields).length} campos</span>
            <button className="ghost sm" onClick={() => openEditor(t.id)}>Abrir editor →</button>
          </div>)}</div>
        </div>}
      </div>;
    })}</div>
  </div>;
}

// Estado de la sincronización SDP → Atenza (el job corre server-side; aquí se ve).
function SyncAdmin({ tenant }: { tenant: TenantData }) {
  const synced = tenant.tickets.filter((t) => (t as unknown as { syncedAt?: number }).syncedAt);
  const last = synced.reduce((m, t) => Math.max(m, (t as unknown as { syncedAt?: number }).syncedAt ?? 0), 0);
  return <div className="card" style={{ padding: 16 }}>
    <p className="cfg-lead">La sincronización SDP → Atenza corre <b>server-side</b> como un Cloud Run Job disparado por Cloud Scheduler (cada 4 h), de forma desatendida. Trae los tickets activos de SDP y hace un <i>merge</i> idempotente preservando lo añadido en Atenza.</p>
    <div className="facts" style={{ gridTemplateColumns: '1fr 1fr', gap: 12 }}>
      <div><div className="k">Tickets sincronizados desde SDP</div><div style={{ fontSize: 20, fontWeight: 700 }}>{synced.length}<span style={{ fontSize: 12, color: 'var(--ink-faint)', fontWeight: 400 }}> / {tenant.tickets.length} totales</span></div></div>
      <div><div className="k">Última sincronización</div><div style={{ fontSize: 15, fontWeight: 600 }}>{last ? fmtDate(last) : '—'}</div></div>
    </div>
    <div className="banner" style={{ marginTop: 14 }}>Programación: <b>cada 4 h</b> (Europe/Madrid). Ejecución manual y logs desde GCP (Cloud Scheduler «atenza-sync-sdp» / Cloud Run Job «sync-sdp»). Runbook: <span className="mono">docs/SYNC-JOB.md</span>. Desde la app es de solo lectura; disparar bajo demanda requiere permisos de GCP.</div>
  </div>;
}

// Integración con OrganiZate: elige qué grupos de soporte sincronizan sus tareas
// como carga en OrganiZate (crear/cerrar tarea allí). Selección escalonada por grupo.
function OrganizateAdmin({ tenant }: { tenant: TenantData }) {
  const setOrganizateGroups = useStore((s) => s.setOrganizateGroups);
  const on = tenant.organizateGroupIds ?? [];
  const toggle = (gid: string) => setOrganizateGroups(on.includes(gid) ? on.filter((x) => x !== gid) : [...on, gid]);
  const ticketsOf = (gid: string) => tenant.tickets.filter((t) => t.groupId === gid).length;
  const tasksOf = (gid: string) => tenant.tickets.filter((t) => t.groupId === gid).reduce((n, t) => n + (t.tasks?.length ?? 0), 0);
  return <div className="card" style={{ padding: 16 }}>
    <p className="cfg-lead">Integra Atenza con <b>OrganiZate</b> para reflejar la carga real del técnico: cuando se asigna una tarea de un ticket de un grupo activado, se crea la tarea equivalente en OrganiZate (suma a su carga); al cerrarla, se marca como hecha (deja de contar). Activa la integración <b>por grupo de soporte</b>, de forma escalonada. La sincronización corre <b>server-side</b> (job periódico), preservando las tareas propias de OrganiZate.</p>
    <div className="banner" style={{ marginBottom: 12 }}>Requiere <b>horas estimadas</b> en la tarea (se definen en la plantilla o en el ticket) para calcular la carga. Sin horas, se asume un valor por defecto.</div>
    <table className="mgmt"><thead><tr><th style={{ width: 90 }}>Integrar</th><th>Grupo de soporte</th><th style={{ width: 110 }}>Tickets</th><th style={{ width: 110 }}>Tareas</th></tr></thead>
      <tbody>{tenant.groups.map((g) => <tr key={g.id}>
        <td><label className="switch"><input type="checkbox" checked={on.includes(g.id)} onChange={() => toggle(g.id)} /><span className="track" /></label></td>
        <td style={{ fontWeight: 500 }}>{g.name}</td>
        <td className="soft">{ticketsOf(g.id)}</td>
        <td className="soft">{tasksOf(g.id)}</td>
      </tr>)}</tbody></table>
    <div style={{ fontSize: 12.5, color: 'var(--ink-soft)', marginTop: 12 }}><b>{on.length}</b> de {tenant.groups.length} grupos integrados.</div>
  </div>;
}

// Catálogo de campos adicionales (ad-hoc) del tenant. Distinto del creador de
// formularios (Plantillas y campos): aquí se DEFINEN los campos que luego se
// arrastran a los formularios; los campos "por defecto" (Asunto, Prioridad…) son
// de sistema y no se listan aquí.
function CustomFieldsAdmin({ tenant }: { tenant: TenantData }) {
  const setCustomFields = useStore((s) => s.setCustomFields);
  const list = tenant.customFields ?? [];
  const upd = (id: string, p: Partial<FieldDef>) => setCustomFields(list.map((x) => (x.id === id ? { ...x, ...p } : x)));
  const del = (id: string) => setCustomFields(list.filter((x) => x.id !== id));
  const [nl, setNl] = useState(''); const [nt, setNt] = useState<FieldType>('text');
  const add = () => { if (!nl.trim()) return; setCustomFields([...list, { id: 'cf-' + Date.now(), label: nl.trim(), type: nt, requesterVisible: true }]); setNl(''); };
  return <div className="card" style={{ padding: 16 }}>
    <p className="cfg-lead">Campos <b>adicionales</b> (ad-hoc) de esta instancia. Los defines aquí una vez y luego los <b>arrastras</b> a los formularios en «Plantillas y campos». Los campos por defecto de SDP (Asunto, Prioridad, Categoría…) son de sistema y no se editan aquí.</p>
    <table className="mgmt"><thead><tr><th>Campo</th><th>Tipo</th><th>Obligatorio</th><th>Visible solicitante</th><th /></tr></thead>
      <tbody>{list.length === 0 ? <tr><td colSpan={5}><div className="empty">Sin campos adicionales.</div></td></tr>
        : list.map((f) => <tr key={f.id}>
          <td><input value={f.label} onChange={(e) => upd(f.id, { label: e.target.value })} style={{ width: '100%', fontWeight: 500 }} /></td>
          <td><select value={f.type} onChange={(e) => upd(f.id, { type: e.target.value as FieldType })}>{FIELD_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></td>
          <td><button className={'toggle' + (f.mandatory ? ' on' : '')} onClick={() => upd(f.id, { mandatory: !f.mandatory })} /></td>
          <td><button className={'toggle' + (f.requesterVisible !== false ? ' on' : '')} onClick={() => upd(f.id, { requesterVisible: f.requesterVisible === false })} /></td>
          <td><button className="xbtn" style={{ color: 'var(--crit)' }} onClick={() => del(f.id)} aria-label="Eliminar">✕</button></td>
        </tr>)}
      </tbody></table>
    <div className="add-field" style={{ marginTop: 12 }}>
      <input value={nl} onChange={(e) => setNl(e.target.value)} placeholder="Nuevo campo adicional…" onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
      <select value={nt} onChange={(e) => setNt(e.target.value as FieldType)}>{FIELD_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
      <button className="primary" onClick={add}>＋ Campo adicional</button>
    </div>
  </div>;
}

function InboundAdmin({ tenant }: { tenant: TenantData }) {
  const setInboundEnabled = useStore((s) => s.setInboundEnabled);
  const createFromEmail = useStore((s) => s.createFromEmail);
  const [from, setFrom] = useState('laura.gomez@digloservicer.com');
  const [subject, setSubject] = useState('No puedo acceder al portal');
  const [body, setBody] = useState('Buenas, desde esta mañana no consigo entrar al portal interno. Gracias.');
  const [result, setResult] = useState<string | null>(null);
  const on = !!tenant.inboundEnabled;
  const preview = parseInbound({ from, subject, body });
  const process = () => {
    const r = createFromEmail(from, subject, body);
    setResult(r.action === 'create' ? `✓ Ticket ${r.ticketId} creado.` : r.action === 'comment' ? `✓ Comentario añadido a ${r.ticketId}.` : 'No se procesó.');
  };
  return <div className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
    <div className={'inbound-banner ' + (on ? 'on' : 'off')}>
      <div style={{ flex: 1 }}><b>Recepción de correo: {on ? 'ACTIVADA' : 'INERTE (apagada)'}</b>
        <div style={{ fontSize: 13, color: 'var(--ink-soft)', marginTop: 2 }}>{on
          ? 'Esta instancia crea tickets desde el buzón. Úsalo solo tras redirigir el correo en el corte.'
          : 'El buzón real sigue en SDP; no entra nada por correo. El pipeline existe pero está apagado (corte por instancia).'}</div></div>
      <label className="switch"><input type="checkbox" checked={on} onChange={(e) => setInboundEnabled(e.target.checked)} /><span className="track" /></label>
    </div>

    <div>
      <div className="k" style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Simulador (no necesita buzón real)</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <input value={from} onChange={(e) => setFrom(e.target.value)} placeholder="De (email)" />
        <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Asunto" />
        <textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Cuerpo del correo" />
      </div>
      <div className="inbound-preview">
        {preview.replyToId
          ? <>Se detecta <b>respuesta</b> al ticket <span className="tchip">{preview.replyToId}</span> → se añadirá como comentario.</>
          : <>Se creará un <b>ticket nuevo</b>: «{preview.subject}» (solicitante por email <span className="mono">{preview.fromEmail}</span>).</>}
      </div>
      <button className="primary" style={{ marginTop: 8 }} onClick={process}>Procesar correo de prueba</button>
      {result && <div style={{ marginTop: 8, fontSize: 13, color: 'var(--ok)' }}>{result}</div>}
    </div>
    <div style={{ fontSize: 12, color: 'var(--ink-faint)' }}>Para el corte real: desplegar la Cloud Function del buzón (SendGrid Inbound Parse / IMAP) que llama a esta misma lógica y activar el interruptor. Hasta entonces, inerte.</div>
  </div>;
}

function AuditAdmin({ tenant }: { tenant: TenantData }) {
  const [f, setF] = useState('');
  const all = tenant.audit ?? [];
  const list = all.filter((e) => !f || e.action === f);
  const actions = [...new Set(all.map((e) => e.action))];
  return <div className="card" style={{ overflow: 'hidden' }}>
    <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--line)', display: 'flex', gap: 10, alignItems: 'center' }}>
      <span className="cfg-lead" style={{ margin: 0, flex: 1 }}>Traza inmutable de acciones. En la nube se guarda como subcolección append-only (últimos 200).</span>
      <select value={f} onChange={(e) => setF(e.target.value)}><option value="">Todas las acciones</option>{actions.map((a) => <option key={a} value={a}>{auditLabel(a)}</option>)}</select>
    </div>
    <table className="mgmt"><thead><tr><th style={{ width: 150 }}>Fecha</th><th style={{ width: 150 }}>Autor</th><th style={{ width: 160 }}>Acción</th><th>Detalle</th></tr></thead>
      <tbody>{list.length === 0
        ? <tr><td colSpan={4}><div className="empty">Sin eventos registrados.</div></td></tr>
        : list.map((e) => <tr key={e.id}><td className="id">{fmtDate(e.at)}</td><td>{e.actorName}</td><td><span className="stbadge">{auditLabel(e.action)}</span></td><td className="note">{e.summary}</td></tr>)}
      </tbody></table>
  </div>;
}

function AnnouncementsAdmin({ tenant }: { tenant: TenantData }) {
  const save = useStore((s) => s.saveAnnouncement);
  const remove = useStore((s) => s.removeAnnouncement);
  const meName = useStore((s) => { const t = s.db.tenants.find((x) => x.id === s.activeTenantId); return t?.members.find((m) => m.uid === s.currentUserId)?.name ?? 'Admin'; });
  const list = (tenant.announcements ?? []).slice().sort((a, b) => b.at - a.at);
  const upd = (id: string, patch: Partial<Announcement>) => { const a = list.find((x) => x.id === id); if (a) save({ ...a, ...patch }); };
  const AUD: [Audience, string][] = [['all', 'Todos'], ['staff', 'Solo técnicos'], ['requesters', 'Solo solicitantes']];
  return <div className="card" style={{ padding: 16 }}>
    <p className="cfg-lead">Avisos globales que se muestran como banner a técnicos y/o solicitantes.</p>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {list.length === 0 && <div className="empty">Sin anuncios.</div>}
      {list.map((a) => <div key={a.id} className="rt-card">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input style={{ flex: 1, fontWeight: 600 }} value={a.title} onChange={(e) => upd(a.id, { title: e.target.value })} placeholder="Título" />
          <select value={a.audience} onChange={(e) => upd(a.id, { audience: e.target.value as Audience })}>{AUD.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          <button className="xbtn" style={{ color: 'var(--crit)' }} onClick={() => remove(a.id)} aria-label="Eliminar">✕</button>
        </div>
        <textarea rows={2} value={a.body} onChange={(e) => upd(a.id, { body: e.target.value })} placeholder="Mensaje…" style={{ width: '100%', marginTop: 6 }} />
      </div>)}
    </div>
    <button className="primary" style={{ marginTop: 10 }} onClick={() => save({ id: 'an-' + Date.now(), title: 'Nuevo anuncio', body: '', audience: 'all', authorName: meName, at: Date.now() })}>＋ Añadir anuncio</button>
  </div>;
}

function WebhooksAdmin({ tenant }: { tenant: TenantData }) {
  const setWebhooks = useStore((s) => s.setWebhooks);
  const list = tenant.webhooks ?? [];
  const upd = (id: string, patch: Partial<Webhook>) => setWebhooks(list.map((w) => (w.id === id ? { ...w, ...patch } : w)));
  const add = () => setWebhooks([...list, { id: 'wh-' + Date.now(), name: 'Nuevo webhook', enabled: false, url: '', events: ['created'] }]);
  const del = (id: string) => setWebhooks(list.filter((w) => w.id !== id));
  const toggleEv = (w: Webhook, ev: NotifEvent) => upd(w.id, { events: w.events.includes(ev) ? w.events.filter((e) => e !== ev) : [...w.events, ev] });
  return <div className="card" style={{ padding: 16 }}>
    <p className="cfg-lead">Envía un POST JSON a una URL externa (Slack, Teams, n8n…) cuando ocurre un evento del ticket. Disparo best-effort desde el cliente; en producción se moverá a una Cloud Function.</p>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {list.length === 0 && <div className="empty">Sin webhooks.</div>}
      {list.map((w) => <div key={w.id} className="rule-card">
        <div className="rule-h">
          <label className="switch"><input type="checkbox" checked={w.enabled} onChange={(e) => upd(w.id, { enabled: e.target.checked })} /><span className="track" /></label>
          <input style={{ flex: 1, fontWeight: 600 }} value={w.name} onChange={(e) => upd(w.id, { name: e.target.value })} placeholder="Nombre" />
          <button className="xbtn" style={{ color: 'var(--crit)' }} onClick={() => del(w.id)} aria-label="Eliminar">✕</button>
        </div>
        <div className="rule-body">
          <input value={w.url} onChange={(e) => upd(w.id, { url: e.target.value })} placeholder="https://hooks.slack.com/…" />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
            {NOTIF_EVENTS.map(([ev, lbl]) => <button key={ev} type="button" className={'chipsel' + (w.events.includes(ev) ? ' on' : '')} onClick={() => toggleEv(w, ev)}>{lbl}</button>)}
          </div>
        </div>
      </div>)}
    </div>
    <button className="primary" style={{ marginTop: 12 }} onClick={add}>＋ Añadir webhook</button>
  </div>;
}

function BusinessRulesAdmin({ tenant }: { tenant: TenantData }) {
  const setBusinessRules = useStore((s) => s.setBusinessRules);
  const rules = tenant.businessRules ?? [];
  const save = (list: BusinessRule[]) => setBusinessRules(list);
  const upd = (id: string, patch: Partial<BusinessRule>) => save(rules.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const add = () => save([...rules, { id: 'br-' + Date.now(), name: 'Nueva regla', enabled: false, match: 'all', conditions: [{ field: 'category', op: 'eq', value: '' }], actions: [{ type: 'setGroup', value: '' }] }]);
  const del = (id: string) => save(rules.filter((r) => r.id !== id));
  // valor de una acción según su tipo
  const actionValues = (type: RuleActionType): [string, string][] => {
    if (type === 'setPriority') return (tenant.picklists?.priority ?? []).map((p) => [p.name, p.name]);
    if (type === 'setGroup') return tenant.groups.map((g) => [g.id, g.name]);
    if (type === 'setStatus') return (tenant.statuses ?? []).map((s) => [s.name, s.name]);
    if (type === 'assignTo') return tenant.members.filter((m) => m.role !== 'requester').map((m) => [m.uid, m.name]);
    return [];
  };
  return <div className="card" style={{ padding: 16 }}>
    <p className="cfg-lead">Al crear una solicitud, si se cumplen las condiciones se aplican las acciones (enrutar a grupo, fijar prioridad/estado, asignar técnico). Las reglas se evalúan en orden.</p>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {rules.length === 0 && <div className="empty">Sin reglas de negocio.</div>}
      {rules.map((r) => <div key={r.id} className="rule-card">
        <div className="rule-h">
          <label className="switch"><input type="checkbox" checked={r.enabled} onChange={(e) => upd(r.id, { enabled: e.target.checked })} /><span className="track" /></label>
          <input style={{ flex: 1, fontWeight: 600 }} value={r.name} onChange={(e) => upd(r.id, { name: e.target.value })} />
          <button className="xbtn" style={{ color: 'var(--crit)' }} onClick={() => del(r.id)} aria-label="Eliminar">✕</button>
        </div>
        <div className="rule-body">
          <div className="rule-row"><span className="rule-lbl">Si</span>
            <select value={r.match} onChange={(e) => upd(r.id, { match: e.target.value as 'all' | 'any' })}><option value="all">se cumplen TODAS</option><option value="any">se cumple ALGUNA</option></select>
          </div>
          {r.conditions.map((c, i) => <div key={i} className="rule-row cond">
            <select value={c.field} onChange={(e) => { const cs = [...r.conditions]; cs[i] = { ...c, field: e.target.value }; upd(r.id, { conditions: cs }); }}>{RULE_FIELDS.map(([f, l]) => <option key={f} value={f}>{l}</option>)}</select>
            <select value={c.op} onChange={(e) => { const cs = [...r.conditions]; cs[i] = { ...c, op: e.target.value as typeof c.op }; upd(r.id, { conditions: cs }); }}>{RULE_OPS.map(([o, l]) => <option key={o} value={o}>{l}</option>)}</select>
            {c.op !== 'empty' && c.op !== 'notempty' && <input value={c.value ?? ''} placeholder="valor" onChange={(e) => { const cs = [...r.conditions]; cs[i] = { ...c, value: e.target.value }; upd(r.id, { conditions: cs }); }} />}
            <button className="xbtn" onClick={() => upd(r.id, { conditions: r.conditions.filter((_, j) => j !== i) })} aria-label="Quitar condición">✕</button>
          </div>)}
          <button className="linkbtn" onClick={() => upd(r.id, { conditions: [...r.conditions, { field: 'category', op: 'eq', value: '' }] })}>＋ condición</button>

          <div className="rule-row" style={{ marginTop: 8 }}><span className="rule-lbl">Entonces</span></div>
          {r.actions.map((a, i) => { const vals = actionValues(a.type); return <div key={i} className="rule-row cond">
            <select value={a.type} onChange={(e) => { const as = [...r.actions]; as[i] = { type: e.target.value as RuleActionType, value: '' }; upd(r.id, { actions: as }); }}>{RULE_ACTIONS.map(([tp, l]) => <option key={tp} value={tp}>{l}</option>)}</select>
            <select value={a.value} onChange={(e) => { const as = [...r.actions]; as[i] = { ...a, value: e.target.value }; upd(r.id, { actions: as }); }}><option value="">—</option>{vals.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
            <button className="xbtn" onClick={() => upd(r.id, { actions: r.actions.filter((_, j) => j !== i) })} aria-label="Quitar acción">✕</button>
          </div>; })}
          <button className="linkbtn" onClick={() => upd(r.id, { actions: [...r.actions, { type: 'setGroup', value: '' }] })}>＋ acción</button>
        </div>
      </div>)}
    </div>
    <button className="primary" style={{ marginTop: 12 }} onClick={add}>＋ Añadir regla</button>
  </div>;
}

// Reglas del formulario: según los valores que se van rellenando, muestra/oculta,
// obliga u opciona campos. Se aplican en vivo en «Nueva solicitud».
function FormRulesAdmin({ tenant }: { tenant: TenantData }) {
  const setFormRules = useStore((s) => s.setFormRules);
  const rules = tenant.formRules ?? [];
  const save = (list: FormRule[]) => setFormRules(list);
  const upd = (id: string, patch: Partial<FormRule>) => save(rules.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const simplified = tenant.operationMode === 'simplified';
  const add = () => save([...rules, { id: 'fr-' + Date.now(), name: 'Nueva regla', enabled: false, templateIds: [], serviceCategoryIds: [], scope: 'both', match: 'all', conditions: [], actions: [] }]);
  const del = (id: string) => save(rules.filter((r) => r.id !== id));
  // campos disponibles = unión de los campos de las plantillas (clásico) o de las
  // categorías (simplificado) elegidas; vacío = todas.
  const fieldsFor = (templateIds: string[]): [string, string][] => {
    const tpls = templateIds.length ? tenant.templates.filter((t) => templateIds.includes(t.id)) : tenant.templates;
    const map = new Map<string, string>();
    for (const t of tpls) for (const f of defsOf(t)) if (!map.has(f.id)) map.set(f.id, f.label);
    return [...map.entries()];
  };
  const fieldsForCats = (catIds: string[]): [string, string][] => {
    const scs = (tenant.serviceCategories ?? []).filter((c) => !catIds.length || catIds.includes(c.id));
    const map = new Map<string, string>();
    for (const c of scs) for (const f of c.fields ?? []) if (!map.has(f.id)) map.set(f.id, f.label);
    return [...map.entries()];
  };
  const toggleTpl = (r: FormRule, id: string) => upd(r.id, { templateIds: r.templateIds.includes(id) ? r.templateIds.filter((x) => x !== id) : [...r.templateIds, id] });
  const toggleCat = (r: FormRule, id: string) => { const cur = r.serviceCategoryIds ?? []; upd(r.id, { serviceCategoryIds: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] }); };
  return <div className="card" style={{ padding: 16 }}>
    <p className="cfg-lead">Mientras se rellena el formulario, si se cumplen las condiciones se aplican las acciones sobre los campos (ocultar, hacer obligatorio, deshabilitar…). Se evalúan en vivo al cambiar cualquier campo. Ámbito por {simplified ? <b>categoría de servicio</b> : <b>plantilla(s)</b>} y por vista.</p>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {rules.length === 0 && <div className="empty">Sin reglas del formulario.</div>}
      {rules.map((r) => { const fields = simplified ? fieldsForCats(r.serviceCategoryIds ?? []) : fieldsFor(r.templateIds); return <div key={r.id} className="rule-card">
        <div className="rule-h">
          <label className="switch"><input type="checkbox" checked={r.enabled} onChange={(e) => upd(r.id, { enabled: e.target.checked })} /><span className="track" /></label>
          <input style={{ flex: 1, fontWeight: 600 }} value={r.name} onChange={(e) => upd(r.id, { name: e.target.value })} />
          <button className="xbtn" style={{ color: 'var(--crit)' }} onClick={() => del(r.id)} aria-label="Eliminar">✕</button>
        </div>
        <div className="rule-body">
          {simplified
            ? <div className="rule-row"><span className="rule-lbl">Categorías</span>
                <div className="fr-tpls">{(tenant.serviceCategories ?? []).map((sc) => <button key={sc.id} className={'chipsel' + ((r.serviceCategoryIds ?? []).includes(sc.id) ? ' on' : '')} onClick={() => toggleCat(r, sc.id)}>{sc.icon ? sc.icon + ' ' : ''}{sc.name}</button>)}
                  {(r.serviceCategoryIds ?? []).length === 0 && <span className="soft" style={{ fontSize: 12, alignSelf: 'center' }}>todas</span>}</div>
              </div>
            : <div className="rule-row"><span className="rule-lbl">Plantillas</span>
                <div className="fr-tpls">{tenant.templates.map((t) => <button key={t.id} className={'chipsel' + (r.templateIds.includes(t.id) ? ' on' : '')} onClick={() => toggleTpl(r, t.id)}>{t.name}</button>)}
                  {r.templateIds.length === 0 && <span className="soft" style={{ fontSize: 12, alignSelf: 'center' }}>todas</span>}</div>
              </div>}
          <div className="rule-row"><span className="rule-lbl">Vista</span>
            <select value={r.scope} onChange={(e) => upd(r.id, { scope: e.target.value as FormScope })}><option value="both">Técnico y solicitante</option><option value="technician">Solo técnico</option><option value="requester">Solo solicitante</option></select>
          </div>
          <div className="rule-row"><span className="rule-lbl">Si</span>
            <select value={r.match} onChange={(e) => upd(r.id, { match: e.target.value as 'all' | 'any' })}><option value="all">se cumplen TODAS</option><option value="any">se cumple ALGUNA</option></select>
          </div>
          {r.conditions.map((c, i) => <div key={i} className="rule-row cond">
            <select value={c.fieldId} onChange={(e) => { const cs = [...r.conditions]; cs[i] = { ...c, fieldId: e.target.value }; upd(r.id, { conditions: cs }); }}>{fields.map(([id, l]) => <option key={id} value={id}>{l}</option>)}</select>
            <select value={c.op} onChange={(e) => { const cs = [...r.conditions]; cs[i] = { ...c, op: e.target.value as typeof c.op }; upd(r.id, { conditions: cs }); }}>{FORM_OPS.map(([o, l]) => <option key={o} value={o}>{l}</option>)}</select>
            {c.op !== 'empty' && c.op !== 'notempty' && <input value={c.value ?? ''} placeholder="valor" onChange={(e) => { const cs = [...r.conditions]; cs[i] = { ...c, value: e.target.value }; upd(r.id, { conditions: cs }); }} />}
            <button className="xbtn" onClick={() => upd(r.id, { conditions: r.conditions.filter((_, j) => j !== i) })} aria-label="Quitar condición">✕</button>
          </div>)}
          <button className="linkbtn" onClick={() => upd(r.id, { conditions: [...r.conditions, { fieldId: fields[0]?.[0] ?? '', op: 'eq', value: '' }] })}>＋ condición</button>

          <div className="rule-row" style={{ marginTop: 8 }}><span className="rule-lbl">Entonces</span></div>
          {r.actions.map((a, i) => <div key={i} className="rule-row cond">
            <select value={a.type} onChange={(e) => { const as = [...r.actions]; as[i] = { ...a, type: e.target.value as FormActionType }; upd(r.id, { actions: as }); }}>{FORM_ACTIONS.map(([tp, l]) => <option key={tp} value={tp}>{l}</option>)}</select>
            <select value={a.fieldId} onChange={(e) => { const as = [...r.actions]; as[i] = { ...a, fieldId: e.target.value }; upd(r.id, { actions: as }); }}><option value="">—</option>{fields.map(([id, l]) => <option key={id} value={id}>{l}</option>)}</select>
            <button className="xbtn" onClick={() => upd(r.id, { actions: r.actions.filter((_, j) => j !== i) })} aria-label="Quitar acción">✕</button>
          </div>)}
          <button className="linkbtn" onClick={() => upd(r.id, { actions: [...r.actions, { type: 'hide', fieldId: fields[0]?.[0] ?? '' }] })}>＋ acción</button>
        </div>
      </div>; })}
    </div>
    <button className="primary" style={{ marginTop: 12 }} onClick={add}>＋ Añadir regla</button>
  </div>;
}

function EnablementAdmin({ tenant }: { tenant: TenantData }) {
  const setMembersEnabled = useStore((s) => s.setMembersEnabled);
  const updateMember = useStore((s) => s.updateMember);
  const [q, setQ] = useState('');
  const [grp, setGrp] = useState('');
  const members = tenant.members;
  const enabled = members.filter((m) => m.enabled).length;
  const pct = members.length ? Math.round((enabled / members.length) * 100) : 0;
  const groupMembers = (gid: string) => members.filter((m) => (m.groupIds ?? []).includes(gid));
  const shown = members.filter((m) => !q || (m.name + ' ' + m.email).toLowerCase().includes(q.toLowerCase()));
  return <div className="card" style={{ padding: 16 }}>
    <p className="cfg-lead">Marca quién trabaja ya en Atenza. Durante la convivencia el resto sigue en SDP; esta habilitación prepara el corte escalonado (por persona o por grupo de soporte). No cambia dónde llega el correo — eso es el hito de correo entrante, por instancia.</p>
    <div className="enab-bar"><span style={{ width: pct + '%' }} /></div>
    <div style={{ fontSize: 13, margin: '6px 0 16px', color: 'var(--ink-soft)' }}><b style={{ color: 'var(--ink)' }}>{enabled}</b> / {members.length} habilitados en Atenza · {pct}%</div>

    <div className="enab-bulk">
      <span style={{ fontSize: 12, color: 'var(--ink-soft)' }}>Habilitar por grupo de soporte:</span>
      <select value={grp} onChange={(e) => setGrp(e.target.value)}><option value="">Grupo…</option>{tenant.groups.map((g) => <option key={g.id} value={g.id}>{g.name} ({groupMembers(g.id).length})</option>)}</select>
      <button className="primary" disabled={!grp} onClick={() => setMembersEnabled(groupMembers(grp).map((m) => m.uid), true)}>Habilitar grupo</button>
      <button className="xbtn" disabled={!grp} onClick={() => setMembersEnabled(groupMembers(grp).map((m) => m.uid), false)}>Deshabilitar grupo</button>
    </div>

    <input style={{ width: '100%', margin: '12px 0 8px' }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar persona…" />
    <div style={{ maxHeight: 420, overflow: 'auto' }}><table className="mgmt"><thead><tr><th>Persona</th><th>Rol</th><th>Grupos</th><th style={{ textAlign: 'right' }}>En Atenza</th></tr></thead>
      <tbody>{shown.map((m) => <tr key={m.uid}>
        <td><div className="who"><Avatar m={m} /><span><span className="nm">{m.name}</span><span style={{ display: 'block', fontSize: 11, color: 'var(--ink-faint)' }}>{m.email}</span></span></div></td>
        <td style={{ fontSize: 12 }}>{m.roleName ?? m.role}</td>
        <td style={{ fontSize: 11, color: 'var(--ink-faint)' }}>{(m.groupIds ?? []).map((gid) => tenant.groups.find((g) => g.id === gid)?.name).filter(Boolean).join(', ') || '—'}</td>
        <td style={{ textAlign: 'right' }}><label className="switch"><input type="checkbox" checked={!!m.enabled} onChange={(e) => updateMember(m.uid, { enabled: e.target.checked })} /><span className="track" /></label></td>
      </tr>)}</tbody></table></div>
  </div>;
}

function ClosureAdmin({ tenant }: { tenant: TenantData }) {
  const setClosureRules = useStore((s) => s.setClosureRules);
  const rules: ClosureRules = tenant.closureRules ?? {};
  return <div className="card" style={{ padding: 16 }}>
    <p className="cfg-lead">Requisitos que un ticket debe cumplir antes de pasar a un estado <b>Completado</b> (Resuelta/Cerrada). No aplican a «Cancelada».</p>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {CLOSURE_RULE_LABELS.map(([key, label]) => <label key={key} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
        <input type="checkbox" checked={!!rules[key]} onChange={(e) => setClosureRules({ ...rules, [key]: e.target.checked })} />
        {label}
      </label>)}
    </div>
  </div>;
}

function ReplyTemplatesAdmin({ tenant }: { tenant: TenantData }) {
  const setReplyTemplates = useStore((s) => s.setReplyTemplates);
  const list = tenant.replyTemplates ?? [];
  const upd = (id: string, patch: Partial<ReplyTemplate>) => setReplyTemplates(list.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const add = () => setReplyTemplates([...list, { id: 'rt-' + Date.now(), title: 'Nueva respuesta', body: '' }]);
  const del = (id: string) => setReplyTemplates(list.filter((x) => x.id !== id));
  return <div className="card" style={{ padding: 16 }}>
    <p className="cfg-lead">Textos reutilizables que el técnico inserta en el hilo de conversación.</p>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {list.length === 0 && <div className="empty">Sin respuestas predefinidas.</div>}
      {list.map((rt) => <div key={rt.id} className="rt-card">
        <div style={{ display: 'flex', gap: 8 }}>
          <input style={{ flex: 1, fontWeight: 600 }} value={rt.title} onChange={(e) => upd(rt.id, { title: e.target.value })} placeholder="Título" />
          <button className="xbtn" style={{ color: 'var(--crit)' }} onClick={() => del(rt.id)} aria-label="Eliminar">✕</button>
        </div>
        <textarea rows={3} value={rt.body} onChange={(e) => upd(rt.id, { body: e.target.value })} placeholder="Texto de la respuesta…" style={{ width: '100%', marginTop: 6 }} />
      </div>)}
    </div>
    <button className="primary" style={{ marginTop: 10 }} onClick={add}>＋ Añadir respuesta</button>
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
  const [openG, setOpenG] = useState<string | null>(null);
  const groupTechs = (gid: string) => tenant.members.filter((m) => (m.groupIds ?? []).includes(gid));
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
        {tenant.groups.map((g) => { const techs = groupTechs(g.id); const open = openG === g.id; return <div key={g.id}>
          <div className="lcstate">
            <button className="ghost" style={{ flex: 1, textAlign: 'left', fontSize: 13, display: 'flex', gap: 8, alignItems: 'center' }} onClick={() => setOpenG(open ? null : g.id)} title="Ver técnicos">
              <span style={{ color: 'var(--ink-faint)', width: 10 }}>{open ? '▾' : '▸'}</span>{g.name}
              <span className="pill" style={{ marginLeft: 'auto' }}>{techs.length} {techs.length === 1 ? 'técnico' : 'técnicos'}</span>
            </button>
            <button className="ghost" style={{ color: 'var(--crit)' }} onClick={() => removeGroup(g.id)}>🗑</button>
          </div>
          {open && <div style={{ padding: '4px 0 8px 26px', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {techs.length === 0 ? <span className="empty" style={{ fontSize: 12 }}>Sin técnicos asignados.</span>
              : techs.map((m) => <span key={m.uid} className="who" style={{ fontSize: 12 }}><Avatar m={m} /> <span className="soft">{m.name}</span></span>)}
          </div>}
        </div>; })}
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
  const setImpersonate = useStore((s) => s.setImpersonate);
  const [name, setName] = useState(''); const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('technician');
  const [openUg, setOpenUg] = useState<string | null>(null);
  const ugOptions = tenant.userGroups ?? [];
  const roleLabel: Record<Role, string> = { tenant_admin: 'Admin', technician: 'Técnico', requester: 'Solicitante' };
  const statusLabel: Record<string, string> = { active: 'Activo', invited: 'Invitado', disabled: 'Deshabilitado' };
  const corp = tenant.members[0]?.email.split('@')[1] ?? 'digloservicer.com';
  return <div className="card"><h2>Miembros <span className="badge">{tenant.members.length}</span></h2>
    <div className="banner" style={{ marginTop: 4 }}>Gestiona el acceso a esta instancia. El <b>onboarding real</b> (invitaciones por correo) se activará en producción; aquí defines rol, estado y quién es externo.</div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 12 }}>
      {tenant.members.map((m) => <Fragment key={m.uid}>
        <div className="lcstate">
          <span className="sdot" style={{ background: m.color }} />
          <span style={{ flex: 1, minWidth: 0 }}><b style={{ fontSize: 13 }}>{m.name}</b> <span style={{ color: 'var(--ink-soft)', fontSize: 12 }}>{m.email}</span>{m.external && <span className="pill" style={{ marginLeft: 6 }}>externo</span>}</span>
          {ugOptions.length > 0 && <button className="ghost" style={{ fontSize: 11.5 }} onClick={() => setOpenUg(openUg === m.uid ? null : m.uid)}>grupos ({(m.userGroups ?? []).length})</button>}
          {(tenant.roles ?? []).length > 0
            ? <select value={m.roleName ?? ''} onChange={(e) => { const rd = (tenant.roles ?? []).find((r) => r.name === e.target.value); if (rd) updateMember(m.uid, { roleName: rd.name, role: rd.base }); }} style={{ fontSize: 12 }} title={'Nivel: ' + roleLabel[m.role]}>
                <option value="">{roleLabel[m.role]} (base)</option>
                {(tenant.roles ?? []).map((r) => <option key={r.name} value={r.name}>{r.name}</option>)}
              </select>
            : <select value={m.role} onChange={(e) => updateMember(m.uid, { role: e.target.value as Role })} style={{ fontSize: 12 }}>
                {(['tenant_admin', 'technician', 'requester'] as Role[]).map((r) => <option key={r} value={r}>{roleLabel[r]}</option>)}
              </select>}
          <select value={m.status} onChange={(e) => updateMember(m.uid, { status: e.target.value as UiMember['status'] })} style={{ fontSize: 12 }}>
            {['active', 'invited', 'disabled'].map((s) => <option key={s} value={s}>{statusLabel[s]}</option>)}
          </select>
          <button className="ghost" title="Ver el portal como este usuario (solo lectura)" onClick={() => setImpersonate(m.uid)}>👁 Ver como</button>
          <button className="ghost" style={{ color: 'var(--crit)' }} onClick={() => removeMember(m.uid)}>🗑</button>
        </div>
        {openUg === m.uid && <div style={{ padding: '2px 0 10px 26px' }}><div className="k">Grupos de usuarios</div><ChipMulti options={ugOptions} selected={m.userGroups ?? []} onChange={(ug) => updateMember(m.uid, { userGroups: ug })} /></div>}
      </Fragment>)}
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

// Clasifica un campo del formulario por su etiqueta hacia un "campo de sistema"
// (con control estructurado propio) o 'custom' (campo adicional/UDF genérico).
// 'skip' = campo que no se rellena al crear (técnico, estado, fechas…).
type SysRole = 'subject' | 'description' | 'category' | 'subcategory' | 'item' | 'priority' | 'impact' | 'urgency' | 'mode' | 'site' | 'requester' | 'custom' | 'skip';
const normLbl = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
function sysRoleOf(label: string): SysRole {
  const n = normLbl(label);
  if (/categoria de servicio|service category/.test(n)) return 'skip';
  if (/(asunto|titulo|subject|resumen|title)/.test(n)) return 'subject';
  if (/(descripcion|description|detalle)/.test(n)) return 'description';
  if (/(subcategoria|subcategory)/.test(n)) return 'subcategory';
  if (/(categoria|category|clasificacion)/.test(n)) return 'category';
  if (/(articulo|elemento|\bitem\b)/.test(n)) return 'item';
  if (/(prioridad|priority)/.test(n)) return 'priority';
  if (/(impacto|impact)/.test(n)) return 'impact';
  if (/(urgencia|urgency)/.test(n)) return 'urgency';
  if (/(\bmodo\b|request mode|\bmode\b)/.test(n)) return 'mode';
  if (/(\bsede\b|\bsite\b|ubicacion|location|localizacion)/.test(n)) return 'site';
  if (/(solicitante|requester|reportad|reporter)/.test(n)) return 'requester';
  if (/(tecnico|technician|asignad|assignee|grupo|group|estado|status|\bnivel\b|\blevel\b|cread|created|resuelt|resolved|cerrad|closed|fecha)/.test(n)) return 'skip';
  return 'custom';
}
const DEF_SEC = 'Detalles de la solicitud';
const secOf = (f: FieldDef) => f.section || DEF_SEC;

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
  const adminTemplateId = useStore((s) => s.adminTemplateId);
  const setAdminTemplate = useStore((s) => s.setAdminTemplate);
  const [sel, setSel] = useState<string | null>(adminTemplateId ?? tenant.templates[0]?.id ?? null);
  useEffect(() => { if (adminTemplateId) { setSel(adminTemplateId); setAdminTemplate(null); } }, [adminTemplateId, setAdminTemplate]);
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

const pvInput = (f: FieldDef) => {
  if (f.type === 'textarea') return f.label.toLowerCase().startsWith('descrip')
    ? <div className="pv-rte"><div className="pv-bar"><b>B</b> <i>I</i> <u>U</u><span style={{ opacity: .5 }}> · 🔗 🖼</span></div><div className="pv-area" /></div>
    : <div className="pv-inp tall" />;
  if (f.type === 'bool') return <div className="pv-inp">◯ Sí&nbsp;&nbsp;&nbsp;◯ No</div>;
  if (f.type === 'select' || f.type === 'reference') return <div className="pv-inp">Seleccionar… <span className="chev">▾</span></div>;
  if (f.type === 'person') return <div className="pv-inp">Seleccionar persona… <span className="chev">▾</span></div>;
  if (f.type === 'attachment') return <div className="pv-inp">📎 Adjuntar archivo</div>;
  if (f.type === 'date') return <div className="pv-inp">dd/mm/aaaa</div>;
  if (f.type === 'number') return <div className="pv-inp mono">0</div>;
  return <div className="pv-inp" />;
};

function TemplateEditor({ tenant, tpl, onDeleted }: { tenant: TenantData; tpl: Template; onDeleted: () => void }) {
  const updateTemplate = useStore((s) => s.updateTemplate);
  const removeTemplate = useStore((s) => s.removeTemplate);
  const setTemplateFields = useStore((s) => s.setTemplateFields);
  const defs = defsOf(tpl);
  const commit = (next: FieldDef[]) => setTemplateFields(tpl.id, next);
  const [nf, setNf] = useState('');
  const [nft, setNft] = useState<FieldType>('text');
  const [ntask, setNtask] = useState('');
  const [nsec, setNsec] = useState('');
  const [ncol, setNcol] = useState<1 | 2>(1);
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [view, setView] = useState<'tech' | 'req' | 'tasks' | 'approvals' | 'checklist'>('tech');
  const [showPrev, setShowPrev] = useState(false);
  const [palTab, setPalTab] = useState<'avail' | 'new'>('avail');
  const [palQ, setPalQ] = useState('');
  const [palDrag, setPalDrag] = useState<{ kind: 'type' | 'catalog'; value: string } | null>(null);
  const TYPE_LABEL: Record<string, string> = Object.fromEntries(FIELD_TYPES);
  // añade un campo nuevo (desde la paleta: tipo o campo del catálogo) a una posición.
  const addFromPalette = (section: string, col: 1 | 2, full: boolean, beforeId?: string) => {
    if (!palDrag) return;
    let nfld: FieldDef;
    if (palDrag.kind === 'catalog') { const cf = (tenant.customFields ?? []).find((x) => x.id === palDrag.value); if (!cf) return; nfld = { ...cf, id: 'f-' + Date.now(), section, col, full: full || undefined }; }
    else nfld = { id: 'f-' + Date.now(), label: 'Nuevo ' + (TYPE_LABEL[palDrag.value] ?? 'campo').toLowerCase(), type: palDrag.value as FieldType, requesterVisible: true, section, col, full: full || undefined };
    const arr = defs.slice();
    if (beforeId) { let bi = arr.findIndex((x) => x.id === beforeId); if (bi < 0) bi = arr.length; arr.splice(bi, 0, nfld); } else arr.push(nfld);
    commit(arr); setPalDrag(null); setOver(null);
  };

  const secOf = (f: FieldDef) => f.section || DEF_SEC;
  const sections = defs.reduce<string[]>((a, f) => { const s = secOf(f); if (!a.includes(s)) a.push(s); return a; }, []);
  if (sections.length === 0) sections.push(DEF_SEC);
  const patch = (id: string, p: Partial<FieldDef>) => commit(defs.map((x) => (x.id === id ? { ...x, ...p } : x)));
  const del = (id: string) => commit(defs.filter((x) => x.id !== id));
  const swap = (a: string, b: string) => { const n = defs.slice(); const ia = n.findIndex((x) => x.id === a), ib = n.findIndex((x) => x.id === b); if (ia < 0 || ib < 0) return; [n[ia], n[ib]] = [n[ib]!, n[ia]!]; commit(n); };
  const colFields = (sec: string, col: 1 | 2) => defs.filter((f) => secOf(f) === sec && !f.full && (f.col === 2 ? 2 : 1) === col);
  const fullFields = (sec: string) => defs.filter((f) => secOf(f) === sec && f.full);
  const moveInCol = (f: FieldDef, dir: number) => { const sibs = colFields(secOf(f), f.col === 2 ? 2 : 1); const i = sibs.findIndex((x) => x.id === f.id); const j = i + dir; if (j < 0 || j >= sibs.length) return; swap(f.id, sibs[j]!.id); };
  const renameSection = (old: string, val: string) => commit(defs.map((x) => (secOf(x) === old ? { ...x, section: val || DEF_SEC } : x)));
  const delSection = (sec: string) => { if (confirm(`¿Eliminar la sección "${sec}" y sus campos?`)) commit(defs.filter((x) => secOf(x) !== sec)); };
  const addField = () => { if (!nf.trim()) return; commit([...defs, { id: 'f-' + Date.now(), label: nf.trim(), type: nft, requesterVisible: true, section: nsec.trim() || sections[0] || DEF_SEC, col: ncol }]); setNf(''); };
  const addSection = () => { const name = prompt('Nombre de la nueva sección:'); if (name && name.trim()) commit([...defs, { id: 'f-' + Date.now(), label: 'Campo', type: 'text', requesterVisible: true, section: name.trim(), col: 1 }]); };
  // arrastrar-soltar: reubica el campo arrastrado a sección/columna/ancho, insertando
  // antes de beforeId si se soltó sobre una tarjeta, o al final de la columna si no.
  const relocate = (dragId: string, section: string, col: 1 | 2, full: boolean, beforeId?: string) => {
    if (dragId === beforeId) return;
    const arr = defs.slice();
    const i = arr.findIndex((x) => x.id === dragId); if (i < 0) return;
    const [f] = arr.splice(i, 1);
    const moved: FieldDef = { ...f!, section, col, full: full || undefined };
    if (beforeId) { let bi = arr.findIndex((x) => x.id === beforeId); if (bi < 0) bi = arr.length; arr.splice(bi, 0, moved); } else arr.push(moved);
    commit(arr);
  };
  const catalog = (tenant.customFields ?? []).filter((cf) => !defs.some((d) => d.label === cf.label));

  const fcard = (f: FieldDef) => <div key={f.id} className="fcard" draggable
    onDragStart={(e) => { setDrag(f.id); e.dataTransfer.effectAllowed = 'move'; }}
    onDragEnd={() => { setDrag(null); setOver(null); }}
    onDragOver={(e) => { if ((drag && drag !== f.id) || palDrag) { e.preventDefault(); e.stopPropagation(); } }}
    onDrop={(e) => { if (palDrag) { e.preventDefault(); e.stopPropagation(); addFromPalette(secOf(f), f.col === 2 ? 2 : 1, !!f.full, f.id); } else if (drag) { e.preventDefault(); e.stopPropagation(); relocate(drag, secOf(f), f.col === 2 ? 2 : 1, !!f.full, f.id); setDrag(null); setOver(null); } }}>
    <div className="fcard-top">
      <span className="fgrip" title="Arrastrar">⠿</span>
      <input className="fname" value={f.label} onChange={(e) => patch(f.id, { label: e.target.value })} />
      {f.mandatory && <span className="freq" title="Obligatorio">*</span>}
      <button className="xbtn" onClick={() => del(f.id)} aria-label="Eliminar campo">✕</button>
    </div>
    <div className="fcard-pv">{pvInput(f)}</div>
    <div className="fcard-tools">
      <select className="ftype" value={f.type} onChange={(e) => patch(f.id, { type: e.target.value as FieldType })}>{FIELD_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
      <button className={'ftag' + (f.mandatory ? ' on' : '')} onClick={() => patch(f.id, { mandatory: !f.mandatory })} title="Obligatorio">Oblig.</button>
      <button className={'ftag' + (f.requesterVisible !== false ? ' on' : '')} onClick={() => patch(f.id, { requesterVisible: f.requesterVisible === false })} title="Visible al solicitante">Solic.</button>
      <span style={{ flex: 1 }} />
      <button className="xbtn" onClick={() => moveInCol(f, -1)} aria-label="Subir">↑</button>
      <button className="xbtn" onClick={() => moveInCol(f, 1)} aria-label="Bajar">↓</button>
      {!f.full && <button className="xbtn" onClick={() => patch(f.id, { col: f.col === 2 ? 1 : 2 })} title="Cambiar de columna">{f.col === 2 ? '←' : '→'}</button>}
      <button className={'xbtn' + (f.full ? ' on' : '')} onClick={() => patch(f.id, { full: !f.full })} title="Ancho completo">⤢</button>
    </div>
  </div>;

  // --- Tareas predefinidas de la plantilla ---
  const taskTpls = tpl.taskTemplates ?? [];
  const saveTasks = (list: TaskTemplate[]) => updateTemplate(tpl.id, { taskTemplates: list });
  const addTaskTpl = () => { if (!ntask.trim()) return; saveTasks([...taskTpls, { id: 'tt-' + Date.now(), text: ntask.trim() }]); setNtask(''); };
  const updTaskTpl = (id: string, patch: Partial<TaskTemplate>) => saveTasks(taskTpls.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const delTaskTpl = (id: string) => saveTasks(taskTpls.filter((x) => x.id !== id));
  const moveTaskTpl = (i: number, dir: number) => { const j = i + dir; if (j < 0 || j >= taskTpls.length) return; const n = [...taskTpls]; [n[i], n[j]] = [n[j]!, n[i]!]; saveTasks(n); };

  // --- Niveles de aprobación predefinidos de la plantilla ---
  const apprLevels = tpl.approvalLevels ?? [];
  const saveAppr = (list: ApprovalLevelDef[]) => updateTemplate(tpl.id, { approvalLevels: list });
  const addApprLevel = () => saveAppr([...apprLevels, { id: 'al-' + Date.now(), name: `Nivel ${apprLevels.length + 1}`, approverUids: [], rule: 'any' }]);
  const updApprLevel = (id: string, patch: Partial<ApprovalLevelDef>) => saveAppr(apprLevels.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const delApprLevel = (id: string) => saveAppr(apprLevels.filter((x) => x.id !== id));
  const moveApprLevel = (i: number, dir: number) => { const j = i + dir; if (j < 0 || j >= apprLevels.length) return; const n = [...apprLevels]; [n[i], n[j]] = [n[j]!, n[i]!]; saveAppr(n); };
  const toggleApprover = (lv: ApprovalLevelDef, uid: string) => updApprLevel(lv.id, { approverUids: lv.approverUids.includes(uid) ? lv.approverUids.filter((x) => x !== uid) : [...lv.approverUids, uid] });
  const approverPool = tenant.members.filter((m) => m.role !== 'requester');

  // --- Lista de comprobación predefinida de la plantilla ---
  const checkItems = tpl.checklist ?? [];
  const [ncheck, setNcheck] = useState('');
  const saveCheck = (list: ChecklistItemDef[]) => updateTemplate(tpl.id, { checklist: list });
  const addCheck = () => { if (!ncheck.trim()) return; saveCheck([...checkItems, { id: 'ck-' + Date.now(), text: ncheck.trim() }]); setNcheck(''); };
  const updCheck = (id: string, text: string) => saveCheck(checkItems.map((x) => (x.id === id ? { ...x, text } : x)));
  const delCheck = (id: string) => saveCheck(checkItems.filter((x) => x.id !== id));
  const moveCheck = (i: number, dir: number) => { const j = i + dir; if (j < 0 || j >= checkItems.length) return; const n = [...checkItems]; [n[i], n[j]] = [n[j]!, n[i]!]; saveCheck(n); };

  return <div className="card te">
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

    {(tenant.userGroups ?? []).length > 0 && <div style={{ margin: '12px 0 4px' }}>
      <div className="k">Visible para grupos de usuarios <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(vacío = la ve cualquier solicitante)</span></div>
      <ChipMulti options={tenant.userGroups ?? []} selected={tpl.userGroups ?? []} onChange={(ug) => updateTemplate(tpl.id, { userGroups: ug })} />
    </div>}

    <div className="te-tabs">
      <button className={view === 'tech' && !showPrev ? 'on' : ''} onClick={() => { setView('tech'); setShowPrev(false); }}>Vista del técnico</button>
      <button className={view === 'req' && !showPrev ? 'on' : ''} onClick={() => { setView('req'); setShowPrev(false); }}>Vista del solicitante</button>
      <button className="dim" disabled>Información de recurso<span className="soon">pronto</span></button>
      <button className={view === 'approvals' && !showPrev ? 'on' : ''} onClick={() => { setView('approvals'); setShowPrev(false); }}>Aprobaciones{(tpl.approvalLevels?.length ?? 0) > 0 && <span className="pill" style={{ marginLeft: 6 }}>{tpl.approvalLevels!.length}</span>}</button>
      <button className={view === 'tasks' && !showPrev ? 'on' : ''} onClick={() => { setView('tasks'); setShowPrev(false); }}>Tareas{(tpl.taskTemplates?.length ?? 0) > 0 && <span className="pill" style={{ marginLeft: 6 }}>{tpl.taskTemplates!.length}</span>}</button>
      <button className={view === 'checklist' && !showPrev ? 'on' : ''} onClick={() => { setView('checklist'); setShowPrev(false); }}>Listas de comprobación{(tpl.checklist?.length ?? 0) > 0 && <span className="pill" style={{ marginLeft: 6 }}>{tpl.checklist!.length}</span>}</button>
      <button className="dim" disabled>Reglas del formulario<span className="soon">pronto</span></button>
      {view !== 'tasks' && view !== 'approvals' && view !== 'checklist' && <button className="te-prev" onClick={() => setShowPrev(!showPrev)}>{showPrev ? '‹ Volver al editor' : '⤢ Vista preliminar'}</button>}
    </div>

    {view === 'tasks' ? <div className="tt-editor">
      <p className="cfg-lead">Tareas que se crean automáticamente como checklist del ticket al generarlo desde esta plantilla (como en SDP). Luego se completan/editan en la pestaña «Tareas» del ticket.</p>
      <div className="tt-list">
        {taskTpls.map((tt, i) => <div key={tt.id} className="tt-row">
          <span className="tt-num">{i + 1}</span>
          <input className="tt-text" value={tt.text} onChange={(e) => updTaskTpl(tt.id, { text: e.target.value })} placeholder="Descripción de la tarea" />
          <input className="tt-type" value={tt.type ?? ''} onChange={(e) => updTaskTpl(tt.id, { type: e.target.value || undefined })} placeholder="Tipo (opcional)" />
          <input className="tt-hours" type="number" min={0} step={0.5} value={tt.estimatedHours ?? ''} onChange={(e) => updTaskTpl(tt.id, { estimatedHours: e.target.value === '' ? undefined : Number(e.target.value) })} placeholder="h" title="Horas estimadas (para la carga en OrganiZate)" />
          <button className="xbtn" onClick={() => moveTaskTpl(i, -1)} disabled={i === 0} aria-label="Subir">↑</button>
          <button className="xbtn" onClick={() => moveTaskTpl(i, 1)} disabled={i === taskTpls.length - 1} aria-label="Bajar">↓</button>
          <button className="xbtn" style={{ color: 'var(--crit)' }} onClick={() => delTaskTpl(tt.id)} aria-label="Eliminar">✕</button>
        </div>)}
        {taskTpls.length === 0 && <div className="empty">Sin tareas predefinidas. Añade la primera abajo.</div>}
      </div>
      <div className="tt-add">
        <input value={ntask} onChange={(e) => setNtask(e.target.value)} placeholder="Nueva tarea…" onKeyDown={(e) => { if (e.key === 'Enter') addTaskTpl(); }} />
        <button className="primary" onClick={addTaskTpl} disabled={!ntask.trim()}>＋ Añadir tarea</button>
      </div>
    </div> : view === 'approvals' ? <div className="tt-editor">
      <p className="cfg-lead">Niveles de aprobación que se crean al generar un ticket desde esta plantilla (como en SDP). Mientras haya aprobaciones pendientes, el ticket arranca en «Pendiente Aprobación». Se resuelven en la pestaña «Aprobaciones» del ticket.</p>
      <div className="al-list">
        {apprLevels.map((lv, i) => <div key={lv.id} className="al-card">
          <div className="al-head">
            <span className="tt-num">{i + 1}</span>
            <input className="tt-text" value={lv.name} onChange={(e) => updApprLevel(lv.id, { name: e.target.value })} placeholder="Nombre del nivel" />
            <select value={lv.rule} onChange={(e) => updApprLevel(lv.id, { rule: e.target.value as 'any' | 'all' })} title="Regla de decisión"><option value="any">Basta con uno</option><option value="all">Deben aprobar todos</option></select>
            <button className="xbtn" onClick={() => moveApprLevel(i, -1)} disabled={i === 0} aria-label="Subir">↑</button>
            <button className="xbtn" onClick={() => moveApprLevel(i, 1)} disabled={i === apprLevels.length - 1} aria-label="Bajar">↓</button>
            <button className="xbtn" style={{ color: 'var(--crit)' }} onClick={() => delApprLevel(lv.id)} aria-label="Eliminar">✕</button>
          </div>
          <div className="al-approvers">
            <span className="soft" style={{ fontSize: 12 }}>Aprobadores:</span>
            {approverPool.map((m) => <button key={m.uid} className={'chipsel' + (lv.approverUids.includes(m.uid) ? ' on' : '')} onClick={() => toggleApprover(lv, m.uid)}>{m.name}</button>)}
            {lv.approverUids.length === 0 && <span className="soft" style={{ fontSize: 11, color: 'var(--crit)' }}>sin aprobadores → el nivel no hará nada</span>}
          </div>
        </div>)}
        {apprLevels.length === 0 && <div className="empty">Sin niveles de aprobación. Esta plantilla no requiere visto bueno.</div>}
      </div>
      <button className="primary" style={{ marginTop: 10 }} onClick={addApprLevel}>＋ Añadir nivel de aprobación</button>
    </div> : view === 'checklist' ? <div className="tt-editor">
      <p className="cfg-lead">Lista de comprobación que se instancia en el ticket al crearlo (verificación ligera, sin responsable ni horas). Distinta de las Tareas.</p>
      <label className="te-vis" style={{ marginBottom: 8 }}><span>Bloquear el cierre hasta completar la lista</span><button className={'toggle' + (tpl.checklistGate ? ' on' : '')} onClick={() => updateTemplate(tpl.id, { checklistGate: !tpl.checklistGate })} aria-label="Bloquear cierre" /></label>
      <div className="tt-list">
        {checkItems.map((c, i) => <div key={c.id} className="tt-row">
          <span className="tt-num">✓</span>
          <input className="tt-text" value={c.text} onChange={(e) => updCheck(c.id, e.target.value)} placeholder="Punto a comprobar" />
          <button className="xbtn" onClick={() => moveCheck(i, -1)} disabled={i === 0} aria-label="Subir">↑</button>
          <button className="xbtn" onClick={() => moveCheck(i, 1)} disabled={i === checkItems.length - 1} aria-label="Bajar">↓</button>
          <button className="xbtn" style={{ color: 'var(--crit)' }} onClick={() => delCheck(c.id)} aria-label="Eliminar">✕</button>
        </div>)}
        {checkItems.length === 0 && <div className="empty">Sin puntos de comprobación.</div>}
      </div>
      <div className="tt-add">
        <input value={ncheck} onChange={(e) => setNcheck(e.target.value)} placeholder="Nuevo punto…" onKeyDown={(e) => { if (e.key === 'Enter') addCheck(); }} />
        <button className="primary" onClick={addCheck} disabled={!ncheck.trim()}>＋ Añadir punto</button>
      </div>
    </div> : <div className="fbx2">
      <div className="fbx-canvas">
        {showPrev
          ? <div className="preview">
              <div className="pv-head">Vista preliminar · {view === 'tech' ? 'formulario del técnico' : 'formulario del solicitante'}</div>
              <div className="pv-body">
                {sections.map((sec) => { const vis = defs.filter((f) => secOf(f) === sec && (view === 'tech' || f.requesterVisible !== false)); if (vis.length === 0) return null; return <div key={sec} className="pv-sec">
                  <div className="pv-sec-t">{sec}</div>
                  <div className="pv2">
                    {([1, 2] as const).map((col) => <div key={col} className="pv2col">
                      {vis.filter((f) => !f.full && (f.col === 2 ? 2 : 1) === col).map((f) => <div key={f.id} className="pv-field"><label>{f.label}{f.mandatory && <span className="pv-req"> *</span>}</label>{pvInput(f)}</div>)}
                    </div>)}
                    {vis.filter((f) => f.full).map((f) => <div key={f.id} className="pv-field full"><label>{f.label}{f.mandatory && <span className="pv-req"> *</span>}</label>{pvInput(f)}</div>)}
                  </div>
                </div>; })}
                {defs.filter((f) => view === 'tech' || f.requesterVisible !== false).length === 0 && <div className="empty">Sin campos visibles en esta vista.</div>}
              </div>
            </div>
          : <>
            {view === 'req' && <div className="banner" style={{ marginBottom: 10 }}>Editando la <b>vista del solicitante</b>: solo se muestran los campos marcados como visibles para el solicitante.</div>}
            {sections.map((sec) => { const vf = (arr: FieldDef[]) => view === 'tech' ? arr : arr.filter((f) => f.requesterVisible !== false); return <div key={sec} className="fsec">
              <div className="fsec-h">
                <span className="fgrip" title="Sección">⠿</span>
                <input className="fsec-name" value={sec} onChange={(e) => renameSection(sec, e.target.value)} />
                {sections.length > 1 && <button className="xbtn" onClick={() => delSection(sec)} aria-label="Eliminar sección">🗑</button>}
              </div>
              <div className="fcols">
                {([1, 2] as const).map((col) => { const key = `${sec}|${col}`; return <div key={col}
                  className={'fcol' + (over === key && (drag || palDrag) ? ' dragover' : '')}
                  onDragOver={(e) => { if (drag || palDrag) { e.preventDefault(); setOver(key); } }}
                  onDragLeave={() => setOver((o) => (o === key ? null : o))}
                  onDrop={(e) => { if (palDrag) { e.preventDefault(); addFromPalette(sec, col, false); } else if (drag) { e.preventDefault(); relocate(drag, sec, col, false); setDrag(null); setOver(null); } }}>
                  <div className="fcol-h">Columna {col === 1 ? 'izquierda' : 'derecha'}</div>
                  {vf(colFields(sec, col)).map(fcard)}
                  {vf(colFields(sec, col)).length === 0 && <div className="fcol-empty">Suelta un campo aquí</div>}
                </div>; })}
              </div>
              <div className={'ffull' + (over === `${sec}|full` && (drag || palDrag) ? ' dragover' : '')}
                onDragOver={(e) => { if (drag || palDrag) { e.preventDefault(); setOver(`${sec}|full`); } }}
                onDragLeave={() => setOver((o) => (o === `${sec}|full` ? null : o))}
                onDrop={(e) => { if (palDrag) { e.preventDefault(); addFromPalette(sec, 1, true); } else if (drag) { e.preventDefault(); relocate(drag, sec, 1, true); setDrag(null); setOver(null); } }}>
                <div className="fcol-h">Ancho completo</div>
                {vf(fullFields(sec)).map(fcard)}
                {vf(fullFields(sec)).length === 0 && <div className="fcol-empty">Suelta aquí para ancho completo</div>}
              </div>
            </div>; })}
            <button className="ghost" style={{ marginTop: 6 }} onClick={addSection}>＋ Nueva sección</button>
          </>}
      </div>

      <aside className="fbx-pal">
        <div className="pal-h">Arrastrar y soltar campos</div>
        <div className="pal-tabs">
          <button className={palTab === 'avail' ? 'on' : ''} onClick={() => setPalTab('avail')}>Disponible</button>
          <button className={palTab === 'new' ? 'on' : ''} onClick={() => setPalTab('new')}>Nuevo</button>
        </div>
        {palTab === 'avail' ? <>
          <input className="pal-q" value={palQ} onChange={(e) => setPalQ(e.target.value)} placeholder="Buscar campo…" />
          <div className="pal-list">
            <div className="pal-g">Tipos de campo</div>
            {FIELD_TYPES.filter(([, l]) => l.toLowerCase().includes(palQ.toLowerCase())).map(([v, l]) => <div key={v} className="pal-item" draggable onDragStart={() => setPalDrag({ kind: 'type', value: v })} onDragEnd={() => { setPalDrag(null); setOver(null); }}><span className="fgrip">⠿</span>{l}</div>)}
            <div className="pal-g">Campos adicionales del catálogo</div>
            {catalog.filter((cf) => cf.label.toLowerCase().includes(palQ.toLowerCase())).map((cf) => <div key={cf.id} className="pal-item cf" draggable onDragStart={() => setPalDrag({ kind: 'catalog', value: cf.id })} onDragEnd={() => { setPalDrag(null); setOver(null); }}><span className="fgrip">⠿</span>{cf.label}</div>)}
            {catalog.length === 0 && <div className="fcol-empty" style={{ fontSize: 11 }}>Todos los campos del catálogo ya están en el formulario. Créalos en «Campos adicionales».</div>}
          </div>
        </> : <div className="pal-new">
          <input value={nf} onChange={(e) => setNf(e.target.value)} placeholder="Etiqueta del campo…" />
          <select value={nft} onChange={(e) => setNft(e.target.value as FieldType)}>{FIELD_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          <select value={nsec} onChange={(e) => setNsec(e.target.value)} title="Sección">{sections.map((s) => <option key={s} value={s}>{s}</option>)}</select>
          <select value={ncol} onChange={(e) => setNcol(Number(e.target.value) as 1 | 2)} title="Columna"><option value={1}>Columna izquierda</option><option value={2}>Columna derecha</option></select>
          <button className="primary" onClick={addField} disabled={!nf.trim()}>＋ Añadir al formulario</button>
          <div className="fcol-empty" style={{ fontSize: 11, textAlign: 'left' }}>O arrastra un tipo desde «Disponible» al canvas.</div>
        </div>}
      </aside>
    </div>}
  </div>;
}
