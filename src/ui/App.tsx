import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, Background, BackgroundVariant, Controls, MiniMap, Handle, Position, MarkerType, Panel,
  useNodesState, useEdgesState, type Node, type Edge, type Connection, type NodeProps, type ReactFlowInstance,
} from '@xyflow/react';
import { useStore, buildUser, tenantsForUser, lifecycleOfTicket, type Role } from './store.js';
import { firebaseEnabled } from '../firebase.js';
import { useAuth, doSignOut } from '../auth/auth.js';
import { Login } from './Login.js';
import { Icon } from './Icon.js';
import { stateOf } from '../lifecycle.js';
import { slaStatus } from '../sla.js';
import { isClosingStatus, closureBlockers, CLOSURE_RULE_LABELS, type ClosureRules } from '../closure.js';
import { madridHolidayDates } from '../holidays.js';
import { RULE_FIELDS, RULE_OPS, RULE_ACTIONS, type BusinessRule, type RuleActionType } from '../rules.js';
import { FORM_OPS, FORM_ACTIONS, evaluateFormRules, type FormRule, type FormActionType, type FormScope, type FieldEffects } from '../formrules.js';
import type { SlaCategory, Stage, Template, FieldDef, FieldType, ReplyTemplate, NotifEvent, TaskTemplate, ApprovalLevelDef, ChecklistItemDef, Asset, AssetStatus } from '../model.js';
import { isArchivedStatus, ASSET_STATUS, ASSET_TYPES, assetStatusView } from '../model.js';
import { queryArchive, getTicketById, type ArchiveCursor } from '../data/firestore.js';
import type { Webhook } from '../webhooks.js';
import { searchKb, type KbArticle } from '../kb.js';
import { visibleAnnouncements, type Announcement, type Audience } from '../announce.js';
import { auditLabel } from '../audit.js';
import { parseInbound } from '../inbound.js';
import { DEFAULT_CAPS, CAP_LIST, type TenantData, type StoredTicket, type UiMember, type Capacity, type Picklists, type PickVal, type RoleDef, type RoleBase, type Cap, type Branding } from '../data/seed.js';

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
// Rótulo de campo: etiqueta + asterisk de obligatorio EN LA MISMA LÍNEA (un único
// item flex del label, para que no caiga a una fila aparte). El widget va debajo.
function fcap(label: import('react').ReactNode, required?: boolean): import('react').ReactNode {
  return <span className="nf-cap">{label}{required && <span className="req" title="Obligatorio">*</span>}</span>;
}
// Sede por defecto de una nueva solicitud: «Base Site» si existe (default de SDP), si
// no la primera sede configurada, si no cadena vacía.
function defaultSite(tenant: TenantData): string {
  const sites = tenant.sites ?? [];
  return sites.find((s) => s.toLowerCase() === 'base site') ?? sites[0] ?? '';
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
      <button type="button" tabIndex={-1} onMouseDown={(e) => { e.preventDefault(); const u = prompt('URL del enlace:'); if (u) exec('createLink', u); }} title="Enlace"><Icon name="link" size={14} /></button>
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
// Flujo por DEFECTO para categorías SIN ciclo de vida: Abierta → En curso →
// Cerrada/Cancelada. Devuelve los estados alcanzables desde el actual.
const NOFLOW_STATES = ['Abierta', 'En curso', 'Cerrada', 'Cancelada'];
const NOFLOW_NEXT: Record<string, string[]> = { 'Abierta': ['En curso', 'Cancelada'], 'En curso': ['Cerrada', 'Cancelada'], 'Cerrada': ['Abierta'], 'Cancelada': ['Abierta'] };
const noFlowNext = (status: string): string[] => NOFLOW_NEXT[status] ?? NOFLOW_STATES.filter((s) => s !== status);
// Etiqueta + icono del TIPO de ticket (uniforme en toda la app).
const typeLabel = (t: string) => (t === 'incident' ? 'Incidencia' : 'Petición');
const typeIcon = (t: string, size = 13) => <Icon name={t === 'incident' ? 'wrench' : 'inbox'} size={size} />;
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

/** Selector de activos afectados: chips de los elegidos + desplegable para añadir
 *  (solo los aún no añadidos, alfabético). Guarda ids de activos. */
function AssetPicker({ tenant, value, onChange, disabled, suggest }: { tenant: TenantData; value: string[]; onChange: (ids: string[]) => void; disabled?: boolean; suggest?: Asset[] }) {
  const assets = tenant.assets ?? [];
  const byId = (id: string) => assets.find((a) => a.id === id);
  const avail = assets.filter((a) => !value.includes(a.id)).sort((a, b) => a.name.localeCompare(b.name, 'es'));
  const sug = (suggest ?? []).filter((a) => !value.includes(a.id));
  return <div className="assetpick">
    {value.length > 0 && <div className="ap-chips">{value.map((id) => { const a = byId(id); return <span key={id} className="ap-chip">{a ? a.name : id}{a?.tag ? <span className="ap-tag">{a.tag}</span> : null}{!disabled && <button type="button" onClick={() => onChange(value.filter((x) => x !== id))} aria-label="Quitar">×</button>}</span>; })}</div>}
    {!disabled && (assets.length === 0
      ? <span className="soft" style={{ fontSize: 12.5 }}>No hay activos en el inventario todavía.</span>
      : <select value="" onChange={(e) => { if (e.target.value) onChange([...value, e.target.value]); }}>
        <option value="">＋ Añadir activo…</option>
        {avail.map((a) => <option key={a.id} value={a.id}>{a.name}{a.tag ? ` · ${a.tag}` : ''}</option>)}
      </select>)}
    {!disabled && sug.length > 0 && <div className="ap-sug"><span className="ap-sug-l">Del solicitante:</span>{sug.map((a) => <button key={a.id} type="button" className="ap-sugbtn" onClick={() => onChange([...value, a.id])} title="Añadir activo del solicitante">＋ {a.name}</button>)}</div>}
    {value.length === 0 && disabled && <span className="soft" style={{ fontSize: 12.5 }}>—</span>}
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

// Landing/selector de instancia: tarjetas con la marca (logo/color) de cada
// instancia a la que el usuario tiene acceso, su rol y unas cifras rápidas.
function InstancePicker({ tenants, user, onPick }: { tenants: TenantData[]; user: ReturnType<typeof buildUser>; onPick: (id: string) => void }) {
  const roleLabel = (t: TenantData) => user.platformAdmin
    ? 'Administrador de plataforma'
    : ({ tenant_admin: 'Administrador', technician: 'Técnico', requester: 'Solicitante' }[user.memberships[t.id]?.role ?? 'requester']);
  return (
    <div className="pick-wrap">
      <div className="pick-inner">
        <div className="pick-head"><span className="glyph">A</span> <b>Atenza</b></div>
        <h1 className="pick-title">Elige una instancia</h1>
        <p className="pick-sub">Tienes acceso a {tenants.length} instancias.</p>
        <div className="pick-grid">
          {tenants.map((t) => {
            const accent = t.branding?.primaryColor ?? '#2f6bff';
            return (
              <button key={t.id} className="pick-inst" style={{ ['--accent']: accent } as CSS} onClick={() => onPick(t.id)}>
                <div className="pick-logo">
                  {t.branding?.logoUrl
                    ? <img src={t.branding.logoUrl} alt="" />
                    : <span className="pick-glyph" style={{ background: accent }}>{(t.name || 'A').slice(0, 1)}</span>}
                </div>
                <div className="pick-inst-name">{t.name}</div>
                <div className="pick-inst-role">{roleLabel(t)}</div>
                <div className="pick-inst-meta">{t.tickets.length} activos · {t.members.length} personas</div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
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
  const requestAccess = useStore((s) => s.requestAccess);
  const accessRequests = useStore((s) => s.accessRequests);
  const setAdminSec = useStore((s) => s.setAdminSec);
  const [accessRequested, setAccessRequested] = useState(false);
  const authUser = useAuth((s) => s.user);
  const authReady = useAuth((s) => s.ready);
  useEffect(() => { void useAuth.getState().init(); }, []);
  useEffect(() => { if (firebaseEnabled && authUser) void startCloud(authUser.uid); }, [authUser?.uid, startCloud]);
  const [, setTheme] = useState<'light' | 'dark' | null>(null);
  const [view, setView] = useState<'home' | 'tickets' | 'assigned' | 'requests' | 'kb' | 'admin' | 'archivo' | 'activos'>('home');
  const [dismissedAnn, setDismissedAnn] = useState<string[]>([]);
  const [filter, setFilter] = useState<'all' | 'unassigned' | 'mine'>('all');
  const [showNew, setShowNew] = useState(false);
  // Landing de selección de instancia: se muestra una vez por sesión a quien tiene
  // ≥2 instancias (clic en el logo del topbar para volver a ella).
  const [instanceChosen, setInstanceChosen] = useState(false);

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
      {accessRequested
        ? <>
          <p style={{ margin: '16px 0', color: 'var(--ink-soft)', fontSize: 14 }}>✅ Solicitud enviada.<br />Si ya estabas dado de alta, tu acceso se activa en unos segundos: pulsa <b>Recargar</b>. Si no, un administrador la aprobará.</p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
            <button className="primary" onClick={() => window.location.reload()}>Recargar</button>
            <button className="ghost" onClick={() => doSignOut()}>Salir</button>
          </div>
        </>
        : <>
          <p style={{ margin: '16px 0', color: 'var(--ink-soft)', fontSize: 14 }}>Sin acceso todavía.<br /><b>{authUser?.email}</b> no pertenece a ninguna instancia.</p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
            <button className="primary" onClick={async () => { await requestAccess(authUser?.email ?? ''); setAccessRequested(true); }}>Solicitar acceso</button>
            <button className="ghost" onClick={() => doSignOut()}>Salir</button>
          </div>
        </>}
    </div></div>
  );
  if (firebaseEnabled && !tenant) return card('Sincronizando datos…');
  if (!tenant) return card('Sin datos.');
  // Landing/selector: quien tiene ≥2 instancias elige antes de entrar.
  if (myTenants.length > 1 && !instanceChosen) return (
    <InstancePicker tenants={myTenants} user={user} onPick={(id) => { setTenant(id); setInstanceChosen(true); }} />
  );

  const isReq = role === 'requester';
  const caps = capsOf(tenant, effectiveUserId, !!user.platformAdmin);
  const canManageConfig = caps.includes('manageConfig');
  const activeView: 'home' | 'tickets' | 'assigned' | 'requests' | 'kb' | 'admin' | 'archivo' | 'activos' = isReq && view !== 'kb' && view !== 'archivo' ? 'requests' : view;
  const openCount = tenant.tickets.length;
  const myAssignedCount = tenant.tickets.filter((t) => t.technicianId === effectiveUserId).length;
  const myReqCount = tenant.tickets.filter((t) => t.requesterId === effectiveUserId).length;

  return (
    <div>
      <div className="top">
        <div className={'brand' + (myTenants.length > 1 ? ' brand-clic' : '')}
          onClick={() => { if (myTenants.length > 1) setInstanceChosen(false); }}
          title={myTenants.length > 1 ? 'Cambiar de instancia' : ''}>
          {tenant.branding?.logoUrl
            ? <img className="brand-logo" src={tenant.branding.logoUrl} alt="" />
            : <span className="glyph" style={tenant.branding?.primaryColor ? { background: tenant.branding.primaryColor } : undefined}>{(tenant.name || 'A').slice(0, 1)}</span>}
          <span className="brand-name">{tenant.name}</span>
          <small>Atenza · {firebaseEnabled ? 'nube' : 'local'}</small>
        </div>
        {myTenants.length > 1 && (
          <select className="instsel" value={tenant.id} onChange={(e) => setTenant(e.target.value)} title="Instancia">
            {myTenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        )}
        <GlobalSearch tenant={tenant} onOpen={(id) => { select(id); setView(isReq ? 'requests' : 'tickets'); }} />
        <div className="spring" />
        <button className="newtop" onClick={() => setShowNew(true)} title={readOnly ? 'Ver el catálogo que ve este usuario (solo lectura)' : ''}>＋ Nueva solicitud</button>
        <Bell tenant={tenant} meUid={effectiveUserId} accessCount={user.platformAdmin ? accessRequests.length : 0} onReviewAccess={() => { setAdminSec('accesos'); setView('admin'); }} />
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
        <span><Icon name="eye" size={13} /> Estás viendo el portal <b>como {displayMember?.name ?? effectiveUserId}</b> ({role === 'requester' ? 'Solicitante' : role === 'technician' ? 'Técnico' : 'Admin'}) · solo lectura</span>
        <button className="ghost" onClick={() => { setImpersonate(null); setView('home'); }}>Salir de la representación</button>
      </div>}

      <div className="shell">
        <aside className="side">
          <div className="side-top">
            <div className="cap">Menú</div>
            {!isReq && <button title="Inicio" className={'modlink' + (activeView === 'home' ? ' on' : '')} onClick={() => setView('home')}>
              <Icon name="home" />
              <span className="ml-l">Inicio</span></button>}
            {!isReq && caps.includes('viewAllTickets') && <button title="Solicitudes" className={'modlink' + (activeView === 'tickets' ? ' on' : '')} onClick={() => setView('tickets')}>
              <Icon name="list" />
              <span className="ml-l">Solicitudes</span><span className="n">{openCount}</span></button>}
            {!isReq && <button title="Asignadas a mí" className={'modlink' + (activeView === 'assigned' ? ' on' : '')} onClick={() => setView('assigned')}>
              <Icon name="user-check" />
              <span className="ml-l">Asignadas a mí</span><span className="n">{myAssignedCount}</span></button>}
            <button title="Mis solicitudes" className={'modlink' + (activeView === 'requests' ? ' on' : '')} onClick={() => setView('requests')}>
              <Icon name="ticket" />
              <span className="ml-l">Mis solicitudes</span><span className="n">{myReqCount}</span></button>
            <button title="Base de conocimiento" className={'modlink' + (activeView === 'kb' ? ' on' : '')} onClick={() => setView('kb')}>
              <Icon name="book-open" />
              <span className="ml-l">Base de conocimiento</span></button>
            {!isReq && <button title="Activos" className={'modlink' + (activeView === 'activos' ? ' on' : '')} onClick={() => setView('activos')}>
              <Icon name="server" />
              <span className="ml-l">Activos</span></button>}
            <button title="Archivo" className={'modlink' + (activeView === 'archivo' ? ' on' : '')} onClick={() => setView('archivo')}>
              <Icon name="archive" />
              <span className="ml-l">Archivo</span></button>
          </div>
          <div className="side-bottom">
            {canManageConfig && <button title="Administración" className={'modlink' + (activeView === 'admin' ? ' on' : '')} onClick={() => setView('admin')}>
              <Icon name="settings" />
              <span className="ml-l">Administración</span></button>}
          </div>
        </aside>

        <main className="main">
          {visibleAnnouncements(tenant.announcements, !isReq).filter((a) => !dismissedAnn.includes(a.id)).map((a) => <div key={a.id} className="announce">
            <span className="ann-ic"><Icon name="megaphone" size={16} /></span>
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
          {activeView === 'activos' && !isReq && <AssetsModule tenant={tenant} canManage={!readOnly} onOpenTicket={(id) => { useStore.getState().select(id); setView('tickets'); }} />}
          {activeView === 'archivo' && <Archive tenant={tenant} role={role} user={user} caps={caps} meName={tenant.members.find((m) => m.uid === user.uid)?.name ?? 'Yo'} meUid={user.uid} cloud={firebaseEnabled} />}
          {activeView === 'admin' && canManageConfig && <AdminConfig tenant={tenant} />}
        </main>
      </div>

      {showNew && <NewTicketSimplified tenant={tenant} role={role} user={user} readOnly={readOnly} onClose={() => setShowNew(false)} />}
    </div>
  );
}

// Panel de inicio: KPIs + widgets calculados a partir de los datos reales del tenant.
// ---- Gráficos SVG modernos (siguen los tokens de la app; sin dependencias) ----
type CSS = import('react').CSSProperties;

// Mide el contenedor en vivo (ResizeObserver) para que los gráficos se
// redimensionen al alto/ancho real de la tarjeta en lugar de hacer scroll.
function useMeasure<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const measure = useCallback(() => { const el = ref.current; if (!el) return; const r = el.getBoundingClientRect(); setSize((s) => (s.w === Math.round(r.width) && s.h === Math.round(r.height) ? s : { w: Math.round(r.width), h: Math.round(r.height) })); }, []);
  // Cada render remide (protegido contra bucles por la igualdad): capta los
  // cambios de alto de la tarjeta aunque el ResizeObserver no dispare.
  useLayoutEffect(() => { measure(); });
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const ro = new ResizeObserver(measure); ro.observe(el);
    window.addEventListener('resize', measure);
    return () => { ro.disconnect(); window.removeEventListener('resize', measure); };
  }, [measure]);
  return [ref, size] as const;
}

// Aro de anillo con separación entre segmentos, total al centro y leyenda con %.
function Donut({ data, size = 128, thickness = 15 }: { data: { label: string; value: number; color: string }[]; size?: number; thickness?: number }) {
  const total = data.reduce((a, d) => a + d.value, 0);
  const r = (size - thickness) / 2; const c = 2 * Math.PI * r; const cx = size / 2;
  const gap = total > 1 ? 3 : 0; // hueco de superficie entre segmentos
  const parts = data.filter((d) => d.value > 0);
  let off = 0;
  return <div className="donut">
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="donut-svg">
      <circle cx={cx} cy={cx} r={r} fill="none" stroke="var(--sink)" strokeWidth={thickness} />
      <g transform={`rotate(-90 ${cx} ${cx})`}>
        {parts.map((d, i) => { const len = (d.value / total) * c; const draw = Math.max(0.001, len - gap); const seg = <circle key={i} cx={cx} cy={cx} r={r} fill="none" stroke={d.color} strokeWidth={thickness} strokeDasharray={`${draw} ${c - draw}`} strokeDashoffset={-off} strokeLinecap="round" />; off += len; return seg; })}
      </g>
      <text x={cx} y={cx - 2} textAnchor="middle" fontSize={26} fontWeight={760} fill="var(--ink)" fontFamily="var(--mono)" letterSpacing="-0.03em">{total}</text>
      <text x={cx} y={cx + 15} textAnchor="middle" fontSize={9} fill="var(--ink-faint)" letterSpacing="0.08em">TOTAL</text>
    </svg>
    <div className="donut-legend">{parts.map((d) => <div key={d.label} className="lg-row" title={`${d.label}: ${d.value}`}>
      <span className="lg-dot" style={{ background: d.color }} /><span className="lg-lbl">{d.label}</span>
      <b className="mono">{d.value}</b><span className="lg-pct">{Math.round((d.value / total) * 100)}%</span>
    </div>)}
      {total === 0 && <span className="soft" style={{ fontSize: 12 }}>Sin datos.</span>}</div>
  </div>;
}

// Barras horizontales con extremo redondeado y valor al final.
function BarList({ rows, color }: { rows: { label: string; value: number; color?: string }[]; color?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (rows.length === 0) return <div className="empty" style={{ padding: '18px 16px' }}>Sin datos.</div>;
  return <div className="barlist">{rows.map((r) => <div key={r.label} className="bl-row" title={`${r.label}: ${r.value}`}>
    <span className="bl-lbl">{r.label}</span>
    <span className="bl-track"><span className="bl-fill" style={{ width: (r.value / max * 100) + '%', background: r.color ?? color ?? 'var(--accent)' }} /></span>
    <b className="bl-n mono">{r.value}</b>
  </div>)}</div>;
}

// Columnas verticales (recibidas por día) con extremo redondeado y hover.
function MiniBars({ data, color = 'var(--accent)' }: { data: { label: string; value: number; full?: string }[]; color?: string }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return <div className="minibars">{data.map((d, i) => <div key={i} className="mb-col" title={`${d.full ?? d.label}: ${d.value}`}>
    <span className="mb-v">{d.value || ''}</span>
    <span className="mb-track"><span className="mb-fill" style={{ height: `${Math.max(d.value === 0 ? 0 : 6, (d.value / max) * 100)}%`, background: color }} /></span>
    <span className="mb-l">{d.label}</span>
  </div>)}</div>;
}

// Semicírculo de proporción (p. ej. vencidas sobre el total con SLA).
function Gauge({ value, max, color = 'var(--warn)', caption }: { value: number; max: number; color?: string; caption?: string }) {
  const frac = max ? Math.min(1, value / max) : 0; const R = 46, CX = 66, CY = 64;
  const pt = (f: number): [number, number] => [CX + R * Math.cos(Math.PI * (1 - f)), CY - R * Math.sin(Math.PI * (1 - f))];
  const [ex, ey] = pt(frac);
  // El arco del gauge barre como mucho 180° → large-arc-flag SIEMPRE 0 (con 1 se
  // dibujaría el arco mayor >180° y se veía "cortado"). viewBox con margen arriba.
  return <svg width={132} height={80} viewBox="0 0 132 80" style={{ maxWidth: '100%', maxHeight: '100%' }}>
    <path d="M20 64 A46 46 0 0 1 112 64" fill="none" stroke="var(--sink)" strokeWidth={11} strokeLinecap="round" />
    {frac > 0 && <path d={`M20 64 A46 46 0 0 1 ${ex} ${ey}`} fill="none" stroke={color} strokeWidth={11} strokeLinecap="round" />}
    <text x={66} y={56} textAnchor="middle" fontSize={26} fontWeight={760} fontFamily="var(--mono)" fill="var(--ink)" letterSpacing="-0.03em">{value}</text>
    {caption && <text x={66} y={74} textAnchor="middle" fontSize={9.5} fill="var(--ink-faint)" letterSpacing="0.05em">{caption}</text>}
  </svg>;
}

// Serie temporal: líneas + relleno de área, rejilla tenue, extremo destacado y
// capa de hover (línea guía + tooltip). Sin doble eje (una sola escala Y).
function AreaTimeline({ labels, series }: { labels: string[]; series: { name: string; color: string; values: number[] }[] }) {
  const [hi, setHi] = useState<number | null>(null);
  const [wrapRef, size] = useMeasure<HTMLDivElement>();
  const n = labels.length;
  // Se dibuja a los px REALES del contenedor (sin viewBox escalado) → el gráfico
  // se redimensiona con el alto de la tarjeta y el texto nunca se deforma.
  const W = size.w > 0 ? size.w : 640, H = size.h > 0 ? size.h : 180;
  // menos margen vertical cuando la tarjeta es baja (para que quepa el trazo)
  const padL = 30, padR = 14, padT = 12, padB = H < 150 ? 16 : 26;
  const plotW = W - padL - padR, plotH = Math.max(1, H - padT - padB);
  const rawMax = Math.max(1, ...series.flatMap((s) => s.values));
  // techo “bonito”: 1·10ⁿ, 2·10ⁿ o 5·10ⁿ
  const niceMax = (m: number) => { const p = Math.pow(10, Math.floor(Math.log10(m))); const f = m / p; const step = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10; return step * p; };
  const max = niceMax(rawMax);
  const x = (i: number) => padL + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v: number) => padT + (1 - v / max) * plotH;
  const ticks = [0, 0.5, 1].map((f) => Math.round(max * f));
  const linePath = (vals: number[]) => vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const areaPath = (vals: number[]) => `${linePath(vals)} L${x(n - 1).toFixed(1)} ${(padT + plotH).toFixed(1)} L${x(0).toFixed(1)} ${(padT + plotH).toFixed(1)} Z`;
  const onMove = (e: import('react').MouseEvent) => { const el = wrapRef.current; if (!el) return; const rect = el.getBoundingClientRect(); const f = (e.clientX - rect.left) / rect.width; setHi(Math.max(0, Math.min(n - 1, Math.round(f * (n - 1))))); };
  const empty = series.every((s) => s.values.every((v) => v === 0));
  // etiquetas del eje X: primera, media y última (evita solape)
  const xIdx = n <= 1 ? [0] : [...new Set([0, Math.floor((n - 1) / 2), n - 1])];
  return <div className="areawrap">
    <div className="area-legend">{series.map((s) => <span key={s.name} className="al-item"><span className="al-line" style={{ background: s.color }} />{s.name}<b className="mono">{s.values.reduce((a, b) => a + b, 0)}</b></span>)}</div>
    <div className="area-plot" ref={wrapRef} onMouseMove={onMove} onMouseLeave={() => setHi(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} style={{ display: 'block', position: 'absolute', inset: 0 }}>
        <defs>{series.map((s, i) => <linearGradient key={i} id={`atg${i}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={s.color} stopOpacity={0.22} /><stop offset="100%" stopColor={s.color} stopOpacity={0} /></linearGradient>)}</defs>
        {ticks.map((t, i) => { const yy = y(t); return <g key={i}><line x1={padL} y1={yy} x2={W - padR} y2={yy} stroke="var(--line)" strokeWidth={1} strokeDasharray={i === 0 ? '' : '3 4'} opacity={i === 0 ? 1 : 0.7} /><text x={padL - 6} y={yy + 3} textAnchor="end" fontSize={10} fill="var(--ink-faint)" fontFamily="var(--mono)">{t}</text></g>; })}
        {xIdx.map((i) => <text key={i} x={x(i)} y={H - 8} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'} fontSize={10} fill="var(--ink-faint)">{labels[i]}</text>)}
        {!empty && series.map((s, i) => <path key={i} d={areaPath(s.values)} fill={`url(#atg${i})`} />)}
        {!empty && series.map((s, i) => <path key={i} d={linePath(s.values)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />)}
        {!empty && series.map((s, i) => <circle key={i} cx={x(n - 1)} cy={y(s.values[n - 1] ?? 0)} r={3.4} fill="var(--surface)" stroke={s.color} strokeWidth={2} />)}
        {hi != null && !empty && <line x1={x(hi)} y1={padT} x2={x(hi)} y2={padT + plotH} stroke="var(--ink-faint)" strokeWidth={1} strokeDasharray="3 3" />}
        {hi != null && !empty && series.map((s, i) => <circle key={i} cx={x(hi)} cy={y(s.values[hi] ?? 0)} r={4} fill={s.color} stroke="var(--surface)" strokeWidth={2} />)}
      </svg>
      {empty && <div className="area-empty">Sin datos en el periodo.</div>}
      {hi != null && !empty && <div className="area-tip" style={{ left: `${(x(hi) / W) * 100}%`, transform: `translateX(${hi > n / 2 ? '-100%' : '0'}) translateX(${hi > n / 2 ? -8 : 8}px)` } as CSS}>
        <div className="at-h">{labels[hi]}</div>
        {series.map((s) => <div key={s.name} className="at-r"><span className="al-line" style={{ background: s.color }} />{s.name}<b className="mono">{s.values[hi] ?? 0}</b></div>)}
      </div>}
    </div>
  </div>;
}

// ---- Panel modular: catálogo de visuales, layout por usuario (localStorage) ----
type WType = 'kpis' | 'evolucion' | 'tecnico' | 'recibidas' | 'prioridad' | 'tipo' | 'estado' | 'grupo' | 'sla' | 'resumen'
  | 'sede' | 'categoria' | 'antiguedad' | 'sinasignar' | 'cumplimiento' | 'garantia';
type Span = 1 | 2 | 3 | 4;
type HLevel = 1 | 2 | 3 | 4 | 5 | 6;
interface DashW { id: string; type: WType; span: Span; h?: HLevel }
// fit:true → gráfico que se REDIMENSIONA al alto de la tarjeta (sin scroll).
// El resto (tablas/listas) hace scroll cuando no cabe.
const W_META: Record<WType, { title: string; span: Span; h: HLevel; icon: string; desc: string; fit?: boolean }> = {
  kpis: { title: 'Indicadores', span: 4, h: 1, icon: 'sliders', desc: 'Abiertas · sin asignar · vencidas · mías' },
  evolucion: { title: 'Evolución de tickets', span: 4, h: 5, icon: 'zap', desc: 'Entrantes vs. cerradas en el tiempo', fit: true },
  tecnico: { title: 'Solicitudes por técnico', span: 2, h: 6, icon: 'users', desc: 'Carga y capacidad por persona' },
  recibidas: { title: 'Recibidas · últimos 14 días', span: 2, h: 3, icon: 'calendar', desc: 'Entradas diarias recientes', fit: true },
  prioridad: { title: 'Abiertas por prioridad', span: 1, h: 3, icon: 'list', desc: 'Reparto por prioridad', fit: true },
  tipo: { title: 'Por tipo', span: 1, h: 2, icon: 'ticket', desc: 'Incidencias vs. peticiones', fit: true },
  estado: { title: 'Por estado', span: 2, h: 3, icon: 'list', desc: 'Reparto por estado actual' },
  grupo: { title: 'Cola por grupo de soporte', span: 2, h: 3, icon: 'inbox', desc: 'Carga por grupo' },
  sla: { title: 'Estado del SLA', span: 1, h: 2, icon: 'shield', desc: 'Vencidas / cerca / en plazo', fit: true },
  resumen: { title: 'Resumen de la instancia', span: 1, h: 2, icon: 'server', desc: 'Conteos de configuración' },
  sede: { title: 'Por sede', span: 2, h: 3, icon: 'landmark', desc: 'Reparto de abiertas por sede' },
  categoria: { title: 'Por categoría de servicio', span: 2, h: 3, icon: 'list', desc: 'Reparto por categoría' },
  antiguedad: { title: 'Antigüedad de abiertas', span: 2, h: 3, icon: 'calendar', desc: 'Cuánto llevan abiertas' },
  sinasignar: { title: 'Sin asignar por grupo', span: 2, h: 3, icon: 'inbox', desc: 'Cola sin técnico, por grupo' },
  cumplimiento: { title: 'Cumplimiento de SLA', span: 1, h: 3, icon: 'shield', desc: 'En plazo vs. cerca vs. vencidas', fit: true },
  garantia: { title: 'Garantía de activos', span: 2, h: 3, icon: 'server', desc: 'Activos por estado de garantía' },
};
// alto de la tarjeta = (h+2) filas base de la rejilla (auto-rows 38px, gap 14px)
// → niveles ≈ 142·194·246·298·350·402px. Referencia: «por técnico» (la más alta) = 6.
const hRows = (h: HLevel): number => h + 2;
// Solo estos 10 componen el panel por defecto; el resto está en «Añadir visual».
const DEFAULT_TYPES: WType[] = ['kpis', 'evolucion', 'tecnico', 'recibidas', 'prioridad', 'tipo', 'sla', 'resumen', 'estado', 'grupo'];
const DEFAULT_LAYOUT = (): DashW[] => DEFAULT_TYPES.map((type) => ({ id: 'w-' + type, type, span: W_META[type].span, h: W_META[type].h }));
const DASH_KEY = (uid: string) => `atenza-dash-v2-${uid}`;
function useDashLayout(uid: string) {
  const key = DASH_KEY(uid);
  const read = (): DashW[] => { try { const s = localStorage.getItem(key); if (s) { const p = JSON.parse(s) as DashW[]; if (Array.isArray(p) && p.length) return p; } } catch { /* ignora */ } return DEFAULT_LAYOUT(); };
  const [layout, setLayout] = useState<DashW[]>(read);
  useEffect(() => { setLayout(read()); /* recarga al cambiar de usuario */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(layout)); } catch { /* ignora */ } }, [key, layout]);
  return [layout, setLayout] as const;
}

// ---- Serie temporal: cubos por periodo y cierre de ticket ----
type Period = 'dias' | 'semanas' | 'meses';
interface Bucket { start: number; end: number; label: string }
function makeBuckets(period: Period, now: number): Bucket[] {
  const DAY = 86400000; const sod = (ms: number) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
  if (period === 'dias') { const start = sod(now) - 29 * DAY; return Array.from({ length: 30 }, (_, i) => { const s = start + i * DAY; return { start: s, end: s + DAY, label: new Date(s).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit' }) }; }); }
  if (period === 'semanas') { const dow = (new Date(sod(now)).getDay() + 6) % 7; const thisMon = sod(now) - dow * DAY; const start = thisMon - 11 * 7 * DAY; return Array.from({ length: 12 }, (_, i) => { const s = start + i * 7 * DAY; return { start: s, end: s + 7 * DAY, label: new Date(s).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit' }) }; }); }
  const d = new Date(now); const out: Bucket[] = [];
  for (let k = 11; k >= 0; k--) { const s = new Date(d.getFullYear(), d.getMonth() - k, 1).getTime(); const e = new Date(d.getFullYear(), d.getMonth() - k + 1, 1).getTime(); out.push({ start: s, end: e, label: new Date(s).toLocaleDateString('es-ES', { month: 'short' }) }); }
  return out;
}
const bucketIdx = (b: Bucket[], ms: number) => { for (let i = 0; i < b.length; i++) if (ms >= b[i]!.start && ms < b[i]!.end) return i; return -1; };
const closedAtOf = (t: StoredTicket): number | undefined => { const h = t.statusHistory; return h && h.length ? h[h.length - 1]?.from : undefined; };

function DashCard({ w, edit, over, bare, dragH, onSpan, onHeight, onMove, canBack, canFwd, onRemove, headExtra, children }: { w: DashW; edit: boolean; over: boolean; bare?: boolean; dragH: Record<string, unknown>; onSpan: (s: Span) => void; onHeight: (h: HLevel) => void; onMove: (dir: -1 | 1) => void; canBack: boolean; canFwd: boolean; onRemove: () => void; headExtra?: import('react').ReactNode; children: import('react').ReactNode }) {
  const meta = W_META[w.type];
  const showHead = edit || !bare;
  const h = w.h ?? meta.h;
  return <div className={'dcard' + (bare ? ' plain' : '') + (over ? ' over' : '') + (edit ? ' editing' : '')} style={{ gridColumn: `span ${w.span}`, gridRow: `span ${hRows(h)}` } as CSS} draggable={edit} {...dragH}>
    {showHead && <div className="dcard-h">
      {edit && <span className="dc-grip" title="Arrastra para mover (o usa las flechas ◀ ▶)">⠿</span>}
      <Icon name={meta.icon} size={14} /><span className="dc-t">{meta.title}</span>
      <div className="dc-tools">{headExtra}</div>
    </div>}
    {edit && <div className="dc-edit">
      <div className="movebtns" title="Mover"><button onClick={() => onMove(-1)} disabled={!canBack} title="Mover antes" aria-label="Mover antes">◀</button><button onClick={() => onMove(1)} disabled={!canFwd} title="Mover después" aria-label="Mover después">▶</button></div>
      <span className="dc-lab">Ancho</span><div className="spanpick" title="Ancho en columnas">{([1, 2, 3, 4] as const).map((s) => <button key={s} className={w.span === s ? 'on' : ''} onClick={() => onSpan(s)}>{s}</button>)}</div>
      <span className="dc-lab">Alto</span><div className="spanpick" title="Alto en filas">{([1, 2, 3, 4, 5, 6] as const).map((n) => <button key={n} className={h === n ? 'on' : ''} onClick={() => onHeight(n)}>{n}</button>)}</div>
      <button className="dc-x" onClick={onRemove} title="Quitar visual" style={{ marginLeft: 'auto' }}><Icon name="trash" size={13} /></button>
    </div>}
    <div className={bare ? 'dcard-bare' : ('dcard-b' + (meta.fit ? ' fit' : ''))}>{children}</div>
  </div>;
}

function Dashboard({ tenant, user, go }: { tenant: TenantData; user: ReturnType<typeof buildUser>; go: (v: 'tickets' | 'assigned', f?: 'all' | 'unassigned' | 'mine') => void }) {
  const now = Date.now();
  const tickets = tenant.tickets.filter((t) => !t.archived); // el panel es sobre lo ACTIVO
  const isOverdue = (t: StoredTicket) => !!t.resolveDueAt && t.resolveDueAt < now;
  const unassigned = tickets.filter((t) => !t.technicianId).length;
  const overdue = tickets.filter(isOverdue).length;
  const mine = tickets.filter((t) => t.technicianId === user.uid).length;
  const withDue = tickets.filter((t) => t.resolveDueAt).length;
  const nearBreach = tickets.filter((t) => t.resolveDueAt && !isOverdue(t) && (t.resolveDueAt - now) < 2 * 3600000).length;

  // Por técnico: abiertas · en espera (reloj pausado) · vencidas + capacidad.
  const techName = (uid: string) => tenant.members.find((m) => m.uid === uid)?.name ?? '—';
  const byTech = new Map<string, { open: number; over: number; wait: number }>();
  for (const t of tickets) { if (!t.technicianId) continue; const e = byTech.get(t.technicianId) ?? { open: 0, over: 0, wait: 0 }; e.open++; if (isOverdue(t)) e.over++; if (statusView(tenant, t).timer === 'stop_timer') e.wait++; byTech.set(t.technicianId, e); }
  const techRows = [...byTech.entries()].map(([uid, v]) => ({ uid, name: techName(uid), ...v })).sort((a, b) => b.open - a.open).slice(0, 8);

  // Por estado.
  const byState = new Map<string, number>();
  for (const t of tickets) { const l = statusView(tenant, t).label; byState.set(l, (byState.get(l) ?? 0) + 1); }
  const STC = ['var(--accent)', '#0891b2', 'var(--warn)', '#be185d', '#0f766e', 'var(--st-closed)'];
  const stateRows = [...byState.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([label, value], i) => ({ label, value, color: STC[i % STC.length] }));

  // Cola por grupo de soporte.
  const groupName = (id?: string | null) => tenant.groups.find((g) => g.id === id)?.name ?? 'Sin grupo';
  const byGroup = new Map<string, number>();
  for (const t of tickets) { const g = groupName(t.groupId); byGroup.set(g, (byGroup.get(g) ?? 0) + 1); }
  const groupRows = [...byGroup.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([label, value]) => ({ label, value }));

  // Por prioridad (donut, con el color del catálogo de prioridades).
  const byPrio = new Map<string, { n: number; color: string }>();
  for (const t of tickets) { const pv = priorityView(tenant, t.priority); const e = byPrio.get(pv.label) ?? { n: 0, color: pv.color }; e.n++; byPrio.set(pv.label, e); }
  const prioData = [...byPrio.entries()].map(([label, v]) => ({ label, value: v.n, color: v.color })).sort((a, b) => b.value - a.value);

  // Por tipo (Incidencia / Petición).
  const incN = tickets.filter((t) => t.type === 'incident').length;
  const typeData = [{ label: 'Incidencias', value: incN, color: 'var(--crit)' }, { label: 'Peticiones', value: tickets.length - incN, color: 'var(--accent)' }];

  // Recibidas en los últimos 14 días (por fecha de creación).
  const DAY = 86400000; const sod = (ms: number) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const t0 = sod(now) - 13 * DAY;
  const recv = Array.from({ length: 14 }, (_, i) => ({ day: t0 + i * DAY, value: 0 }));
  for (const t of tickets) { if (!t.createdAt) continue; const idx = Math.round((sod(t.createdAt) - t0) / DAY); if (idx >= 0 && idx < 14) recv[idx]!.value++; }
  const recvData = recv.map((r) => ({ label: new Date(r.day).toLocaleDateString('es-ES', { day: '2-digit' }), full: new Date(r.day).toLocaleDateString('es-ES', { weekday: 'short', day: '2-digit', month: 'short' }), value: r.value }));

  // Layout modular por usuario + modo edición.
  const [layout, setLayout] = useDashLayout(user.uid);
  const [edit, setEdit] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const seq = useRef(0);
  const dragId = useRef<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const setSpan = (id: string, s: Span) => setLayout((p) => p.map((w) => w.id === id ? { ...w, span: s } : w));
  const setHeight = (id: string, h: HLevel) => setLayout((p) => p.map((w) => w.id === id ? { ...w, h } : w));
  const removeW = (id: string) => setLayout((p) => p.filter((w) => w.id !== id));
  const addW = (type: WType) => { setLayout((p) => [...p, { id: `w-${type}-${Date.now()}-${seq.current++}`, type, span: W_META[type].span, h: W_META[type].h }]); setAddOpen(false); };
  const moveBefore = (src: string | null, dst: string) => { if (!src || src === dst) return; setLayout((p) => { const a = [...p]; const si = a.findIndex((w) => w.id === src); if (si < 0) return p; const [m] = a.splice(si, 1); const di = a.findIndex((w) => w.id === dst); a.splice(di, 0, m!); return a; }); };
  const moveBy = (id: string, dir: -1 | 1) => setLayout((p) => { const i = p.findIndex((w) => w.id === id); const j = i + dir; if (i < 0 || j < 0 || j >= p.length) return p; const a = [...p]; const [m] = a.splice(i, 1); a.splice(j, 0, m!); return a; });
  const dragH = (id: string): Record<string, unknown> => edit ? {
    onDragStart: (e: import('react').DragEvent) => { dragId.current = id; e.dataTransfer.effectAllowed = 'move'; },
    onDragOver: (e: import('react').DragEvent) => { e.preventDefault(); if (overId !== id) setOverId(id); },
    onDrop: (e: import('react').DragEvent) => { e.preventDefault(); moveBefore(dragId.current, id); dragId.current = null; setOverId(null); },
    onDragEnd: () => { dragId.current = null; setOverId(null); },
  } : {};

  // Evolución: carga acotada del histórico (archivo) + activos, por periodo.
  const [period, setPeriod] = useState<Period>('semanas');
  const [arc, setArc] = useState<{ period: Period; rows: StoredTicket[]; truncated: boolean } | null>(null);
  const [arcLoading, setArcLoading] = useState(false);
  const hasEvo = layout.some((w) => w.type === 'evolucion');
  useEffect(() => {
    if (!hasEvo) return; if (arc && arc.period === period) return;
    let cancel = false; setArcLoading(true);
    (async () => {
      const from = makeBuckets(period, Date.now())[0]!.start;
      let rows: StoredTicket[] = []; let truncated = false;
      try {
        if (firebaseEnabled) {
          let after: ArchiveCursor = undefined; const CAP = 40;
          for (let p = 0; p < CAP; p++) { const r = await queryArchive(tenant.id, { from, pageSize: 200, after }); rows.push(...r.tickets); after = r.last; if (r.tickets.length < 200) break; if (p === CAP - 1) truncated = true; }
        } else { rows = tenant.tickets.filter((t) => t.archived && (t.createdAt ?? 0) >= from); }
        if (!cancel) setArc({ period, rows, truncated });
      } finally { if (!cancel) setArcLoading(false); }
    })();
    return () => { cancel = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasEvo, period, tenant.id]);
  const evo = useMemo(() => {
    const buckets = makeBuckets(period, now);
    const entrantes = new Array(buckets.length).fill(0) as number[];
    const cerradas = new Array(buckets.length).fill(0) as number[];
    for (const t of tickets) { if (t.createdAt == null) continue; const i = bucketIdx(buckets, t.createdAt); if (i >= 0) entrantes[i]!++; }
    const rows = arc && arc.period === period ? arc.rows : [];
    for (const t of rows) { if (t.createdAt != null) { const i = bucketIdx(buckets, t.createdAt); if (i >= 0) entrantes[i]!++; } const c = closedAtOf(t); if (c != null) { const j = bucketIdx(buckets, c); if (j >= 0) cerradas[j]!++; } }
    return { labels: buckets.map((b) => b.label), entrantes, cerradas };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, arc, tenant.tickets]);

  const inPlazo = Math.max(0, withDue - overdue - nearBreach);

  // --- datos de los visuales adicionales ---
  const memberSite = (uid?: string | null) => tenant.members.find((m) => m.uid === uid)?.site;
  const bySite = new Map<string, number>();
  for (const t of tickets) { const s = t.site || memberSite(t.requesterId) || 'Sin sede'; bySite.set(s, (bySite.get(s) ?? 0) + 1); }
  const siteRows = [...bySite.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([label, value]) => ({ label, value }));
  const byCat = new Map<string, number>();
  for (const t of tickets) { const c = t.serviceCategory || t.category || 'Sin categoría'; byCat.set(c, (byCat.get(c) ?? 0) + 1); }
  const catRows = [...byCat.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([label, value]) => ({ label, value }));
  const AGE = [{ label: '< 1 día', max: 1 }, { label: '1–3 días', max: 3 }, { label: '3–7 días', max: 7 }, { label: '7–30 días', max: 30 }, { label: '> 30 días', max: Infinity }];
  const agingRows = AGE.map((a) => ({ label: a.label, value: 0, color: 'var(--warn)' }));
  for (const t of tickets) { const created = t.createdAt ?? t.statusHistory?.[0]?.from; if (created == null) continue; const days = (now - created) / 86400000; const idx = AGE.findIndex((a) => days < a.max); if (idx >= 0) agingRows[idx]!.value++; }
  const byUnGroup = new Map<string, number>();
  for (const t of tickets) { if (t.technicianId) continue; const g = groupName(t.groupId); byUnGroup.set(g, (byUnGroup.get(g) ?? 0) + 1); }
  const unassignedRows = [...byUnGroup.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([label, value]) => ({ label, value }));
  const cumplData = [{ label: 'En plazo', value: inPlazo, color: 'var(--ok)' }, { label: 'Cerca (<2 h)', value: nearBreach, color: 'var(--warn)' }, { label: 'Vencidas', value: overdue, color: 'var(--crit)' }];
  // Garantía de activos (widget del panel).
  const gB = [{ label: 'Garantía caducada', value: 0, color: 'var(--crit)' }, { label: 'Vence en < 30 días', value: 0, color: 'var(--warn)' }, { label: 'Vence en 30–90 días', value: 0, color: 'var(--accent)' }, { label: 'En garantía (> 90 días)', value: 0, color: 'var(--ok)' }, { label: 'Sin fecha de garantía', value: 0, color: 'var(--ink-faint)' }];
  for (const a of (tenant.assets ?? [])) { const w = a.warrantyUntil; if (w == null) { gB[4]!.value++; continue; } const d = (w - now) / 86400000; if (d < 0) gB[0]!.value++; else if (d < 30) gB[1]!.value++; else if (d < 90) gB[2]!.value++; else gB[3]!.value++; }
  const garantiaRows = gB.filter((b) => b.value > 0);

  const periodSeg = <div className="seg xs" onDragStart={(e) => e.preventDefault()}>{([['dias', 'Días'], ['semanas', 'Semanas'], ['meses', 'Meses']] as [Period, string][]).map(([k, l]) => <button key={k} draggable={false} className={period === k ? 'on' : ''} onClick={() => setPeriod(k)}>{l}</button>)}</div>;

  const body = (type: WType): import('react').ReactNode => {
    switch (type) {
      case 'kpis': return <div className="kpis">
        <button className="kpi" onClick={() => go('tickets', 'all')}><div className="kl">Abiertas</div><div className="kv">{tickets.length}</div><div className="kstrip" style={{ background: 'var(--accent)' }} /></button>
        <button className="kpi" onClick={() => go('tickets', 'unassigned')}><div className="kl">Sin asignar</div><div className="kv" style={{ color: 'var(--warn)' }}>{unassigned}</div><div className="kstrip" style={{ background: 'var(--warn)' }} /></button>
        <button className="kpi" onClick={() => go('tickets', 'all')}><div className="kl">Vencidas (SLA)</div><div className="kv" style={{ color: 'var(--crit)' }}>{overdue}</div><div className="kstrip" style={{ background: 'var(--crit)' }} /></button>
        <button className="kpi" onClick={() => go('assigned')}><div className="kl">Asignadas a mí</div><div className="kv">{mine}</div><div className="kstrip" style={{ background: 'var(--ok)' }} /></button>
      </div>;
      case 'evolucion': return (arcLoading && (!arc || arc.period !== period))
        ? <div className="area-empty" style={{ position: 'static', padding: '48px 0' }}>Cargando histórico…</div>
        : <><AreaTimeline labels={evo.labels} series={[{ name: 'Entrantes', color: 'var(--accent)', values: evo.entrantes }, { name: 'Cerradas', color: 'var(--ok)', values: evo.cerradas }]} />
          <div className="lc-hint" style={{ marginTop: 4 }}>Entrantes por fecha de creación · Cerradas por fecha de cierre.{arc?.truncated ? ' Muestra acotada del histórico en periodos largos.' : ''}</div></>;
      case 'tecnico': return <table className="dtbl"><thead><tr><th>Técnico</th><th className="num">Abiertas</th><th className="num">En espera</th><th className="num">Vencidas</th><th className="num">Capacidad</th></tr></thead>
        <tbody>{techRows.map((r) => { const c = tenant.capacity[r.uid] ?? { used: 0, cap: 40 }; const p = c.cap ? Math.round((c.used / c.cap) * 100) : 0; const mem = tenant.members.find((m) => m.uid === r.uid); return <tr key={r.uid}>
          <td><div className="who">{mem ? <Avatar m={mem} /> : <span className="av" style={{ background: 'var(--ink-faint)' }}>?</span>} {r.name}</div></td>
          <td className="num mono">{r.open}</td>
          <td className="num mono" style={{ color: 'var(--ink-soft)' }}>{r.wait}</td>
          <td className="num"><span style={{ color: r.over ? 'var(--crit)' : 'var(--ink-faint)', fontWeight: 700, fontFamily: 'var(--mono)' }}>{r.over}</span></td>
          <td className="num"><div className="capmini"><span style={{ width: Math.min(p, 100) + '%', background: capColor(c) }} /></div></td>
        </tr>; })}
        {techRows.length === 0 && <tr><td colSpan={5} className="empty">Sin tickets asignados.</td></tr>}</tbody></table>;
      case 'recibidas': return <MiniBars data={recvData} />;
      case 'prioridad': return <Donut data={prioData} />;
      case 'tipo': return <Donut data={typeData} />;
      case 'estado': return <BarList rows={stateRows} />;
      case 'grupo': return <BarList rows={groupRows} color="var(--accent)" />;
      case 'sla': return <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', flex: 1, minHeight: 0 }}>
        <Gauge value={overdue} max={Math.max(1, withDue)} color="var(--crit)" caption="vencidas" />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7, fontSize: 12.5, flex: 1, minWidth: 118 }}>
          <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}><span className="sdot" style={{ background: 'var(--crit)' }} />Vencidas <b className="mono" style={{ marginLeft: 'auto' }}>{overdue}</b></span>
          <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}><span className="sdot" style={{ background: 'var(--warn)' }} />Cerca (&lt;2 h) <b className="mono" style={{ marginLeft: 'auto' }}>{nearBreach}</b></span>
          <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}><span className="sdot" style={{ background: 'var(--ok)' }} />En plazo <b className="mono" style={{ marginLeft: 'auto' }}>{inPlazo}</b></span>
        </div>
      </div>;
      case 'resumen': return <div className="facts">
        <div><div className="k">Categorías</div><b style={{ fontSize: 18 }}>{(tenant.serviceCategories ?? []).length}</b></div>
        <div><div className="k">Flujos</div><b style={{ fontSize: 18 }}>{tenant.lifecycles.length}</b></div>
        <div><div className="k">Grupos</div><b style={{ fontSize: 18 }}>{tenant.groups.length}</b></div>
        <div><div className="k">Personas</div><b style={{ fontSize: 18 }}>{tenant.members.length}</b></div>
      </div>;
      case 'sede': return <BarList rows={siteRows} />;
      case 'categoria': return <BarList rows={catRows} />;
      case 'antiguedad': return <BarList rows={agingRows} />;
      case 'sinasignar': return <BarList rows={unassignedRows} color="var(--warn)" />;
      case 'cumplimiento': return <Donut data={cumplData} />;
      case 'garantia': return <BarList rows={garantiaRows} />;
    }
  };

  const inLayout = new Set(layout.map((w) => w.type));
  return <>
    <div className="hd">
      <h1>Panel de servicio</h1>
      <span className="sub">{tenant.name} · {tickets.length} solicitudes activas</span>
      <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center', position: 'relative' }}>
        {edit && <div className="addwrap">
          <button className="ghost sm" onClick={() => setAddOpen((o) => !o)}>＋ Añadir visual</button>
          {addOpen && <div className="addmenu">{(Object.keys(W_META) as WType[]).map((t) => <button key={t} className="addopt" onClick={() => addW(t)}>
            <Icon name={W_META[t].icon} size={14} /><span><b>{W_META[t].title}</b>{inLayout.has(t) ? <span className="addused"> · ya en el panel</span> : ''}<span className="addesc">{W_META[t].desc}</span></span>
          </button>)}</div>}
        </div>}
        {edit && <button className="ghost sm" onClick={() => { if (confirm('¿Restablecer el panel por defecto?')) setLayout(DEFAULT_LAYOUT()); }}>Restablecer</button>}
        <button className={'seg-solo' + (edit ? ' on' : '')} onClick={() => { setEdit((e) => !e); setAddOpen(false); }}><Icon name="sliders" size={14} /> {edit ? 'Hecho' : 'Personalizar'}</button>
      </div>
    </div>
    {edit && <div className="edithint"><Icon name="eye" size={13} /> Reordena con las flechas <b>◀ ▶</b> (o arrastrando la tarjeta) · ajusta el ancho <b>1–4</b> columnas · añade o quita visuales. El diseño se guarda para tu usuario.</div>}
    {layout.length === 0
      ? <div className="empty" style={{ padding: 40 }}>Panel vacío. Pulsa «Personalizar» → «Añadir visual».</div>
      : <div className="dgrid2">
        {layout.map((w, i) => <DashCard key={w.id} w={w} edit={edit} over={overId === w.id} bare={w.type === 'kpis'} dragH={dragH(w.id)} onSpan={(s) => setSpan(w.id, s)} onHeight={(h) => setHeight(w.id, h)} onMove={(dir) => moveBy(w.id, dir)} canBack={i > 0} canFwd={i < layout.length - 1} onRemove={() => removeW(w.id)} headExtra={w.type === 'evolucion' ? periodSeg : undefined}>{body(w.type)}</DashCard>)}
      </div>}
  </>;
}

// ---- Módulo de Activos / CMDB (lista + ficha viva + CRUD + asignación) ----
// Combo de personas con BÚSQUEDA y orden alfabético (para listas largas de
// usuarios). `extras` son opciones fijas al principio (p. ej. «todos», «sin asignar»).
function SearchSelect({ value, onChange, members, extras, placeholder, disabled }: { value: string; onChange: (v: string) => void; members: UiMember[]; extras?: { value: string; label: string }[]; placeholder: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (wrapRef.current && !wrapRef.current.contains(e.target as HTMLElement)) setOpen(false); };
    document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h);
  }, [open]);
  const sorted = [...members].sort((a, b) => a.name.localeCompare(b.name, 'es'));
  const ql = q.trim().toLowerCase();
  const filtered = ql ? sorted.filter((m) => `${m.name} ${m.email}`.toLowerCase().includes(ql)) : sorted;
  const label = extras?.find((x) => x.value === value)?.label ?? members.find((m) => m.uid === value)?.name ?? placeholder;
  const pick = (v: string) => { onChange(v); setOpen(false); setQ(''); };
  return <div className="ssel" ref={wrapRef}>
    <button type="button" className="ssel-btn" disabled={disabled} onClick={() => setOpen((o) => !o)}><span className="ssel-lbl">{label}</span>{!disabled && <span className="ssel-caret">▾</span>}</button>
    {open && <div className="ssel-pop">
      <input autoFocus className="ssel-search" placeholder="Buscar persona…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="ssel-list">
        {!ql && extras?.map((x) => <button key={x.value} type="button" className={'ssel-opt' + (value === x.value ? ' on' : '')} onClick={() => pick(x.value)}>{x.label}</button>)}
        {filtered.map((m) => <button key={m.uid} type="button" className={'ssel-opt' + (value === m.uid ? ' on' : '')} onClick={() => pick(m.uid)}><Avatar m={m} /> <span className="ssel-nm">{m.name}</span></button>)}
        {filtered.length === 0 && <div className="ssel-empty">Sin resultados.</div>}
      </div>
    </div>}
  </div>;
}

function AssetsModule({ tenant, canManage, onOpenTicket }: { tenant: TenantData; canManage: boolean; onOpenTicket: (id: string) => void }) {
  const addAsset = useStore((s) => s.addAsset);
  const updateAsset = useStore((s) => s.updateAsset);
  const bulkUpdateAssets = useStore((s) => s.bulkUpdateAssets);
  const removeAsset = useStore((s) => s.removeAsset);
  const removeAssets = useStore((s) => s.removeAssets);
  const [q, setQ] = useState('');
  const [fType, setFType] = useState('');
  const [fStatus, setFStatus] = useState('');
  const [fAssignee, setFAssignee] = useState('');
  const [fSite, setFSite] = useState('');
  const [sort, setSort] = useState<{ col: 'name' | 'productType' | 'status' | 'assignedTo' | 'warrantyUntil'; dir: 1 | -1 }>({ col: 'name', dir: 1 });
  const [selId, setSelId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [rowMenu, setRowMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [csv, setCsv] = useState<null | { create: Partial<Asset>[]; update: { id: string; patch: Partial<Asset> }[]; skipped: number }>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (!rowMenu) return; const close = () => setRowMenu(null); window.addEventListener('scroll', close, true); window.addEventListener('resize', close); return () => { window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); }; }, [rowMenu]);
  const assets = tenant.assets ?? [];
  const now = Date.now();
  const memberName = (uid?: string | null) => tenant.members.find((m) => m.uid === uid)?.name ?? '';
  const sites = [...new Set(assets.map((a) => a.site).filter((s): s is string => !!s))].sort((a, b) => a.localeCompare(b, 'es'));
  const ql = q.trim().toLowerCase();
  const sortVal = (a: Asset): string | number =>
    sort.col === 'status' ? assetStatusView(a.status).label
      : sort.col === 'assignedTo' ? memberName(a.assignedTo).toLowerCase()
        : sort.col === 'warrantyUntil' ? (a.warrantyUntil ?? 0)
          : sort.col === 'productType' ? (a.productType ?? '').toLowerCase()
            : a.name.toLowerCase();
  const list = assets
    .filter((a) =>
      (!ql || `${a.name} ${a.tag ?? ''} ${a.serial ?? ''} ${a.vendor ?? ''} ${a.model ?? ''} ${a.id} ${memberName(a.assignedTo)} ${a.site ?? ''} ${a.department ?? ''} ${a.productType ?? ''}`.toLowerCase().includes(ql)) &&
      (!fType || a.productType === fType) &&
      (!fStatus || a.status === fStatus) &&
      (!fSite || a.site === fSite) &&
      (!fAssignee || (fAssignee === '__none__' ? !a.assignedTo : a.assignedTo === fAssignee)))
    .sort((a, b) => { const va = sortVal(a), vb = sortVal(b); const c = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb), 'es'); return c * sort.dir; });
  const hasFilter = !!(ql || fType || fStatus || fSite || fAssignee);
  const exportCsv = () => {
    const head = ['ID', 'Nombre', 'Etiqueta', 'Tipo', 'Nº serie', 'Estado', 'Asignado a', 'Sede', 'Departamento', 'Fabricante', 'Modelo', 'Compra', 'Garantía', 'Coste'];
    const cell = (v: unknown) => { const s = v == null ? '' : String(v); return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const day = (ms?: number | null) => (ms ? new Date(ms).toLocaleDateString('es-ES') : '');
    const rows = list.map((a) => [a.id, a.name, a.tag, a.productType, a.serial, assetStatusView(a.status).label, memberName(a.assignedTo), a.site, a.department, a.vendor, a.model, day(a.purchaseDate), day(a.warrantyUntil), a.cost].map(cell).join(';'));
    const csv = '﻿' + [head.join(';'), ...rows].join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const el = document.createElement('a'); el.href = url; el.download = `activos-atenza-${new Date().toISOString().slice(0, 10)}.csv`; el.click(); URL.revokeObjectURL(url);
  };
  const sortTh = (col: typeof sort.col, label: string, extra?: import('react').CSSProperties) => <th onClick={() => setSort((s) => ({ col, dir: s.col === col ? (s.dir * -1 as 1 | -1) : 1 }))} style={{ cursor: 'pointer', userSelect: 'none', ...extra }}>{label}{sort.col === col ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}</th>;
  const sel = assets.find((a) => a.id === selId) ?? null;
  const stat = (k: AssetStatus) => assets.filter((a) => a.status === k).length;
  const dayVal = (ms?: number | null) => (ms ? new Date(ms).toISOString().slice(0, 10) : '');
  const linkedTickets = sel ? tenant.tickets.filter((t) => (t.assetIds ?? []).includes(sel.id)) : [];

  // --- selección múltiple / lote ---
  const toggleSel = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allVisibleSel = list.length > 0 && list.every((a) => selected.has(a.id));
  const toggleSelAll = () => setSelected(() => (allVisibleSel ? new Set() : new Set(list.map((a) => a.id))));
  const selIds = [...selected].filter((id) => assets.some((a) => a.id === id));
  const bulk = (patch: Partial<Asset>) => { if (selIds.length) bulkUpdateAssets(selIds, patch); };

  // --- importación CSV (crea por ID inexistente/vacío, actualiza por ID existente) ---
  const nameToUid = (n: string) => tenant.members.find((m) => m.name.trim().toLowerCase() === n.trim().toLowerCase())?.uid ?? null;
  const statusFromLabel = (l: string): AssetStatus | undefined => ASSET_STATUS.find((s) => s.label.toLowerCase() === l.trim().toLowerCase())?.key;
  const parseDay = (s: string): number | undefined => { const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/.exec(s.trim()); if (!m) return undefined; const y = +m[3]! < 100 ? 2000 + +m[3]! : +m[3]!; const d = new Date(y, +m[2]! - 1, +m[1]!); return isNaN(d.getTime()) ? undefined : d.getTime(); };
  const parseCsvText = (text: string) => {
    const clean = text.replace(/^﻿/, '');
    const delim = (clean.split('\n')[0] ?? '').includes(';') ? ';' : ',';
    const rows: string[][] = []; let cur: string[] = [], val = '', inQ = false;
    for (let i = 0; i < clean.length; i++) { const c = clean[i]!;
      if (inQ) { if (c === '"') { if (clean[i + 1] === '"') { val += '"'; i++; } else inQ = false; } else val += c; }
      else if (c === '"') inQ = true;
      else if (c === delim) { cur.push(val); val = ''; }
      else if (c === '\n') { cur.push(val); rows.push(cur); cur = []; val = ''; }
      else if (c !== '\r') val += c;
    }
    if (val || cur.length) { cur.push(val); rows.push(cur); }
    const header = (rows.shift() ?? []).map((h) => h.trim().toLowerCase());
    const idx = (name: string) => header.indexOf(name);
    const col = { id: idx('id'), name: idx('nombre'), tag: idx('etiqueta'), type: idx('tipo'), serial: idx('nº serie'), status: idx('estado'), assignee: idx('asignado a'), site: idx('sede'), dept: idx('departamento'), vendor: idx('fabricante'), model: idx('modelo'), buy: idx('compra'), warr: idx('garantía'), cost: idx('coste') };
    const create: Partial<Asset>[] = []; const update: { id: string; patch: Partial<Asset> }[] = []; let skipped = 0;
    const get = (r: string[], i: number) => (i >= 0 ? (r[i] ?? '').trim() : '');
    for (const r of rows) {
      if (r.every((c) => !c.trim())) continue;
      const patch: Partial<Asset> = {};
      const nm = get(r, col.name); if (nm) patch.name = nm;
      const tag = get(r, col.tag); if (tag) patch.tag = tag;
      const ty = get(r, col.type); if (ty) patch.productType = ty;
      const se = get(r, col.serial); if (se) patch.serial = se;
      const st = statusFromLabel(get(r, col.status)); if (st) patch.status = st;
      const asn = get(r, col.assignee); if (asn) patch.assignedTo = nameToUid(asn);
      const si = get(r, col.site); if (si) patch.site = si;
      const dp = get(r, col.dept); if (dp) patch.department = dp;
      const vn = get(r, col.vendor); if (vn) patch.vendor = vn;
      const md = get(r, col.model); if (md) patch.model = md;
      const bd = parseDay(get(r, col.buy)); if (bd) patch.purchaseDate = bd;
      const wd = parseDay(get(r, col.warr)); if (wd) patch.warrantyUntil = wd;
      const co = get(r, col.cost).replace(',', '.'); if (co && !isNaN(+co)) patch.cost = +co;
      if (Object.keys(patch).length === 0) { skipped++; continue; }
      const id = get(r, col.id);
      if (id && assets.some((a) => a.id === id)) update.push({ id, patch });
      else create.push(patch);
    }
    setCsv({ create, update, skipped });
  };
  const onCsvFile = (f?: File) => { if (!f) return; const rd = new FileReader(); rd.onload = () => parseCsvText(String(rd.result ?? '')); rd.readAsText(f); };
  const applyCsv = () => { if (!csv) return; for (const u of csv.update) updateAsset(u.id, u.patch); for (const c of csv.create) addAsset(c); setCsv(null); };

  return <>
    <input ref={fileRef} type="file" accept=".csv,text/csv" style={{ display: 'none' }} onChange={(e) => { onCsvFile(e.target.files?.[0]); e.target.value = ''; }} />
    <div className="hd">
      <h1>Activos</h1>
      <span className="sub">{tenant.name} · {hasFilter ? `${list.length} de ${assets.length}` : assets.length} activos</span>
      <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
        {canManage && <button className="ghost sm" onClick={() => fileRef.current?.click()} title="Importar/actualizar desde CSV"><Icon name="inbox" size={14} /> Importar CSV</button>}
        <button className="ghost sm" onClick={exportCsv} disabled={list.length === 0} title="Exportar la vista actual a CSV"><Icon name="file-text" size={14} /> Exportar CSV</button>
        {canManage && <button className="primary" onClick={() => { const id = addAsset({ name: 'Nuevo activo', status: 'in_stock' }); setSelId(id); }}>＋ Nuevo activo</button>}
      </div>
    </div>
    <div className="astats">
      {ASSET_STATUS.map((s) => <button key={s.key} className={'astat' + (fStatus === s.key ? ' on' : '')} onClick={() => setFStatus(fStatus === s.key ? '' : s.key)}>
        <span className="sdot" style={{ background: s.color }} /><span className="astat-l">{s.label}</span><b className="mono">{stat(s.key)}</b></button>)}
    </div>
    <div className="card fbar" style={{ marginTop: 10 }}>
      <label className="searchbox"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" /></svg><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nombre, etiqueta, serie, persona, sede…" /></label>
      <select value={fType} onChange={(e) => setFType(e.target.value)}><option value="">Tipo: todos</option>{ASSET_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</select>
      <select value={fStatus} onChange={(e) => setFStatus(e.target.value)}><option value="">Estado: todos</option>{ASSET_STATUS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select>
      <select value={fSite} onChange={(e) => setFSite(e.target.value)}><option value="">Sede: todas</option>{sites.map((s) => <option key={s} value={s}>{s}</option>)}</select>
      <SearchSelect value={fAssignee} onChange={setFAssignee} members={tenant.members} extras={[{ value: '', label: 'Asignado: todos' }, { value: '__none__', label: '— Sin asignar —' }]} placeholder="Asignado: todos" />
      {hasFilter && <button className="ghost sm" onClick={() => { setQ(''); setFType(''); setFStatus(''); setFSite(''); setFAssignee(''); }}>Limpiar</button>}
    </div>
    {canManage && selIds.length > 0 && <div className="bulkbar">
      <span className="bb-count"><b>{selIds.length}</b> seleccionado{selIds.length > 1 ? 's' : ''}</span>
      <select value="" onChange={(e) => { if (e.target.value) { bulk({ status: e.target.value as AssetStatus }); e.currentTarget.value = ''; } }}><option value="">Estado…</option>{ASSET_STATUS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select>
      <SearchSelect value="" onChange={(v) => bulk({ assignedTo: v === '__none__' ? null : v })} members={tenant.members} extras={[{ value: '__none__', label: '— Sin asignar —' }]} placeholder="Reasignar a…" />
      <select value="" onChange={(e) => { if (e.target.value) { bulk({ site: e.target.value }); e.currentTarget.value = ''; } }}><option value="">Sede…</option>{sites.map((s) => <option key={s} value={s}>{s}</option>)}</select>
      <button className="ghost sm" style={{ color: 'var(--crit)' }} onClick={() => { if (confirm(`¿Eliminar ${selIds.length} activo(s)?`)) { removeAssets(selIds); setSelected(new Set()); } }}><Icon name="trash" size={13} /> Eliminar</button>
      <button className="ghost sm" style={{ marginLeft: 'auto' }} onClick={() => setSelected(new Set())}>Deseleccionar</button>
    </div>}
    <div className="card asset-scroll" style={{ marginTop: 12 }}>
      <table className="mgmt">
        <thead><tr>{canManage && <th className="chk"><input type="checkbox" checked={allVisibleSel} onChange={toggleSelAll} title="Seleccionar todo" /></th>}{sortTh('name', 'Activo')}{sortTh('productType', 'Tipo')}<th>Nº serie</th>{sortTh('status', 'Estado')}{sortTh('assignedTo', 'Asignado a')}<th>Sede</th>{sortTh('warrantyUntil', 'Garantía')}{canManage && <th aria-label="acciones" />}</tr></thead>
        <tbody>{list.map((a) => { const sv = assetStatusView(a.status); const mem = tenant.members.find((m) => m.uid === a.assignedTo); const exp = a.warrantyUntil && a.warrantyUntil < now; return <tr key={a.id} className={'mrow' + (selected.has(a.id) ? ' rowsel' : '')} onClick={() => setSelId(a.id)}>
          {canManage && <td className="chk" onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={selected.has(a.id)} onChange={() => toggleSel(a.id)} /></td>}
          <td><div><span className="nm">{a.name}</span>{a.tag && <span className="soft" style={{ display: 'block', fontSize: 11.5 }}>{a.tag}</span>}</div></td>
          <td className="soft">{a.productType ?? '—'}</td>
          <td className="soft mono" style={{ fontSize: 12 }}>{a.serial ?? '—'}</td>
          <td><span className="stbadge" style={{ color: sv.color, background: `color-mix(in srgb, ${sv.color} 14%, transparent)` }}>{sv.label}</span></td>
          <td>{mem ? <span className="who"><Avatar m={mem} /> <span className="soft">{mem.name}</span></span> : <span className="soft">Sin asignar</span>}</td>
          <td className="soft">{a.site ?? '—'}</td>
          <td className="soft" style={{ fontSize: 12, color: exp ? 'var(--crit)' : undefined }}>{a.warrantyUntil ? new Date(a.warrantyUntil).toLocaleDateString('es-ES') : '—'}</td>
          {canManage && <td className="chk" onClick={(e) => e.stopPropagation()}><button className="rowbtn" title="Acciones rápidas" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setRowMenu(rowMenu?.id === a.id ? null : { id: a.id, x: r.right, y: r.bottom }); }}>⋯</button></td>}
        </tr>; })}</tbody>
      </table>
      {list.length === 0 && <div className="empty" style={{ padding: 24 }}>{assets.length === 0 ? 'Todavía no hay activos. Crea el primero con «＋ Nuevo activo».' : 'Sin activos con estos filtros.'}</div>}
    </div>

    {sel && <div className="scrim tmodal-scrim" onClick={() => setSelId(null)}>
      <div className="tmodal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={'Activo ' + sel.name}>
        <div className="tmodal-h"><Icon name="server" size={16} /><b className="tmodal-title">{sel.name}</b><span className="soft mono" style={{ fontSize: 12 }}>{sel.id}</span><button className="dx" onClick={() => setSelId(null)} aria-label="Cerrar" style={{ marginLeft: 'auto' }}>×</button></div>
        <div className="tmodal-b"><div className="form">
          <label>{fcap('Nombre', true)}<input value={sel.name} disabled={!canManage} onChange={(e) => updateAsset(sel.id, { name: e.target.value })} /></label>
          <div className="nf-cols">
            <label>{fcap('Etiqueta / Asset tag')}<input value={sel.tag ?? ''} disabled={!canManage} onChange={(e) => updateAsset(sel.id, { tag: e.target.value })} /></label>
            <label>{fcap('Nº de serie')}<input value={sel.serial ?? ''} disabled={!canManage} onChange={(e) => updateAsset(sel.id, { serial: e.target.value })} /></label>
          </div>
          <div className="nf-cols">
            <label>{fcap('Tipo')}<select value={sel.productType ?? ''} disabled={!canManage} onChange={(e) => updateAsset(sel.id, { productType: e.target.value })}><option value="">—</option>{ASSET_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}{sel.productType && !ASSET_TYPES.includes(sel.productType) && <option value={sel.productType}>{sel.productType}</option>}</select></label>
            <label>{fcap('Estado')}<select value={sel.status} disabled={!canManage} onChange={(e) => updateAsset(sel.id, { status: e.target.value as AssetStatus })}>{ASSET_STATUS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select></label>
          </div>
          <div className="nf-cols">
            <label>{fcap('Asignado a')}<SearchSelect value={sel.assignedTo ?? ''} onChange={(v) => updateAsset(sel.id, { assignedTo: v || null })} members={tenant.members} extras={[{ value: '', label: '— Sin asignar —' }]} placeholder="— Sin asignar —" disabled={!canManage} /></label>
            <label>{fcap('Sede')}<select value={sel.site ?? ''} disabled={!canManage} onChange={(e) => updateAsset(sel.id, { site: e.target.value })}><option value="">—</option>{(tenant.sites ?? []).map((s) => <option key={s} value={s}>{s}</option>)}{sel.site && !(tenant.sites ?? []).includes(sel.site) && <option value={sel.site}>{sel.site}</option>}</select></label>
          </div>
          <div className="nf-cols">
            <label>{fcap('Departamento')}<select value={sel.department ?? ''} disabled={!canManage} onChange={(e) => updateAsset(sel.id, { department: e.target.value })}><option value="">—</option>{(tenant.departments ?? []).map((d) => <option key={d} value={d}>{d}</option>)}{sel.department && !(tenant.departments ?? []).includes(sel.department) && <option value={sel.department}>{sel.department}</option>}</select></label>
            <label>{fcap('Coste (€)')}<input type="number" value={sel.cost ?? ''} disabled={!canManage} onChange={(e) => updateAsset(sel.id, { cost: e.target.value ? Number(e.target.value) : null })} /></label>
          </div>
          <div className="nf-cols">
            <label>{fcap('Fabricante')}<input value={sel.vendor ?? ''} disabled={!canManage} onChange={(e) => updateAsset(sel.id, { vendor: e.target.value })} /></label>
            <label>{fcap('Modelo')}<input value={sel.model ?? ''} disabled={!canManage} onChange={(e) => updateAsset(sel.id, { model: e.target.value })} /></label>
          </div>
          <div className="nf-cols">
            <label>{fcap('Fecha de compra')}<input type="date" value={dayVal(sel.purchaseDate)} disabled={!canManage} onChange={(e) => updateAsset(sel.id, { purchaseDate: e.target.value ? Date.parse(e.target.value) : null })} /></label>
            <label>{fcap('Garantía hasta')}<input type="date" value={dayVal(sel.warrantyUntil)} disabled={!canManage} onChange={(e) => updateAsset(sel.id, { warrantyUntil: e.target.value ? Date.parse(e.target.value) : null })} /></label>
          </div>
          <label>{fcap('Notas')}<textarea rows={3} value={sel.notes ?? ''} disabled={!canManage} onChange={(e) => updateAsset(sel.id, { notes: e.target.value })} /></label>

          <div className="k" style={{ marginTop: 4 }}>Tickets vinculados ({linkedTickets.length})</div>
          {linkedTickets.length === 0 ? <span className="soft" style={{ fontSize: 12.5 }}>Sin tickets activos vinculados a este activo.</span>
            : <div className="asset-tks">{linkedTickets.map((t) => { const sv = statusView(tenant, t); return <button key={t.id} className="asset-tk" onClick={() => onOpenTicket(t.id)}>
              <span className="id mono">{t.id}</span><span className="subj">{t.subject}</span><span className="stbadge" style={{ color: sv.color, background: `color-mix(in srgb, ${sv.color} 14%, transparent)` }}>{sv.label}</span></button>; })}</div>}

          <div className="k" style={{ marginTop: 12 }}>Historial</div>
          {(sel.history ?? []).length === 0 ? <span className="soft" style={{ fontSize: 12.5 }}>Sin historial registrado.</span>
            : <div className="asset-hist">{[...(sel.history ?? [])].reverse().map((h, i) => {
              const when = new Date(h.at).toLocaleString('es-ES', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
              const txt = h.kind === 'create' ? 'Alta del activo'
                : h.kind === 'status' ? `Estado: ${assetStatusView(h.from ?? '').label} → ${assetStatusView(h.to ?? '').label}`
                  : `Asignado: ${h.from ? memberName(h.from) : 'Sin asignar'} → ${h.to ? memberName(h.to) : 'Sin asignar'}`;
              return <div key={i} className="ah-row"><span className="ah-when mono">{when}</span><span className="ah-txt">{txt}</span></div>;
            })}</div>}

          {canManage && <div style={{ display: 'flex', marginTop: 12 }}>
            <button className="ghost sm" style={{ color: 'var(--crit)' }} onClick={() => { if (confirm(`¿Eliminar el activo «${sel.name}» (${sel.id})?`)) { removeAsset(sel.id); setSelId(null); } }}><Icon name="trash" size={13} /> Eliminar activo</button>
          </div>}
        </div></div>
      </div>
    </div>}

    {canManage && rowMenu && (() => { const a = assets.find((x) => x.id === rowMenu.id); if (!a) return null; return <>
      <div className="rm-scrim" onClick={() => setRowMenu(null)} />
      <div className="rowmenu" style={{ position: 'fixed', top: rowMenu.y + 4, left: rowMenu.x } as CSS}>
        <div className="rm-sec">Cambiar estado</div>
        <div className="rm-status">{ASSET_STATUS.map((s) => <button key={s.key} className={a.status === s.key ? 'on' : ''} onClick={() => { updateAsset(a.id, { status: s.key }); setRowMenu(null); }}><span className="sdot" style={{ background: s.color }} />{s.label}</button>)}</div>
        <div className="rm-sec">Reasignar</div>
        <SearchSelect value={a.assignedTo ?? ''} onChange={(v) => { updateAsset(a.id, { assignedTo: v === '__none__' ? null : (v || null) }); setRowMenu(null); }} members={tenant.members} extras={[{ value: '__none__', label: '— Sin asignar —' }]} placeholder="Elegir persona…" />
        <div className="rm-div" />
        <button className="rm-item" onClick={() => { setSelId(a.id); setRowMenu(null); }}>Abrir ficha</button>
        <button className="rm-item danger" onClick={() => { setRowMenu(null); if (confirm(`¿Eliminar «${a.name}»?`)) removeAsset(a.id); }}>Eliminar</button>
      </div>
    </>; })()}

    {csv && <div className="scrim tmodal-scrim" onClick={() => setCsv(null)}>
      <div className="tmodal" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Importar CSV">
        <div className="tmodal-h"><Icon name="inbox" size={16} /><b className="tmodal-title">Importar CSV</b><button className="dx" onClick={() => setCsv(null)} aria-label="Cerrar" style={{ marginLeft: 'auto' }}>×</button></div>
        <div className="tmodal-b">
          <p>Detectado: <b>{csv.create.length}</b> activo(s) nuevo(s) y <b>{csv.update.length}</b> para actualizar{csv.skipped ? `; ${csv.skipped} fila(s) ignorada(s)` : ''}.</p>
          <p className="soft" style={{ fontSize: 12.5 }}>Se emparejan por la columna <b>ID</b> (existe → actualiza; vacío o no encontrado → nuevo). «Estado» por su etiqueta y «Asignado a» por el nombre exacto de la persona. Usa las mismas columnas que la exportación.</p>
          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <button className="primary" disabled={csv.create.length + csv.update.length === 0} onClick={applyCsv}>Aplicar {csv.create.length + csv.update.length} cambio(s)</button>
            <button className="ghost sm" onClick={() => setCsv(null)}>Cancelar</button>
          </div>
        </div>
      </div>
    </div>}
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
  // Vistas personales (Asignadas a mí / Mis solicitudes): filtro Pendientes (por
  // defecto) · Todas · Archivadas. Los archivados NO están en la suscripción en vivo
  // → se traen bajo demanda (acotados a la persona, conjunto pequeño).
  const isPersonal = scope === 'assigned' || scope === 'requester';
  const [arcMode, setArcMode] = useState<'pending' | 'all' | 'archived'>('pending');
  const [arcRows, setArcRows] = useState<StoredTicket[]>([]);
  const [arcLoaded, setArcLoaded] = useState(false);
  const [arcLoading, setArcLoading] = useState(false);
  // Al cambiar de ámbito (Asignadas ↔ Mis solicitudes) resetea el archivo cargado.
  useEffect(() => { setArcMode('pending'); setArcRows([]); setArcLoaded(false); }, [scope, user.uid]);
  useEffect(() => {
    if (!isPersonal || arcMode === 'pending' || arcLoaded || arcLoading) return;
    setArcLoading(true);
    (async () => {
      try {
        if (firebaseEnabled) {
          const out: StoredTicket[] = []; let after: ArchiveCursor = undefined; const opts = scope === 'requester' ? { requesterUid: user.uid } : { where: { field: 'technicianId' as const, value: user.uid } };
          for (let p = 0; p < 30; p++) { const { tickets, last } = await queryArchive(tenant.id, { ...opts, pageSize: 200, after }); out.push(...tickets); after = last; if (tickets.length < 200) break; }
          setArcRows(out);
        } else {
          setArcRows(tenant.tickets.filter((t) => t.archived && (scope === 'requester' ? t.requesterId === user.uid : t.technicianId === user.uid)));
        }
        setArcLoaded(true);
      } finally { setArcLoading(false); }
    })();
  }, [isPersonal, arcMode, arcLoaded, arcLoading, scope, user.uid, tenant.id, tenant.tickets]);

  const nonArch = tenant.tickets.filter((t) => !t.archived);
  let base: StoredTicket[];
  if (scope === 'requester') { const pend = nonArch.filter((t) => t.requesterId === user.uid); base = arcMode === 'archived' ? arcRows : arcMode === 'all' ? [...pend, ...arcRows] : pend; }
  else if (scope === 'assigned') { const pend = nonArch.filter((t) => t.technicianId === user.uid); base = arcMode === 'archived' ? arcRows : arcMode === 'all' ? [...pend, ...arcRows] : pend; }
  else if (filter === 'unassigned') base = nonArch.filter((t) => !t.technicianId);
  else if (filter === 'mine') base = nonArch.filter((t) => t.technicianId === user.uid);
  else base = nonArch;
  const all = nonArch;
  let list = base;
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
  const selected = tenant.tickets.find((t) => t.id === selectedId) ?? arcRows.find((t) => t.id === selectedId) ?? null;
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
        {isPersonal && <div className="tabs" style={{ marginBottom: 0 }}>
          {([['pending', 'Pendientes'], ['all', 'Todas'], ['archived', 'Archivadas']] as [typeof arcMode, string][]).map(([k, l]) =>
            <button key={k} className={arcMode === k ? 'on' : ''} onClick={() => setArcMode(k)}>{l}{k !== 'pending' && arcLoading && arcMode === k ? ' …' : ''}</button>)}
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
      <div className="tmodal fixed" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={'Solicitud ' + selected.id}>
        <div className="tmodal-h">
          <span className={'tchip-type ' + (selected.type === 'incident' ? 'inc' : 'pet')}>{typeIcon(selected.type)} {typeLabel(selected.type)}</span>
          <b className="tmodal-title"><span className="id">{selected.id}</span> · {selected.subject}</b>
          <button className="dx" onClick={() => select(null)} aria-label="Cerrar">×</button>
        </div>
        <div className="tmodal-b"><TicketDetail tenant={tenant} t={selected} canAct={canAct && !selected.archived} caps={caps} readOnly={readOnly || !!selected.archived} meName={meName} meUid={user.uid} /></div>
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

// ARCHIVO: tickets en estado terminal (Cerrada/Cancelada/Resuelta). NO se suscriben
// en vivo (serían ~23k); se consultan bajo demanda, paginados. Solo lectura. El
// solicitante ve solo los suyos. En modo local (demo) filtra los tickets locales.
function Archive({ tenant, role, caps, meName, meUid, cloud }: { tenant: TenantData; role: Role; user: ReturnType<typeof buildUser>; caps: string[]; meName: string; meUid: string; cloud: boolean }) {
  const isReq = role === 'requester';
  const PAGE = 100;
  const [rows, setRows] = useState<StoredTicket[]>([]);
  const [cursor, setCursor] = useState<ArchiveCursor>(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  // Filtros: categoría/estado/técnico + rango de fechas van al servidor; texto refina en cliente.
  const [catId, setCatId] = useState('');
  const [estado, setEstado] = useState('');
  const [tech, setTech] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [q, setQ] = useState('');
  const [idq, setIdq] = useState('');
  const [sel, setSel] = useState<StoredTicket | null>(null);
  const [err, setErr] = useState('');
  const nameOf = (uid?: string | null) => tenant.members.find((m) => m.uid === uid)?.name ?? '—';
  const cats = tenant.serviceCategories ?? [];
  const statuses = tenant.statuses ?? [];
  const techs = tenant.members.filter((m) => m.role !== 'requester');
  const fromMs = from ? new Date(from).getTime() : undefined;
  const toMs = to ? new Date(to).getTime() + 86399999 : undefined; // fin del día, inclusivo

  const loadPage = useCallback(async (reset: boolean, after?: ArchiveCursor) => {
    setLoading(true); setErr('');
    try {
      if (cloud) {
        // UNA igualdad indexada al servidor (prioridad categoría › técnico › estado);
        // el resto refina en cliente. El solicitante se acota a lo suyo (server).
        const where = catId ? { field: 'serviceCategoryId' as const, value: catId }
          : tech ? { field: 'technicianId' as const, value: tech }
          : estado ? { field: 'status' as const, value: estado } : null;
        const { tickets, last } = await queryArchive(tenant.id, { requesterUid: isReq ? meUid : null, where: isReq ? null : where, from: fromMs, to: toMs, pageSize: PAGE, after });
        setRows((r) => (reset ? tickets : [...r, ...tickets]));
        setCursor(last); setDone(tickets.length < PAGE);
      } else {
        const all = tenant.tickets.filter((t) => (t.archived ?? isArchivedStatus(t.status)) && (!isReq || t.requesterId === meUid))
          .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
        setRows(all); setDone(true);
      }
    } catch (e) { setErr('No se pudo cargar el archivo: ' + (e as Error).message); }
    finally { setLoading(false); }
  }, [cloud, tenant.id, tenant.tickets, isReq, meUid, catId, tech, estado, fromMs, toMs]);

  // Recarga desde el servidor al cambiar cualquier filtro de servidor.
  useEffect(() => { setRows([]); setCursor(null); setDone(false); void loadPage(true); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [tenant.id, catId, tech, estado, fromMs, toMs]);

  // Refino en cliente: todos los filtros + texto (sobre lo cargado).
  const ql = q.trim().toLowerCase();
  const filtered = rows.filter((t) =>
    (!catId || t.serviceCategoryId === catId) && (!estado || t.status === estado) && (!tech || t.technicianId === tech) &&
    (!ql || `${t.id} ${t.subject} ${nameOf(t.requesterId)} ${nameOf(t.technicianId)} ${t.status} ${t.serviceCategory ?? t.category ?? ''}`.toLowerCase().includes(ql)));
  const anyFilter = !!(catId || estado || tech || from || to || ql);
  const clear = () => { setCatId(''); setEstado(''); setTech(''); setFrom(''); setTo(''); setQ(''); };

  const openById = async () => {
    const raw = idq.trim(); if (!raw) return;
    const id = raw.startsWith('#') ? raw : '#' + raw;
    setErr('');
    if (cloud) { const t = await getTicketById(tenant.id, id).catch(() => null); if (t && (!isReq || t.requesterId === meUid)) setSel(t); else setErr(`No se encontró ${id}.`); }
    else { const t = tenant.tickets.find((x) => x.id === id); if (t) setSel(t); else setErr(`No se encontró ${id}.`); }
  };

  return <>
    <div className="hd">
      <h1>Archivo</h1>
      <span className="sub">Solo lectura · {rows.length} cargados{anyFilter ? ` · ${filtered.length} filtrados` : ''}{isReq ? ' · tus solicitudes' : ''}</span>
      <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input value={idq} onChange={(e) => setIdq(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void openById(); }} placeholder="Abrir por nº…" style={{ width: 150 }} />
        <button className="ghost" onClick={() => void openById()}>Abrir</button>
      </div>
    </div>
    <div className="card fbar">
      {!isReq && <><select value={catId} onChange={(e) => setCatId(e.target.value)} title="Categoría"><option value="">Categoría: todas</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
      <select value={tech} onChange={(e) => setTech(e.target.value)} title="Técnico"><option value="">Técnico: todos</option>{techs.map((m) => <option key={m.uid} value={m.uid}>{m.name}</option>)}</select></>}
      <select value={estado} onChange={(e) => setEstado(e.target.value)} title="Estado"><option value="">Estado: todos</option>{statuses.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}</select>
      <label className="fdate">Desde<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
      <label className="fdate">Hasta<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      <label className="searchbox"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" /></svg><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Texto (asunto, persona…)" /></label>
      {anyFilter && <button className="ghost sm" onClick={clear}>Limpiar</button>}
    </div>
    {err && <div className="closeerr" style={{ margin: '8px 0' }}>⚠ {err}</div>}
    <div className="card" style={{ overflow: 'hidden', marginTop: 12 }}>
      <table className="mgmt">
        <thead><tr><th>ID</th><th>Asunto</th><th>Solicitante</th><th>Técnico</th><th>Categoría</th><th>Prioridad</th><th>Estado</th><th>Creado</th></tr></thead>
        <tbody>{filtered.map((t) => { const pv = priorityView(tenant, t.priority); const sv = statusView(tenant, t); return <tr key={t.id} className="mrow" onClick={() => setSel(t)}>
          <td><span className="id">{t.id}</span></td>
          <td>{t.subject}</td>
          <td>{nameOf(t.requesterId)}</td>
          <td>{t.technicianId ? nameOf(t.technicianId) : '—'}</td>
          <td>{t.serviceCategory ?? t.category ?? '—'}</td>
          <td>{badge(pv.label, pv.color)}</td>
          <td><span className="stbadge" style={{ color: sv.color, background: `color-mix(in srgb, ${sv.color} 15%, transparent)` }}>{sv.label}</span></td>
          <td style={{ whiteSpace: 'nowrap' }}>{t.createdAt ? fmtDate(t.createdAt) : '—'}</td>
        </tr>; })}</tbody>
      </table>
      {filtered.length === 0 && !loading && <div className="empty" style={{ padding: 24 }}>{anyFilter ? 'Sin resultados con estos filtros.' : 'Sin tickets archivados.'}</div>}
    </div>
    <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 10 }}>
      {cloud && !done && <button className="ghost" onClick={() => void loadPage(false, cursor)} disabled={loading}>{loading ? 'Cargando…' : 'Cargar más'}</button>}
      {loading && <span className="soft" style={{ fontSize: 12 }}>Cargando…</span>}
      {done && rows.length > 0 && <span className="soft" style={{ fontSize: 12 }}>fin de resultados</span>}
    </div>
    {sel && <div className="scrim tmodal-scrim" onClick={() => setSel(null)}>
      <div className="tmodal fixed" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={'Archivo ' + sel.id}>
        <div className="tmodal-h">
          <span className={'tchip-type ' + (sel.type === 'incident' ? 'inc' : 'pet')}>{typeIcon(sel.type)} {typeLabel(sel.type)}</span>
          <b className="tmodal-title"><span className="id">{sel.id}</span> · {sel.subject}</b>
          <span className="pill" style={{ marginLeft: 8 }}>archivado</span>
          <button className="dx" onClick={() => setSel(null)} aria-label="Cerrar">×</button>
        </div>
        <div className="tmodal-b"><TicketDetail tenant={tenant} t={sel} canAct={false} caps={caps} readOnly meName={meName} meUid={meUid} /></div>
      </div>
    </div>}
  </>;
}

function TicketDetail({ tenant, t, canAct, caps, readOnly, meName, meUid }: { tenant: TenantData; t: StoredTicket; canAct: boolean; caps: string[]; readOnly: boolean; meName: string; meUid: string }) {
  const canAssign = canAct && caps.includes('assign');
  const canChangeStatus = canAct && caps.includes('changeStatus');
  const canClose = caps.includes('close');
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
  const setTicketAssets = useStore((s) => s.setTicketAssets);
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
  const statuses = tenant.statuses ?? [];
  const group = tenant.groups.find((g) => g.id === t.groupId);
  const allTechs = tenant.members.filter((m) => m.role === 'technician' || m.role === 'tenant_admin');
  const scoped = group ? allTechs.filter((m) => (m.groupIds ?? []).includes(group.id)) : [];
  // Con grupo asignado, el combo muestra SOLO sus técnicos; sin grupo, todos.
  const techs = (group ? scoped : allTechs)
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

    {/* Barra de estado: estado actual (coloreado) + estados a los que se puede ir (clic).
        El estado se guarda por NOMBRE (así lo trajo el histórico de SDP), mientras que
        las keys del ciclo son ids numéricos → resolvemos el estado actual por key O por
        nombre. Se RESPETA el flujo configurado siempre que defina transiciones para el
        estado actual; si no las define (estado fuera del ciclo o sin salidas), se ofrecen
        todos los estados del ciclo como recuperación para no dejar el ticket atascado. */}
    {(() => {
      let opts: { to: string; label: string }[] = [];
      if (lc) {
        const cur = lc.states.find((s) => s.key === t.status) ?? lc.states.find((s) => s.label === t.status);
        const flowKeys = cur && !cur.isTerminal ? lc.transitions.filter((tr) => tr.from === cur.key).map((tr) => tr.to).filter((k) => k !== cur.key) : [];
        if (flowKeys.length) {
          // El flujo define transiciones para este estado → se respeta tal cual.
          const set = new Set(flowKeys);
          const inc = lc.states.filter((s) => set.has(s.key) && !s.isTerminal);
          const term = lc.states.filter((s) => set.has(s.key) && s.isTerminal);
          opts = [...inc, ...term].map((s) => ({ to: s.label, label: s.label }));
        } else if (!cur || !cur.isTerminal) {
          // Sin flujo definido para este estado (fuera del ciclo, o nodo sin salidas):
          // recuperación → cualquier estado del ciclo (incluidos terminales).
          const inc = lc.states.filter((s) => s.label !== t.status && !s.isTerminal);
          const term = lc.states.filter((s) => s.label !== t.status && s.isTerminal);
          opts = [...inc, ...term].map((s) => ({ to: s.label, label: s.label }));
        } // cur terminal (Cerrada/Cancelada/Resuelta) → sin salidas
      } else {
        opts = noFlowNext(t.status).map((s) => ({ to: s, label: s }));
      }
      return <div className="statusflow">
        <span className="sf-cur" style={{ background: sv.color, borderColor: sv.color }}>{sv.label}{paused ? ' · ⏸' : ''}</span>
        {canAct && canChangeStatus && opts.length > 0 && <span className="sf-arrow">→</span>}
        {canAct && canChangeStatus && opts.map((o) => {
          const closing = isClosingStatus(tenant.statuses, o.to);
          const blocked = (closing && !canClose) || (closing && closeMissing.length > 0);
          const tip = closing && !canClose ? 'No tienes permiso para cerrar/resolver' : blocked ? `Falta: ${closeMissing.join(', ')}` : `Cambiar a «${o.label}»`;
          return <button key={o.to} className="sf-next" disabled={blocked} title={tip} onClick={() => { setCloseErr(''); setStatus(t.id, o.to); }}>{o.label}</button>;
        })}
      </div>;
    })()}

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
        {t.notifyEmails && <div><div className="k">Correos a notificar</div><span style={{ fontSize: 13 }}>{t.notifyEmails}</span></div>}
      </div>
      {(canAct || (t.assetIds ?? []).length > 0 || t.assets) && <div style={{ marginTop: 8 }}>
        <div className="k">Activos afectados</div>
        <AssetPicker tenant={tenant} value={t.assetIds ?? []} onChange={(ids) => setTicketAssets(t.id, ids)} disabled={!canAct} />
        {t.assets && !(t.assetIds ?? []).length && <div className="soft" style={{ fontSize: 12, marginTop: 4 }}>Texto importado: {t.assets}</div>}
      </div>}
      {t.impactDetails && <div style={{ marginTop: 8 }}><div className="k">Detalles del impacto</div><div style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{t.impactDetails}</div></div>}
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
        {statuses.length > 0 && canChangeStatus && <>
          <div className="section-t">Saltar a otro estado <span className="pill">fuera de flujo</span></div>
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
        <div className="section-t">Asignar técnico <span className="badge"><Icon name="zap" size={11} /> carga vía OrganiZate</span>{group && <span className="pill" style={{ marginLeft: 6 }}>grupo: {group.name}</span>}<button className="linkbtn" style={{ marginLeft: 'auto' }} onClick={() => autoAssign(t.id)} title="Asigna al técnico menos cargado del grupo">⚡ Auto-asignar</button></div>
        {group && scoped.length === 0 && <div className="empty" style={{ fontSize: 12 }}>El grupo «{group.name}» no tiene técnicos. Añádelos en Administración → Grupos de soporte.</div>}
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
              {k.assigneeUid && <span className="tmeta"><Icon name="user" size={12} /> {memberName(k.assigneeUid) ?? '—'}</span>}
              {k.dueAt && <span className="tmeta" style={{ color: !k.done && k.dueAt < Date.now() ? 'var(--crit)' : undefined }}><Icon name="calendar" size={12} /> {fmtDate(k.dueAt)}</span>}
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
      // Solo aprobadores CONFIGURADOS de la categoría (modo simplificado) o de la plantilla
      // (modo clásico) del ticket — nunca la lista completa de usuarios.
      const tplA = tenant.templates.find((x) => x.id === t.templateId);
      const catA = t.serviceCategoryId ? (tenant.serviceCategories ?? []).find((c) => c.id === t.serviceCategoryId) : undefined;
      const levels = tplA?.approvalLevels ?? catA?.approvalLevels ?? [];
      const approverUids = [...new Set(levels.flatMap((lv) => lv.approverUids))];
      const candidates = tenant.members.filter((m) => m.status === 'active' && m.uid !== meUid && approverUids.includes(m.uid));
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
        {canAct && candidates.length > 0 && <div style={{ marginTop: 12, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
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
        {canAct && candidates.length === 0 && approvals.length === 0 && <div style={{ fontSize: 12, color: 'var(--ink-faint)', marginTop: 12, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
          {t.serviceCategoryId ? 'Esta categoría de servicio' : 'Esta plantilla'} no tiene aprobadores configurados, por lo que no requiere aprobación.
        </div>}
      </div>;
    })()}

    {tab === 'adjuntos' && <div style={{ marginTop: 4 }}>
      {attachments.length === 0 && <div className="empty">Sin adjuntos.</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{attachments.map((a) => <div key={a.id} className="atrow">
        <span className="atname"><Icon name="paperclip" size={13} /> {(a.url || a.dataUrl) ? <a href={a.url || a.dataUrl} download={a.name} target="_blank" rel="noreferrer">{a.name}</a> : a.name}</span>
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
  // Sede: por defecto SIEMPRE «Base Site» (como en SDP); si no existe, la primera sede.
  const [site, setSite] = useState(() => defaultSite(tenant));
  const [notifyEmails, setNotifyEmails] = useState('');
  const [impactDetails, setImpactDetails] = useState('');
  const [assetIds, setAssetIds] = useState<string[]>([]);
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
    const id = create({ subject, description, category, subcategory: subcategory || undefined, item: item || undefined, priority, site: site || undefined, notifyEmails: notifyEmails || undefined, impactDetails: impactDetails || undefined, assetIds: assetIds.length ? assetIds : undefined, requesterId, serviceCategoryId: cat.id, type: tipo, udf });
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
    <div className="scrim tmodal-scrim" onClick={onClose}>
      <div className="tmodal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Nueva solicitud">
        <div className="tmodal-h"><b className="tmodal-title">＋ Nueva solicitud</b><button className="dx" onClick={onClose} aria-label="Cerrar">×</button></div>
        <div className="tmodal-b"><div className="form nf-form">
          <div className="nf-sec">
            <label>Tipo de solicitud
              <div className="seg" style={{ marginTop: 4 }}>
                <button type="button" className={tipo === 'incident' ? 'on' : ''} onClick={() => setTipo('incident')}>{typeIcon('incident')} Incidencia</button>
                <button type="button" className={tipo === 'service_request' ? 'on' : ''} onClick={() => setTipo('service_request')}>{typeIcon('service_request')} Petición</button>
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
            {lcName ? <div className="lc-hint"><Icon name="branch" size={13} /> Ciclo de vida: <b>{lcName}</b></div> : cat && <div className="lc-hint"><Icon name="branch" size={13} /> Sin flujo (estado libre)</div>}
          </div>
          <div className="nf-sec">
            <div className="nf-sec-h">Datos de la solicitud</div>
            <label>{fcap('Asunto', true)}<input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Resume la solicitud…" autoFocus /></label>
            <div className="nf-cols">
              <div className="nf-col">
                <label>{fcap('Prioridad', true)}<select value={priority} onChange={(e) => setPriority(e.target.value)}>{(pls?.priority ?? [{ name: 'Media' }]).map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}</select></label>
                <label>{fcap('Categoría')}<select value={category} onChange={(e) => { setCategory(e.target.value); setSubcategory(''); setItem(''); }}>{(tree.length ? tree.map((c) => c.name) : tenant.categories).map((c) => <option key={c} value={c}>{c}</option>)}</select></label>
                {subNode && subNode.items.length > 0 && <label>{fcap('Artículo')}<select value={item} onChange={(e) => setItem(e.target.value)}><option value="">— Seleccionar —</option>{subNode.items.map((it) => <option key={it} value={it}>{it}</option>)}</select></label>}
              </div>
              <div className="nf-col">
                {(tenant.sites ?? []).length > 0 && <label>{fcap('Sede')}<select value={site} onChange={(e) => setSite(e.target.value)}>{(tenant.sites ?? []).map((x) => <option key={x} value={x}>{x}</option>)}</select></label>}
                {catNode && catNode.subs.length > 0 && <label>{fcap('Subcategoría')}<select value={subcategory} onChange={(e) => { setSubcategory(e.target.value); setItem(''); }}><option value="">— Seleccionar —</option>{catNode.subs.map((sn) => <option key={sn.name} value={sn.name}>{sn.name}</option>)}</select></label>}
              </div>
            </div>
            {role !== 'requester' && <label>{fcap('Solicitante')}<select value={requesterId} onChange={(e) => setRequesterId(e.target.value)}>{requesters.map((m) => <option key={m.uid} value={m.uid}>{m.name}</option>)}</select></label>}
            <label>{fcap('Descripción')}<RichText value={description} onChange={setDescription} placeholder="Describe la solicitud con detalle…" disabled={readOnly} /></label>
          </div>
          {visCatFields.length > 0 && <div className="nf-sec">
            <div className="nf-sec-h">Campos de la categoría · {cat?.name}</div>
            <div className="nf-cols">
              <div className="nf-col">{visCatFields.filter((f) => (f.col ?? 1) === 1).map((f) => <label key={f.id}>{fcap(f.label, isMand(f))}{widget(f)}</label>)}</div>
              <div className="nf-col">{visCatFields.filter((f) => f.col === 2).map((f) => <label key={f.id}>{fcap(f.label, isMand(f))}{widget(f)}</label>)}</div>
            </div>
          </div>}
          <div className="nf-sec">
            <div className="nf-sec-h">Archivos adjuntos</div>
            <div className={'dropzone' + (dragOver ? ' over' : '')} onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={onDrop}>
              <label className="dz-pick">Arrastra y suelta archivos aquí, o <span className="linkbtn">selecciónalos</span>
                <input type="file" multiple style={{ display: 'none' }} onChange={(e) => { setFiles((fs) => [...fs, ...Array.from(e.target.files ?? [])]); e.target.value = ''; }} />
              </label>
            </div>
            {files.length > 0 && <div className="dz-list">{files.map((f, i) => <span key={i} className="dz-file"><Icon name="paperclip" size={12} /> {f.name} <span className="soft">({fmtSize(f.size)})</span><button className="xbtn" onClick={() => setFiles((fs) => fs.filter((_, j) => j !== i))} aria-label="Quitar">✕</button></span>)}</div>}
          </div>
          <div className="nf-sec">
            <div className="nf-sec-h">Más detalles</div>
            <label>{fcap('Detalles del impacto')}<textarea value={impactDetails} rows={2} onChange={(e) => setImpactDetails(e.target.value)} placeholder="A quién/qué afecta, alcance…" /></label>
            <label>{fcap('Activos / elementos afectados')}<AssetPicker tenant={tenant} value={assetIds} onChange={setAssetIds} suggest={(tenant.assets ?? []).filter((a) => a.assignedTo === requesterId)} /></label>
            <label>{fcap('Correos a notificar')}<input type="text" value={notifyEmails} onChange={(e) => setNotifyEmails(e.target.value)} placeholder="correo1@dominio.com, correo2@dominio.com…" /></label>
          </div>
          {readOnly && <div className="empty" style={{ fontSize: 12 }}><Icon name="eye" size={13} /> Modo lectura: no puedes crear la solicitud.</div>}
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <button className="primary" onClick={submit} disabled={!canSubmit}>Crear solicitud</button>
            <button className="ghost" onClick={onClose}>Cancelar</button>
          </div>
        </div></div>
      </div>
    </div>
  );
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
          <label className="chipsel" style={{ cursor: 'pointer' }}><input type="checkbox" checked={en} onChange={(e) => setType(c, tp, e.target.checked)} style={{ marginRight: 5 }} />{typeIcon(tp)} {typeLabel(tp)}</label>
          {en && <select value={c[tp]!.lifecycleId ?? ''} onChange={(e) => replace(c.id, { ...c, [tp]: { lifecycleId: e.target.value || null } })}>
            <option value="">— sin flujo (estado libre) —</option>{lcOpts(tp).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>}
        </div>; })}
        <div className="rule-row" style={{ marginTop: 8 }}><span className="rule-lbl">Ven la categoría</span>
          <ChipMulti options={tenant.userGroups ?? []} selected={c.userGroups ?? []} onChange={(ug) => upd(c.id, { userGroups: ug })} />
        </div>
        {(c.userGroups ?? []).length === 0 && <div className="soft" style={{ fontSize: 12, paddingLeft: 74 }}>vacío = la ven todos</div>}
        <div className="rule-row" style={{ marginTop: 8 }}><span className="rule-lbl">Grupo de soporte</span>
          <select value={c.groupId ?? ''} onChange={(e) => { const v = e.target.value; if (v) upd(c.id, { groupId: v }); else { const nc = { ...c }; delete nc.groupId; replace(c.id, nc); } }}>
            <option value="">— sin grupo (lo ven todos los técnicos) —</option>
            {(tenant.groups ?? []).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </div>
        <div className="soft" style={{ fontSize: 12, paddingLeft: 74 }}>Sus técnicos ven, cogen y reciben la asignación de los tickets de esta categoría.</div>
        <div className="rule-row" style={{ marginTop: 8 }}><span className="rule-lbl">Aprobaciones</span></div>
        <p className="soft" style={{ fontSize: 12, paddingLeft: 74, marginTop: 0 }}>Niveles que se crean al abrir un ticket de esta categoría. Solo estos aprobadores aparecerán en la pestaña «Aprobaciones». Vacío = no requiere visto bueno.</p>
        <div className="al-list" style={{ paddingLeft: 74 }}>
          {(c.approvalLevels ?? []).map((lv, li) => { const levels = c.approvalLevels ?? []; return <div key={lv.id} className="al-card">
            <div className="al-head">
              <span className="tt-num">{li + 1}</span>
              <input className="tt-text" value={lv.name} onChange={(e) => replace(c.id, { ...c, approvalLevels: levels.map((x) => (x.id === lv.id ? { ...x, name: e.target.value } : x)) })} placeholder="Nombre del nivel" />
              <select value={lv.rule} onChange={(e) => replace(c.id, { ...c, approvalLevels: levels.map((x) => (x.id === lv.id ? { ...x, rule: e.target.value as 'any' | 'all' } : x)) })} title="Regla de decisión"><option value="any">Basta con uno</option><option value="all">Deben aprobar todos</option></select>
              <button className="xbtn" onClick={() => { if (li === 0) return; const n = [...levels]; [n[li - 1], n[li]] = [n[li]!, n[li - 1]!]; replace(c.id, { ...c, approvalLevels: n }); }} disabled={li === 0} aria-label="Subir">↑</button>
              <button className="xbtn" onClick={() => { if (li >= levels.length - 1) return; const n = [...levels]; [n[li + 1], n[li]] = [n[li]!, n[li + 1]!]; replace(c.id, { ...c, approvalLevels: n }); }} disabled={li >= levels.length - 1} aria-label="Bajar">↓</button>
              <button className="xbtn" style={{ color: 'var(--crit)' }} onClick={() => replace(c.id, { ...c, approvalLevels: levels.filter((x) => x.id !== lv.id) })} aria-label="Eliminar">✕</button>
            </div>
            <div className="al-approvers">
              <span className="soft" style={{ fontSize: 12 }}>Aprobadores:</span>
              {tenant.members.filter((m) => m.role !== 'requester').map((m) => <button key={m.uid} className={'chipsel' + (lv.approverUids.includes(m.uid) ? ' on' : '')} onClick={() => replace(c.id, { ...c, approvalLevels: levels.map((x) => (x.id === lv.id ? { ...x, approverUids: x.approverUids.includes(m.uid) ? x.approverUids.filter((u) => u !== m.uid) : [...x.approverUids, m.uid] } : x)) })}>{m.name}</button>)}
              {lv.approverUids.length === 0 && <span className="soft" style={{ fontSize: 11, color: 'var(--crit)' }}>sin aprobadores → el nivel no hará nada</span>}
            </div>
          </div>; })}
        </div>
        <button className="linkbtn" style={{ marginLeft: 74 }} onClick={() => replace(c.id, { ...c, approvalLevels: [...(c.approvalLevels ?? []), { id: 'al-' + Date.now(), name: `Nivel ${(c.approvalLevels ?? []).length + 1}`, approverUids: [], rule: 'any' }] })}>＋ nivel de aprobación</button>
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
function Bell({ tenant, meUid, accessCount = 0, onReviewAccess }: { tenant: TenantData; meUid: string; accessCount?: number; onReviewAccess?: () => void }) {
  const markRead = useStore((s) => s.markNotifRead);
  const markAll = useStore((s) => s.markAllNotifsRead);
  const select = useStore((s) => s.select);
  const [open, setOpen] = useState(false);
  const mine = (tenant.notifications ?? []).filter((n) => n.forUid === meUid);
  const unread = mine.filter((n) => !n.read).length;
  const total = unread + accessCount; // el badge suma avisos + solicitudes de acceso pendientes
  return <div className="bellwrap">
    <button className="iconbtn" title="Avisos" aria-label="Avisos" onClick={() => setOpen((o) => !o)}><Icon name="bell" size={17} />{total > 0 && <span className="belldot">{total > 9 ? '9+' : total}</span>}</button>
    {open && <>
      <div className="bell-scrim" onClick={() => setOpen(false)} />
      <div className="bell-pop">
        <div className="bell-h"><b>Avisos</b>{unread > 0 && <button className="linkbtn" onClick={() => markAll()}>Marcar todo leído</button>}</div>
        <div className="bell-list">
          {accessCount > 0 && <button className="bell-item unread" style={{ background: 'var(--accent-soft)' }} onClick={() => { setOpen(false); onReviewAccess?.(); }}>
            <div className="bell-txt"><Icon name="user-check" size={13} /> {accessCount} solicitud{accessCount > 1 ? 'es' : ''} de acceso pendiente{accessCount > 1 ? 's' : ''}</div>
            <div className="bell-sub">Revisar en Solicitudes de acceso →</div>
          </button>}
          {mine.length === 0 && accessCount === 0 && <div className="empty">Sin avisos.</div>}
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
  ['Configuraciones de instancia', 'server', [['Marca (logo y color)', 'marca'], ['Sitios', 'maestros'], ['Horas operativas', 'horario'], ['Grupos de días festivos', 'horario'], ['Departamentos', 'maestros'], ['Moneda', null]]],
  ['Usuarios y permisos', 'users', [['Usuarios', 'miembros'], ['Solicitudes de acceso', 'accesos'], ['Roles', 'roles'], ['Grupos de usuarios', 'gruposusuarios'], ['Grupos de soporte', 'gruposoporte'], ['Acceso específico', null]]],
  ['Personalización', 'sliders', [['Estado', 'estado'], ['Categoría › Subcategoría › Artículo', 'categoria'], ['Valores (prioridad, impacto, urgencia, nivel, modo, tipos)', 'valores'], ['Matriz de prioridades', 'matriz'], ['Campos adicionales', 'campos']]],
  ['Plantillas y formularios', 'file-text', [['Categorías de servicio', 'catservicio'], ['Reglas del formulario', 'formreglas']]],
  ['Autoservicio y anuncios', 'megaphone', [['Base de conocimiento', null], ['Anuncios', 'anuncios'], ['Encuestas de satisfacción', null]]],
  ['Automatización', 'settings', [['Reglas de negocio', 'reglas'], ['SLA y horarios', 'sla'], ['Ciclos de vida', 'ciclos'], ['Reglas de notificación', 'notif'], ['Reglas de cierre', 'cierre'], ['Activadores · webhooks', 'webhooks'], ['Asignación automática', null]]],
  ['Configuración del correo', 'mail', [['Correo entrante → ticket', 'entrante'], ['Servidor de correo', null], ['Respuestas predefinidas', 'respuestas'], ['Plantillas de aviso', null]]],
  ['Gobierno y auditoría', 'shield', [['Registro de auditoría', 'auditoria'], ['Sincronización SDP', 'sync'], ['Integración OrganiZate', 'organizate'], ['Exportar / archivar', null]]],
];
const ADMIN_TITLE: Record<string, string> = { marca: 'Marca de la instancia', plantillas: 'Plantillas y formularios', categoria: 'Categoría › Subcategoría › Artículo', estado: 'Estado', valores: 'Valores del servicio de asistencia', matriz: 'Matriz de prioridades', horario: 'Horario laboral y festivos', maestros: 'Datos maestros · sedes, departamentos y grupos de usuarios', roles: 'Roles y permisos', notif: 'Reglas de notificación', ciclos: 'Ciclos de vida', sla: 'SLA y grupos de soporte', miembros: 'Usuarios', accesos: 'Solicitudes de acceso', gruposusuarios: 'Grupos de usuarios', gruposoporte: 'Grupos de soporte', cierre: 'Reglas de cierre', respuestas: 'Respuestas predefinidas', reglas: 'Reglas de negocio', webhooks: 'Activadores · webhooks salientes', anuncios: 'Anuncios', auditoria: 'Registro de auditoría', entrante: 'Correo entrante → ticket', campos: 'Campos adicionales', sync: 'Sincronización SDP → Atenza', formreglas: 'Reglas del formulario', organizate: 'Integración con OrganiZate', catservicio: 'Categorías de servicio' };

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
  return <div className="work">
    <StringListCard title="Sedes" list={tenant.sites ?? []} onChange={setSites} placeholder="Nueva sede…" />
    <StringListCard title="Departamentos" list={tenant.departments ?? []} onChange={setDepartments} placeholder="Nuevo departamento…" search />
  </div>;
}

// GRUPOS DE USUARIOS: perfilan el catálogo (qué categorías ve cada grupo). Muestra
// cuántos usuarios y cuántas categorías restringe cada uno.
function UserGroupsAdmin({ tenant }: { tenant: TenantData }) {
  const setUserGroups = useStore((s) => s.setUserGroups);
  const [nv, setNv] = useState('');
  const groups = tenant.userGroups ?? [];
  const memCount = (g: string) => tenant.members.filter((m) => (m.userGroups ?? []).includes(g)).length;
  const catCount = (g: string) => (tenant.serviceCategories ?? []).filter((c) => (c.userGroups ?? []).includes(g)).length;
  const add = () => { const v = nv.trim(); if (v && !groups.includes(v)) { setUserGroups([...groups, v]); setNv(''); } };
  return <div className="card" style={{ padding: 16 }}>
    <p className="cfg-lead">Los <b>grupos de usuarios</b> perfilan el catálogo de autoservicio: en cada <b>categoría de servicio</b> eliges qué grupos pueden verla, y en cada <b>usuario</b> a qué grupos pertenece. Sin restricción, la categoría la ve cualquier solicitante.</p>
    <div className="card" style={{ overflow: 'hidden' }}>
      <table className="mgmt"><thead><tr><th>Grupo</th><th>Usuarios</th><th>Categorías restringidas</th><th /></tr></thead>
        <tbody>{groups.map((g) => <tr key={g}><td><b>{g}</b></td><td>{memCount(g)}</td><td>{catCount(g)}</td><td style={{ textAlign: 'right' }}><button className="xbtn" style={{ color: 'var(--crit)' }} onClick={() => setUserGroups(groups.filter((x) => x !== g))} aria-label="Eliminar">✕</button></td></tr>)}</tbody></table>
      {groups.length === 0 && <div className="empty" style={{ padding: 20 }}>Sin grupos de usuarios.</div>}
    </div>
    <div className="designer"><input style={{ flex: 1, minWidth: 140 }} value={nv} onChange={(e) => setNv(e.target.value)} placeholder="Nuevo grupo de usuarios…" onKeyDown={(e) => e.key === 'Enter' && add()} /><button className="primary" onClick={add}>＋ Grupo</button></div>
  </div>;
}

// GRUPOS DE SOPORTE: técnicos que ven/cogen/reciben los tickets de una categoría.
// Asigna miembros aquí (clic en el chip); muestra nº de técnicos y de categorías.
function SupportGroupsAdmin({ tenant }: { tenant: TenantData }) {
  const addGroup = useStore((s) => s.addGroup);
  const removeGroup = useStore((s) => s.removeGroup);
  const updateMember = useStore((s) => s.updateMember);
  const [gn, setGn] = useState(''); const [q, setQ] = useState(''); const [openG, setOpenG] = useState<string | null>(tenant.groups[0]?.id ?? null);
  // Técnicos ordenados alfabéticamente (para el desplegable de alta).
  const techs = tenant.members.filter((m) => m.role !== 'requester').slice().sort((a, b) => a.name.localeCompare(b.name));
  const inGroup = (gid: string) => techs.filter((m) => (m.groupIds ?? []).includes(gid));
  const notIn = (gid: string) => techs.filter((m) => !(m.groupIds ?? []).includes(gid));
  const catCount = (gid: string) => (tenant.serviceCategories ?? []).filter((c) => c.groupId === gid).length;
  const setGroups = (m: UiMember, gids: string[]) => updateMember(m.uid, { groupIds: gids });
  const addTo = (m: UiMember, gid: string) => setGroups(m, [...(m.groupIds ?? []), gid]);
  const rmFrom = (m: UiMember, gid: string) => setGroups(m, (m.groupIds ?? []).filter((x) => x !== gid));
  const ql = q.trim().toLowerCase();
  const shown = tenant.groups.filter((g) => !ql || g.name.toLowerCase().includes(ql));
  return <div className="card" style={{ padding: 16 }}>
    <p className="cfg-lead">Un <b>grupo de soporte</b> agrupa a los técnicos que ven, cogen y reciben la asignación de los tickets de una categoría. Asigna sus miembros aquí; en <b>Categorías de servicio</b> eliges el grupo de cada categoría.</p>
    <div className="fbar">
      <label className="searchbox"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" /></svg><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar grupo…" /></label>
      <span className="soft" style={{ fontSize: 12 }}>{tenant.groups.length} grupos</span>
      <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6 }}>
        <input style={{ width: 200 }} value={gn} onChange={(e) => setGn(e.target.value)} placeholder="Nuevo grupo de soporte…" onKeyDown={(e) => { if (e.key === 'Enter' && gn.trim()) { addGroup(gn.trim()); setGn(''); } }} />
        <button className="primary" disabled={!gn.trim()} onClick={() => { addGroup(gn.trim()); setGn(''); }}>＋ Grupo</button>
      </span>
    </div>
    <div className="card" style={{ overflow: 'hidden', marginTop: 12 }}>
      {shown.map((g) => { const mem = inGroup(g.id); const open = openG === g.id; return <div key={g.id} className="grp-row">
        <div className="grp-head" onClick={() => setOpenG(open ? null : g.id)}>
          <span className="grp-caret">{open ? '▾' : '▸'}</span>
          <b className="grp-name">{g.name}</b>
          <span className="pill">{mem.length} téc.</span>
          <span className="pill">{catCount(g.id)} cat.</span>
          <button className="xbtn" style={{ marginLeft: 'auto', color: 'var(--crit)' }} title="Eliminar grupo" onClick={(e) => { e.stopPropagation(); if (confirm(`¿Eliminar el grupo «${g.name}»?`)) removeGroup(g.id); }}><Icon name="trash" size={14} /></button>
        </div>
        {open && <div className="grp-body">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            {mem.length === 0 && <span className="soft" style={{ fontSize: 12 }}>Sin técnicos en este grupo.</span>}
            {mem.map((m) => <span key={m.uid} className="pill">{m.name}<button className="xbtn" style={{ marginLeft: 4 }} onClick={() => rmFrom(m, g.id)} aria-label="Quitar">✕</button></span>)}
          </div>
          <select value="" style={{ marginTop: 8, maxWidth: 280 }} onChange={(e) => { const m = techs.find((x) => x.uid === e.target.value); if (m) addTo(m, g.id); }}>
            <option value="">＋ Añadir técnico…</option>
            {notIn(g.id).map((m) => <option key={m.uid} value={m.uid}>{m.name}</option>)}
          </select>
        </div>}
      </div>; })}
      {shown.length === 0 && <div className="empty" style={{ padding: 20 }}>{tenant.groups.length === 0 ? 'Sin grupos de soporte.' : 'Ningún grupo coincide.'}</div>}
    </div>
  </div>;
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
          <button className="ghost" onClick={loadMadrid} title="Añade los festivos oficiales de Madrid (nacionales + Comunidad + capital) de ese año"><Icon name="landmark" size={14} /> Cargar festivos de Madrid</button>
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

// ---- Marca por instancia: logo (incrustado y reescalado) + color + tagline ----
function readAsDataURL(f: File): Promise<string> {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result as string); r.onerror = () => rej(new Error('read')); r.readAsDataURL(f); });
}
// Reescala una imagen de mapa de bits a `maxPx` (lado mayor) y la exporta como
// PNG data URI, para no incrustar un logo pesado en el documento del tenant.
async function downscaleImage(f: File, maxPx: number): Promise<string> {
  const src = await readAsDataURL(f);
  const img = new Image(); await new Promise((res, rej) => { img.onload = () => res(null); img.onerror = () => rej(new Error('img')); img.src = src; });
  const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  c.getContext('2d')!.drawImage(img, 0, 0, w, h);
  return c.toDataURL('image/png');
}
// Quita claves vacías (Firestore no admite `undefined`).
function cleanBranding(b: Branding): Branding {
  const o: Branding = {};
  if (b.logoUrl) o.logoUrl = b.logoUrl;
  if (b.logoMarkUrl) o.logoMarkUrl = b.logoMarkUrl;
  if (b.primaryColor) o.primaryColor = b.primaryColor;
  if (b.loginTagline) o.loginTagline = b.loginTagline;
  return o;
}
function BrandingAdmin({ tenant }: { tenant: TenantData }) {
  const setBranding = useStore((s) => s.setBranding);
  const cur = useMemo(() => cleanBranding(tenant.branding ?? {}), [tenant.branding]);
  const [draft, setDraft] = useState<Branding>(cur);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { setDraft(cleanBranding(tenant.branding ?? {})); }, [tenant.id]); // reset al cambiar de instancia
  const dirty = JSON.stringify(cleanBranding(draft)) !== JSON.stringify(cur);
  const accent = draft.primaryColor || '#2f6bff';
  const initial = (tenant.name || 'A').slice(0, 1);

  const onFile = async (f: File | undefined) => {
    setErr(''); if (!f) return;
    if (!f.type.startsWith('image/')) { setErr('El archivo debe ser una imagen.'); return; }
    if (f.size > 1_000_000) { setErr('Imagen demasiado grande (máx. 1 MB).'); return; }
    setBusy(true);
    try {
      if (f.type === 'image/svg+xml' && f.size >= 100_000) throw new Error('svg');
      const url = f.type === 'image/svg+xml' ? await readAsDataURL(f) : await downscaleImage(f, 160);
      setDraft((d) => ({ ...d, logoUrl: url }));
    } catch { setErr('No se pudo procesar la imagen (¿SVG > 100 KB?).'); }
    setBusy(false);
  };

  return <>
    <div className="banner" style={{ marginBottom: 14 }}>La <b>marca</b> de esta instancia (logo y color) se muestra en la barra superior, en la pantalla de selección de instancia y en el acceso. El logo se <b>incrusta reescalado</b> para que sea ligero.</div>
    <div className="work" style={{ gridTemplateColumns: '1fr 300px', gap: 18 }}>
      <div className="card" style={{ display: 'grid', gap: 18, alignContent: 'start' }}>
        <label>Logo
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 8 }}>
            <div className="brand-logo-slot">{draft.logoUrl ? <img src={draft.logoUrl} alt="" /> : <span className="pick-glyph" style={{ background: accent, width: 46, height: 46, fontSize: 22 }}>{initial}</span>}</div>
            <label className="btn-file">{busy ? 'Procesando…' : 'Subir imagen'}<input type="file" accept="image/*" hidden disabled={busy} onChange={(e) => onFile(e.target.files?.[0])} /></label>
            {draft.logoUrl && <button className="ghost" onClick={() => setDraft((d) => ({ ...d, logoUrl: undefined }))}>Quitar</button>}
          </div>
        </label>
        <label>Color de marca
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
            <input type="color" value={accent} onChange={(e) => setDraft((d) => ({ ...d, primaryColor: e.target.value }))} style={{ width: 46, height: 32, padding: 2 }} />
            <input value={draft.primaryColor ?? ''} placeholder="#2f6bff" onChange={(e) => setDraft((d) => ({ ...d, primaryColor: e.target.value || undefined }))} style={{ width: 130 }} />
          </div>
        </label>
        <label>Frase de acceso (opcional)
          <input value={draft.loginTagline ?? ''} placeholder="p. ej. Portal de servicios" onChange={(e) => setDraft((d) => ({ ...d, loginTagline: e.target.value || undefined }))} style={{ marginTop: 8, width: '100%', boxSizing: 'border-box' }} />
        </label>
        {err && <div style={{ color: 'var(--crit)', fontSize: 12 }}>{err}</div>}
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="primary" disabled={!dirty || busy} onClick={() => setBranding(cleanBranding(draft))}>Guardar cambios</button>
          <button className="ghost" disabled={!dirty} onClick={() => setDraft(cur)}>Descartar</button>
        </div>
      </div>
      <div className="card" style={{ alignSelf: 'start' }}>
        <div className="lbl" style={{ marginBottom: 12 }}>Vista previa</div>
        <div className="brand-prev-top">
          {draft.logoUrl ? <img className="brand-logo" src={draft.logoUrl} alt="" /> : <span className="glyph" style={{ background: accent }}>{initial}</span>}
          <span className="brand-name">{tenant.name}</span><small>Atenza</small>
        </div>
        <div className="pick-inst brand-prev-card" style={{ ['--accent']: accent } as CSS}>
          <div className="pick-logo">{draft.logoUrl ? <img src={draft.logoUrl} alt="" /> : <span className="pick-glyph" style={{ background: accent }}>{initial}</span>}</div>
          <div className="pick-inst-name">{tenant.name}</div>
          {draft.loginTagline && <div className="pick-inst-meta">{draft.loginTagline}</div>}
        </div>
      </div>
    </div>
  </>;
}

const ADMIN_FIRST = ADMIN_AREAS.flatMap((a) => a[2]).find(([, k]) => k)?.[1] ?? 'catservicio';
function AdminConfig({ tenant }: { tenant: TenantData }) {
  // Sección activa en el store (adminSec) para poder navegar desde fuera (p. ej. la
  // campana → «Solicitudes de acceso»). Cae a la primera sección si está vacío/inválido.
  const secRaw = useStore((s) => s.adminSec);
  const setSec = useStore((s) => s.setAdminSec);
  const sec = secRaw && ADMIN_TITLE[secRaw] ? secRaw : ADMIN_FIRST;
  return <div className="adm">
    <nav className="adm-nav">
      {ADMIN_AREAS.map((a) => <Fragment key={a[0]}>
        <div className="adm-g"><span className="adm-ic"><Icon name={a[1]} size={15} /></span>{a[0]}</div>
        {a[2].map(([l, k]) => <button key={l} className={'adm-i' + (k ? '' : ' dim') + (k && k === sec ? ' on' : '')} disabled={!k} onClick={() => k && setSec(k)}>{l}{!k && <span className="soon">pronto</span>}</button>)}
      </Fragment>)}
    </nav>
    <div className="adm-pane">
      <div className="adm-crumb">{ADMIN_TITLE[sec] ?? sec}</div>
    {sec === 'marca' && <BrandingAdmin tenant={tenant} />}
    {sec === 'categoria' && <CategoryAdmin tenant={tenant} />}
    {sec === 'estado' && <StatusAdmin tenant={tenant} />}
    {sec === 'valores' && <ValuesAdmin tenant={tenant} />}
    {sec === 'roles' && <RolesAdmin tenant={tenant} />}
    {sec === 'matriz' && <MatrixAdmin tenant={tenant} />}
    {sec === 'horario' && <CalendarAdmin tenant={tenant} />}
    {sec === 'maestros' && <MasterDataAdmin tenant={tenant} />}
    {sec === 'gruposusuarios' && <UserGroupsAdmin tenant={tenant} />}
    {sec === 'gruposoporte' && <SupportGroupsAdmin tenant={tenant} />}
    {sec === 'notif' && <NotifAdmin tenant={tenant} />}
    {sec === 'ciclos' && <GraphEditor tenant={tenant} />}
    {sec === 'sla' && <SlaAdmin tenant={tenant} />}
    {sec === 'miembros' && <MembersAdmin tenant={tenant} />}
    {sec === 'accesos' && <AccessRequestsAdmin tenant={tenant} />}
    {sec === 'cierre' && <ClosureAdmin tenant={tenant} />}
    {sec === 'respuestas' && <ReplyTemplatesAdmin tenant={tenant} />}
    {sec === 'reglas' && <BusinessRulesAdmin tenant={tenant} />}
    {sec === 'webhooks' && <WebhooksAdmin tenant={tenant} />}
    {sec === 'anuncios' && <AnnouncementsAdmin tenant={tenant} />}
    {sec === 'auditoria' && <AuditAdmin tenant={tenant} />}
    {sec === 'entrante' && <InboundAdmin tenant={tenant} />}
    {sec === 'campos' && <CustomFieldsAdmin tenant={tenant} />}
    {sec === 'formreglas' && <FormRulesAdmin tenant={tenant} />}
    {sec === 'sync' && <SyncAdmin tenant={tenant} />}
    {sec === 'organizate' && <OrganizateAdmin tenant={tenant} />}
    {sec === 'catservicio' && <ServiceCategoriesAdmin tenant={tenant} />}
    </div>
  </div>;
}

// Paleta de iconos sugeridos para categorías de servicio (IT).

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
  const add = () => save([...rules, { id: 'fr-' + Date.now(), name: 'Nueva regla', enabled: false, templateIds: [], serviceCategoryIds: [], scope: 'both', match: 'all', conditions: [], actions: [] }]);
  const del = (id: string) => save(rules.filter((r) => r.id !== id));
  // campos disponibles = unión de los campos de las categorías de servicio elegidas; vacío = todas.
  const fieldsForCats = (catIds: string[]): [string, string][] => {
    const scs = (tenant.serviceCategories ?? []).filter((c) => !catIds.length || catIds.includes(c.id));
    const map = new Map<string, string>();
    for (const c of scs) for (const f of c.fields ?? []) if (!map.has(f.id)) map.set(f.id, f.label);
    return [...map.entries()];
  };
  const toggleCat = (r: FormRule, id: string) => { const cur = r.serviceCategoryIds ?? []; upd(r.id, { serviceCategoryIds: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] }); };
  return <div className="card" style={{ padding: 16 }}>
    <p className="cfg-lead">Mientras se rellena el formulario, si se cumplen las condiciones se aplican las acciones sobre los campos (ocultar, hacer obligatorio, deshabilitar…). Se evalúan en vivo al cambiar cualquier campo. Ámbito por <b>categoría de servicio</b> y por vista.</p>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {rules.length === 0 && <div className="empty">Sin reglas del formulario.</div>}
      {rules.map((r) => { const fields = fieldsForCats(r.serviceCategoryIds ?? []); return <div key={r.id} className="rule-card">
        <div className="rule-h">
          <label className="switch"><input type="checkbox" checked={r.enabled} onChange={(e) => upd(r.id, { enabled: e.target.checked })} /><span className="track" /></label>
          <input style={{ flex: 1, fontWeight: 600 }} value={r.name} onChange={(e) => upd(r.id, { name: e.target.value })} />
          <button className="xbtn" style={{ color: 'var(--crit)' }} onClick={() => del(r.id)} aria-label="Eliminar">✕</button>
        </div>
        <div className="rule-body">
          <div className="rule-row"><span className="rule-lbl">Categorías</span>
            <div className="fr-tpls">{(tenant.serviceCategories ?? []).map((sc) => <button key={sc.id} className={'chipsel' + ((r.serviceCategoryIds ?? []).includes(sc.id) ? ' on' : '')} onClick={() => toggleCat(r, sc.id)}>{sc.icon ? sc.icon + ' ' : ''}{sc.name}</button>)}
              {(r.serviceCategoryIds ?? []).length === 0 && <span className="soft" style={{ fontSize: 12, alignSelf: 'center' }}>todas</span>}</div>
          </div>
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
  const [sn, setSn] = useState(''); const [sr, setSr] = useState(60); const [sx, setSx] = useState(480);
  return <div className="card"><h2>SLA <span className="badge">{tenant.slas.length}</span></h2>
    <div className="facts" style={{ gridTemplateColumns: '1fr 90px 90px auto', alignItems: 'center', rowGap: 8 }}>
      <div className="k">Nombre</div><div className="k">Resp. (min)</div><div className="k">Resol. (min)</div><div className="k" />
      {tenant.slas.map((s) => <Fragment key={s.id}>
        <input value={s.name} onChange={(e) => updateSla(s.id, { name: e.target.value })} style={{ fontSize: 13, fontWeight: 600 }} />
        <input type="number" min={0} value={s.responseMins} onChange={(e) => updateSla(s.id, { responseMins: +e.target.value })} className="mono" style={{ fontSize: 12, width: 84 }} title={fmtMins(s.responseMins)} />
        <input type="number" min={0} value={s.resolveMins} onChange={(e) => updateSla(s.id, { resolveMins: +e.target.value })} className="mono" style={{ fontSize: 12, width: 84 }} title={fmtMins(s.resolveMins)} />
        <button className="ghost" style={{ color: 'var(--crit)' }} onClick={() => removeSla(s.id)}><Icon name="trash" size={14} /></button>
      </Fragment>)}
    </div>
    <div className="designer">
      <input style={{ flex: 1, minWidth: 120 }} value={sn} onChange={(e) => setSn(e.target.value)} placeholder="Nuevo SLA…" />
      <input type="number" min={0} value={sr} onChange={(e) => setSr(+e.target.value)} style={{ width: 90 }} title="Respuesta (min)" />
      <input type="number" min={0} value={sx} onChange={(e) => setSx(+e.target.value)} style={{ width: 90 }} title="Resolución (min)" />
      <button className="primary" onClick={() => { if (sn.trim()) { addSla(sn.trim(), sr, sx); setSn(''); } }}>＋ SLA</button>
    </div>
    <div className="banner" style={{ marginTop: 12 }}>El SLA solo consume en estados <b>En curso</b>; se pausa en <b>Detener temporizador</b>. Verificado en el motor (sla.ts). Los grupos de soporte se gestionan en su propia sección.</div>
  </div>;
}

const ROLE_LABEL: Record<Role, string> = { tenant_admin: 'Admin', technician: 'Técnico', requester: 'Solicitante' };
const STATUS_LABEL: Record<string, string> = { active: 'Activo', invited: 'Invitado', disabled: 'Deshabilitado' };
const STATUS_COLOR: Record<string, string> = { active: 'var(--ok)', invited: 'var(--warn)', disabled: 'var(--ink-faint)' };

// Bandeja de APROBACIONES de acceso: personas que entraron sin ficha y solicitaron
// acceso. Aprobar crea el usuario en el tenant + le da acceso; rechazar la descarta.
function AccessRequestsAdmin({ tenant }: { tenant: TenantData }) {
  const reqs = useStore((s) => s.accessRequests);
  const tenants = useStore((s) => s.db.tenants);
  const approve = useStore((s) => s.approveAccess);
  const reject = useStore((s) => s.rejectAccess);
  const [sel, setSel] = useState<Record<string, { tid: string; role: Role }>>({});
  const cfg = (uid: string) => sel[uid] ?? { tid: tenant.id, role: 'technician' as Role };
  return <div className="card" style={{ padding: 16 }}>
    <p className="cfg-lead">Personas que han iniciado sesión y solicitado acceso sin tener ficha. Al <b>aprobar</b> se crea el usuario en la instancia elegida con el rol indicado y obtiene acceso; al <b>rechazar</b> se descarta la solicitud.</p>
    {reqs.length === 0 && <div className="empty" style={{ padding: 24 }}>No hay solicitudes de acceso pendientes.</div>}
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {reqs.slice().sort((a, b) => b.at - a.at).map((r) => { const c = cfg(r.uid); return <div key={r.uid} className="lcstate" style={{ flexWrap: 'wrap', gap: 8 }}>
        <span className="av" style={{ background: 'var(--accent)' }}>{(r.name || r.email)[0]?.toUpperCase()}</span>
        <span style={{ flex: 1, minWidth: 160 }}><b style={{ fontSize: 13 }}>{r.name || r.email}</b><span style={{ display: 'block', fontSize: 11.5, color: 'var(--ink-faint)' }}>{r.email} · {fmtDate(r.at)}</span></span>
        <select value={c.tid} onChange={(e) => setSel({ ...sel, [r.uid]: { ...c, tid: e.target.value } })} title="Instancia">{tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
        <select value={c.role} onChange={(e) => setSel({ ...sel, [r.uid]: { ...c, role: e.target.value as Role } })} title="Rol">{(['tenant_admin', 'technician', 'requester'] as Role[]).map((x) => <option key={x} value={x}>{ROLE_LABEL[x]}</option>)}</select>
        <button className="primary" onClick={() => approve(r.uid, c.tid, c.role)}>Aprobar</button>
        <button className="ghost" style={{ color: 'var(--crit)' }} onClick={() => reject(r.uid)}>Rechazar</button>
      </div>; })}
    </div>
  </div>;
}

// USUARIOS: listado filtrable (texto · grupo de soporte · rol · estado) + ficha
// editable al seleccionar. Integra el «traspaso a Atenza» (enabled) — la pantalla
// separada de Traspaso se retira. Invitar = pre-crea la ficha (status invitado); la
// Cloud Function de auto-alta la vincula al primer login por email.
function MembersAdmin({ tenant }: { tenant: TenantData }) {
  const addMember = useStore((s) => s.addMember);
  const updateMember = useStore((s) => s.updateMember);
  const removeMember = useStore((s) => s.removeMember);
  const setMembersEnabled = useStore((s) => s.setMembersEnabled);
  const setImpersonate = useStore((s) => s.setImpersonate);
  const [q, setQ] = useState(''); const [fGroup, setFGroup] = useState(''); const [fRole, setFRole] = useState(''); const [fStatus, setFStatus] = useState('');
  const [sort, setSort] = useState<{ col: 'name' | 'role' | 'status' | 'enabled'; dir: 1 | -1 }>({ col: 'name', dir: 1 });
  const [selId, setSelId] = useState<string | null>(null);
  const [invite, setInvite] = useState(false); const [inName, setInName] = useState(''); const [inEmail, setInEmail] = useState(''); const [inRole, setInRole] = useState<Role>('technician');
  const [bulkGrp, setBulkGrp] = useState('');
  const ugOptions = tenant.userGroups ?? [];
  const groups = tenant.groups ?? [];
  const corp = tenant.members[0]?.email.split('@')[1] ?? 'digloservicer.com';
  const gName = (id: string) => groups.find((g) => g.id === id)?.name ?? id;
  const enabledCount = tenant.members.filter((m) => m.enabled).length;

  const ql = q.trim().toLowerCase();
  const sortVal = (m: UiMember): string | number =>
    sort.col === 'role' ? (m.roleName ?? ROLE_LABEL[m.role])
      : sort.col === 'status' ? (STATUS_LABEL[m.status] ?? m.status)
        : sort.col === 'enabled' ? (m.enabled ? 1 : 0)
          : m.name.toLowerCase();
  const list = tenant.members
    .filter((m) =>
      (!ql || `${m.name} ${m.email}`.toLowerCase().includes(ql)) &&
      (!fGroup || (m.groupIds ?? []).includes(fGroup)) &&
      (!fRole || m.role === fRole) &&
      (!fStatus || m.status === fStatus))
    .sort((a, b) => { const va = sortVal(a), vb = sortVal(b); const c = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb), 'es'); return c * sort.dir; });
  const sortTh = (col: typeof sort.col, label: string, extra?: import('react').CSSProperties) => <th onClick={() => setSort((s) => ({ col, dir: s.col === col ? (s.dir * -1 as 1 | -1) : 1 }))} style={{ cursor: 'pointer', userSelect: 'none', ...extra }}>{label}{sort.col === col ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}</th>;
  const sel = tenant.members.find((m) => m.uid === selId) ?? null;
  const toggleGroup = (m: UiMember, gid: string) => { const cur = m.groupIds ?? []; updateMember(m.uid, { groupIds: cur.includes(gid) ? cur.filter((x) => x !== gid) : [...cur, gid] }); };

  return <div className="card" style={{ padding: 16 }}>
    <div className="hd" style={{ marginBottom: 4 }}>
      <h2 style={{ margin: 0 }}>Usuarios <span className="badge">{tenant.members.length}</span></h2>
      <span className="sub">{enabledCount} en Atenza · {tenant.members.length - enabledCount} aún en SDP</span>
      <button className="primary" style={{ marginLeft: 'auto' }} onClick={() => setInvite(true)}>＋ Invitar usuario</button>
    </div>
    <div className="card fbar" style={{ marginTop: 10 }}>
      <label className="searchbox"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" /></svg><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nombre o correo…" /></label>
      <select value={fGroup} onChange={(e) => setFGroup(e.target.value)}><option value="">Grupo: todos</option>{groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select>
      <select value={fRole} onChange={(e) => setFRole(e.target.value)}><option value="">Tipo: todos</option>{(['tenant_admin', 'technician', 'requester'] as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</select>
      <select value={fStatus} onChange={(e) => setFStatus(e.target.value)}><option value="">Estado: todos</option>{['active', 'invited', 'disabled'].map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}</select>
      {(q || fGroup || fRole || fStatus) && <button className="ghost sm" onClick={() => { setQ(''); setFGroup(''); setFRole(''); setFStatus(''); }}>Limpiar</button>}
      <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
        <span className="soft" style={{ fontSize: 12 }}>Traspasar grupo:</span>
        <select value={bulkGrp} onChange={(e) => setBulkGrp(e.target.value)}><option value="">Grupo…</option>{groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select>
        <button className="ghost sm" disabled={!bulkGrp} onClick={() => setMembersEnabled(tenant.members.filter((m) => (m.groupIds ?? []).includes(bulkGrp)).map((m) => m.uid), true)}>Habilitar</button>
      </span>
    </div>
    <div className="card" style={{ overflow: 'hidden', marginTop: 12 }}>
      <table className="mgmt">
        <thead><tr>{sortTh('name', 'Usuario')}{sortTh('role', 'Tipo')}<th>Grupos de soporte</th>{sortTh('status', 'Estado')}{sortTh('enabled', 'En Atenza', { textAlign: 'center' })}</tr></thead>
        <tbody>{list.map((m) => <tr key={m.uid} className="mrow" onClick={() => setSelId(m.uid)}>
          <td><div className="who"><Avatar m={m} /><span><span className="nm">{m.name}</span><span style={{ display: 'block', fontSize: 11, color: 'var(--ink-faint)' }}>{m.email}{m.external ? ' · externo' : ''}</span></span></div></td>
          <td style={{ fontSize: 12 }}>{m.roleName ?? ROLE_LABEL[m.role]}</td>
          <td style={{ fontSize: 11, color: 'var(--ink-faint)' }}>{(m.groupIds ?? []).map(gName).join(', ') || '—'}</td>
          <td><span className="pill" style={{ color: STATUS_COLOR[m.status], borderColor: STATUS_COLOR[m.status] }}>{STATUS_LABEL[m.status]}</span></td>
          <td style={{ textAlign: 'center' }} onClick={(e) => e.stopPropagation()}><label className="switch"><input type="checkbox" checked={!!m.enabled} onChange={(e) => updateMember(m.uid, { enabled: e.target.checked })} /><span className="track" /></label></td>
        </tr>)}</tbody>
      </table>
      {list.length === 0 && <div className="empty" style={{ padding: 24 }}>Sin usuarios con estos filtros.</div>}
    </div>

    {/* Ficha del usuario */}
    {sel && <div className="scrim tmodal-scrim" onClick={() => setSelId(null)}>
      <div className="tmodal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={'Usuario ' + sel.name}>
        <div className="tmodal-h"><Avatar m={sel} /><b className="tmodal-title">{sel.name}</b><button className="dx" onClick={() => setSelId(null)} aria-label="Cerrar">×</button></div>
        <div className="tmodal-b"><div className="form">
          <label>{fcap('Nombre')}<input value={sel.name} onChange={(e) => updateMember(sel.uid, { name: e.target.value })} /></label>
          <label>{fcap('Correo')}<input value={sel.email} disabled title="El correo identifica al usuario; no se edita aquí" /></label>
          <div className="nf-cols">
            <label>{fcap('Tipo / rol')}{(tenant.roles ?? []).length > 0
              ? <select value={sel.roleName ?? ''} onChange={(e) => { const rd = (tenant.roles ?? []).find((r) => r.name === e.target.value); if (rd) updateMember(sel.uid, { roleName: rd.name, role: rd.base }); else updateMember(sel.uid, { roleName: undefined }); }}><option value="">{ROLE_LABEL[sel.role]} (base)</option>{(tenant.roles ?? []).map((r) => <option key={r.name} value={r.name}>{r.name}</option>)}</select>
              : <select value={sel.role} onChange={(e) => updateMember(sel.uid, { role: e.target.value as Role })}>{(['tenant_admin', 'technician', 'requester'] as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</select>}</label>
            <label>{fcap('Estado')}<select value={sel.status} onChange={(e) => updateMember(sel.uid, { status: e.target.value as UiMember['status'] })}>{['active', 'invited', 'disabled'].map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}</select></label>
          </div>
          <label className="te-vis"><span>Traspasado a Atenza (trabaja aquí, no en SDP)</span><button className={'toggle' + (sel.enabled ? ' on' : '')} onClick={() => updateMember(sel.uid, { enabled: !sel.enabled })} aria-label="En Atenza" /></label>
          <label className="te-vis"><span>Usuario externo (fuera del dominio {corp})</span><button className={'toggle' + (sel.external ? ' on' : '')} onClick={() => updateMember(sel.uid, { external: !sel.external })} aria-label="Externo" /></label>
          <div><div className="k" style={{ marginBottom: 4 }}>Grupos de soporte</div>
            {(() => { const assigned = groups.filter((g) => (sel.groupIds ?? []).includes(g.id)); const avail = groups.filter((g) => !(sel.groupIds ?? []).includes(g.id)).slice().sort((a, b) => a.name.localeCompare(b.name, 'es')); return <>
              {assigned.length === 0 ? <span className="soft" style={{ fontSize: 12 }}>Sin asignar grupos de soporte.</span>
                : <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{assigned.map((g) => <span key={g.id} className="pill">{g.name}<button className="xbtn" style={{ marginLeft: 4 }} onClick={() => toggleGroup(sel, g.id)} aria-label="Quitar">✕</button></span>)}</div>}
              {avail.length > 0 && <select value="" style={{ marginTop: 6, maxWidth: 260 }} onChange={(e) => { if (e.target.value) toggleGroup(sel, e.target.value); }}><option value="">＋ Añadir grupo de soporte…</option>{avail.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select>}
            </>; })()}
          </div>
          <div><div className="k" style={{ marginBottom: 4 }}>Grupos de usuarios (perfilado de catálogo)</div>
            {(() => { const assigned = sel.userGroups ?? []; const avail = ugOptions.filter((g) => !assigned.includes(g)).slice().sort((a, b) => a.localeCompare(b, 'es')); return <>
              {assigned.length === 0 ? <span className="soft" style={{ fontSize: 12 }}>Sin asignar grupos de usuarios.</span>
                : <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{assigned.map((g) => <span key={g} className="pill">{g}<button className="xbtn" style={{ marginLeft: 4 }} onClick={() => updateMember(sel.uid, { userGroups: assigned.filter((x) => x !== g) })} aria-label="Quitar">✕</button></span>)}</div>}
              {avail.length > 0 && <select value="" style={{ marginTop: 6, maxWidth: 260 }} onChange={(e) => { if (e.target.value) updateMember(sel.uid, { userGroups: [...assigned, e.target.value] }); }}><option value="">＋ Añadir grupo de usuarios…</option>{avail.map((g) => <option key={g} value={g}>{g}</option>)}</select>}
            </>; })()}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 6, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
            <button className="ghost" onClick={() => { setImpersonate(sel.uid); }}><Icon name="eye" size={13} /> Ver como este usuario</button>
            <button className="ghost" style={{ color: 'var(--crit)', marginLeft: 'auto' }} onClick={() => { if (confirm(`¿Eliminar a ${sel.name}?`)) { removeMember(sel.uid); setSelId(null); } }}><Icon name="trash" size={14} /> Eliminar</button>
          </div>
        </div></div>
      </div>
    </div>}

    {/* Invitar usuario */}
    {invite && <div className="scrim tmodal-scrim" onClick={() => setInvite(false)}>
      <div className="tmodal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Invitar usuario">
        <div className="tmodal-h"><b className="tmodal-title">Invitar usuario</b><button className="dx" onClick={() => setInvite(false)} aria-label="Cerrar">×</button></div>
        <div className="tmodal-b"><div className="form">
          <p className="cfg-lead">Se crea la ficha en estado <b>Invitado</b>. Cuando la persona entre con ese correo (Google/email), obtiene acceso automáticamente.</p>
          <label>{fcap('Nombre')}<input value={inName} onChange={(e) => setInName(e.target.value)} placeholder="Nombre y apellidos…" /></label>
          <label>{fcap('Correo', true)}<input value={inEmail} onChange={(e) => setInEmail(e.target.value)} placeholder="correo@dominio.com" /></label>
          <label>{fcap('Tipo / rol')}<select value={inRole} onChange={(e) => setInRole(e.target.value as Role)}>{(['tenant_admin', 'technician', 'requester'] as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</select></label>
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <button className="primary" disabled={!inEmail.trim()} onClick={() => { const em = inEmail.trim(); const ext = !em.toLowerCase().endsWith('@' + corp.toLowerCase()); addMember(inName.trim(), em, inRole, ext); setInName(''); setInEmail(''); setInvite(false); }}>Invitar</button>
            <button className="ghost" onClick={() => setInvite(false)}>Cancelar</button>
          </div>
        </div></div>
      </div>
    </div>}
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
      <button className="ghost" style={{ color: 'var(--crit)', marginLeft: 'auto' }} disabled={tenant.lifecycles.length <= 1} onClick={() => removeLifecycle()}><Icon name="trash" size={14} /> Borrar flujo</button>
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

