// M2 (F2) — Job de INFORMES PROGRAMADOS. Lo dispara Cloud Scheduler (semanal). Lee los informes
// programados del tenant (reportSchedules), agrega los tickets del periodo ANTERIOR completo
// (semana/mes; activos + archivo) y ENCOLA el correo (colección `mail` → extensión
// firestore-send-email). Seguro por defecto: envía a TEST salvo REPORTS_LIVE=1.
//
//   dry-run (por defecto): renderiza y reporta; NO encola correo. PREVIEW_FILE=x.html guarda el HTML.
//   --apply: encola el correo (a TEST salvo REPORTS_LIVE=1).
//   GOOGLE_CLOUD_PROJECT=diglo-desk-pd TENANT=diglo-it npx tsx scripts/send-reports.ts [--apply]
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { writeFileSync } from 'node:fs';
import { runReport, reportToHtml, previousPeriod, DEFAULT_REPORTS, runTableReport, tableReportToHtml, runMatrixReport, matrixToHtml, SCOPE_DB_FIELD, type ReportSchedule, type ReportDef, type ReportDimension, type SavedReport } from '../src/reports.js';
import type { Ticket } from '../src/model.js';

const APPLY = process.argv.includes('--apply');
const PROJECT = process.env.GOOGLE_CLOUD_PROJECT ?? 'diglo-desk-pd';
const TENANT = process.env.TENANT ?? 'diglo-it';
const LIVE = process.env.REPORTS_LIVE === '1';
const TEST_EMAIL = process.env.REPORTS_TEST_EMAIL ?? 'testerino-ia@digloservicer.com';
// Filtro opcional: enviar SOLO estos informes guardados (ids separados por coma). Vacío = todos.
const ONLY_IDS = (process.env.REPORT_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
// Máximo de filas en el HTML del email (Firestore limita el doc a 1MB; el listado completo va en la app).
const MAX_EMAIL_ROWS = 300;
const NOW = Date.now();

initializeApp({ projectId: PROJECT });
const db = getFirestore();
const fmt = (t: number) => new Date(t).toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' });

async function main(): Promise<void> {
  const root = (await db.doc(`tenants/${TENANT}`).get()).data() ?? {};
  const groups = (await db.collection(`tenants/${TENANT}/groups`).get()).docs.map((d) => ({ id: d.id, name: String(d.data().name ?? '') }));
  const members = (await db.collection(`tenants/${TENANT}/members`).get()).docs.map((d) => ({ uid: d.id, name: String(d.data().name ?? '') }));
  const tree = (root.classificationTree ?? []) as { id: string; name: string; services: { id: string; name: string; elements?: { id: string; name: string }[] }[] }[];
  const dimLabel = (dim: ReportDimension, key: string): string => {
    switch (dim) {
      case 'group': return groups.find((g) => g.id === key)?.name ?? key;
      case 'technician': return key === '(sin asignar)' ? key : (members.find((m) => m.uid === key)?.name ?? key);
      case 'area': { for (const a of tree) if (a.id === key) return a.name; return key; }
      case 'service': { for (const a of tree) for (const s of a.services) if (s.id === key) return s.name; return key; }
      case 'element': { for (const a of tree) for (const s of a.services) for (const e of s.elements ?? []) if (e.id === key) return e.name; return key; }
      case 'type': return key === 'incident' ? 'Incidencia' : 'Petición';
      default: return key;
    }
  };
  const label = (def: ReportDef) => (key: string): string => dimLabel(def.dimension, key);
  // Humaniza una celda de informe TABULAR (grupo/técnico/solicitante→nombre; tipo; resto crudo).
  const colLabel = (colKey: string, raw: string): string => {
    if (!raw) return '';
    if (colKey === 'requester' || colKey === 'technician') return members.find((m) => m.uid === raw)?.name ?? raw;
    if (colKey === 'group') return groups.find((g) => g.id === raw)?.name ?? raw;
    if (colKey === 'type') return raw === 'incident' ? 'Incidencia' : 'Petición';
    if (colKey === 'area') return dimLabel('area', raw);
    if (colKey === 'service') return dimLabel('service', raw);
    if (colKey === 'element') return dimLabel('element', raw);
    if (colKey === 'createdAt' || colKey === 'resolvedAt') { const n = Number(raw); return Number.isFinite(n) && n > 0 ? fmt(n) : raw; }
    return raw;
  };

  // Informes GUARDADOS (biblioteca) con programación activa (nuevo modelo: subcolección reports).
  const savedSched = (await db.collection(`tenants/${TENANT}/reports`).get()).docs
    .map((d) => ({ ...(d.data() as SavedReport), id: d.id })).filter((r) => r.schedule?.enabled);
  // Informes programados legacy (reportSchedules en el doc del tenant).
  let schedules = ((root.reportSchedules ?? []) as ReportSchedule[]).filter((s) => s.enabled);
  const preview = !schedules.length && !savedSched.length && !APPLY;
  if (preview) { console.log('(sin informes programados → PREVIEW con los presets por defecto)'); schedules = DEFAULT_REPORTS.map((d) => ({ ...d, unit: 'week' as const, recipients: [TEST_EMAIL], enabled: true })); }
  if (!schedules.length && !savedSched.length) { console.log('No hay informes programados. Nada que enviar.'); return; }

  const previews: string[] = [];
  for (const sch of schedules) {
    const { from, to } = previousPeriod(NOW, sch.unit);
    const snap = await db.collection(`tenants/${TENANT}/tickets`).where('createdAt', '>=', from).where('createdAt', '<', to).get();
    const tickets = snap.docs.map((d) => d.data() as Ticket);
    const result = runReport(sch, tickets, from, to);
    const html = reportToHtml(result, label(sch), fmt);
    const subject = `Informe ${sch.unit === 'week' ? 'semanal' : 'mensual'} · ${sch.name} · ${fmt(from)}`;
    const to_ = LIVE ? sch.recipients : [TEST_EMAIL];
    console.log(`• ${sch.name} [${sch.unit}] ${fmt(from)}–${fmt(to - 1)}: ${result.total} tickets → ${to_.join(', ')}${LIVE ? '' : ' (TEST)'}`);
    previews.push(html);
    if (APPLY) await db.collection('mail').add({ to: to_, message: { subject, html } });
  }

  // --- Informes guardados programados (resumen / tabular / matriz) ---
  let sentSaved = 0;
  for (const rep of savedSched) {
    if (ONLY_IDS.length && !ONLY_IDS.includes(rep.id)) continue;
    try {
      const unit = rep.schedule!.unit, kind = rep.kind ?? 'summary';
      let html = '', total = 0;
      if (kind === 'table') {
        const scope = (rep.scopes ?? [])[0];
        if (!scope) { console.log(`• [guardado] ${rep.name}: sin ámbito, omitido`); continue; }
        const field = SCOPE_DB_FIELD[scope.field] ?? scope.field;
        const tickets = (await db.collection(`tenants/${TENANT}/tickets`).where(field, '==', scope.value).get()).docs.map((d) => d.data() as Ticket);
        let from: number | undefined, to: number | undefined;
        if (rep.period && rep.period !== 'none') ({ from, to } = previousPeriod(NOW, rep.period));
        const res = runTableReport(rep, tickets, from, to); total = res.total;
        // Cap de filas para no exceder el límite de 1MB del doc `mail` de Firestore.
        const capped = res.rows.length > MAX_EMAIL_ROWS ? { ...res, rows: res.rows.slice(0, MAX_EMAIL_ROWS) } : res;
        html = tableReportToHtml(capped, colLabel, fmt);
        if (res.rows.length > MAX_EMAIL_ROWS) html += `<p style="color:#777;font-size:12px;font-family:system-ui,Arial,sans-serif">Mostrando las primeras ${MAX_EMAIL_ROWS} de ${res.total} filas. El listado completo, en Atenza → Informes.</p>`;
      } else if (kind === 'matrix') {
        const { from, to } = previousPeriod(NOW, unit);
        const tickets = (await db.collection(`tenants/${TENANT}/tickets`).where('createdAt', '>=', from).where('createdAt', '<', to).get()).docs.map((d) => d.data() as Ticket);
        const res = runMatrixReport(rep, tickets, from, to); total = res.total; html = matrixToHtml(res, dimLabel, fmt);
      } else {
        const { from, to } = previousPeriod(NOW, unit);
        const tickets = (await db.collection(`tenants/${TENANT}/tickets`).where('createdAt', '>=', from).where('createdAt', '<', to).get()).docs.map((d) => d.data() as Ticket);
        const res = runReport(rep, tickets, from, to); total = res.total; html = reportToHtml(res, label(rep), fmt);
      }
      const subject = `Informe ${unit === 'week' ? 'semanal' : 'mensual'} · ${rep.name}`;
      const to_ = LIVE ? rep.schedule!.recipients : [TEST_EMAIL];
      console.log(`• [guardado] ${rep.name} [${kind}/${unit}]: ${total} tickets → ${to_.join(', ')}${LIVE ? '' : ' (TEST)'}`);
      previews.push(html);
      if (APPLY && to_.length) { await db.collection('mail').add({ to: to_, message: { subject, html } }); sentSaved++; }
    } catch (e) { console.error(`✗ [guardado] ${rep.name}: ${(e as Error).message}`); }
  }
  console.log(`  (${sentSaved} informes guardados encolados)`);

  if (!APPLY) {
    const file = process.env.PREVIEW_FILE;
    if (file) { writeFileSync(file, previews.join('<hr style="margin:24px 0;border:none;border-top:1px solid #ddd">')); console.log(`\nPreview HTML → ${file}`); }
    console.log(`\n(dry-run: NO se encoló correo. --apply para enviar${LIVE ? '' : ' (a TEST salvo REPORTS_LIVE=1)'}.)`);
  } else {
    console.log(`\n✓ ${schedules.length + savedSched.length} informe(s) encolados en la colección mail${LIVE ? '' : ' (a TEST — pon REPORTS_LIVE=1 para destinatarios reales)'}.`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error('ERROR:', (e as Error).message); process.exit(1); });
