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
import { runReport, reportToHtml, previousPeriod, DEFAULT_REPORTS, runTableReport, runMatrixReport, matrixToHtml, SCOPE_DB_FIELD, type ReportSchedule, type ReportDef, type ReportDimension, type SavedReport } from '../src/reports.js';
import type { Ticket } from '../src/model.js';

const APPLY = process.argv.includes('--apply');
const PROJECT = process.env.GOOGLE_CLOUD_PROJECT ?? 'diglo-desk-pd';
const TENANT = process.env.TENANT ?? 'diglo-it';
const LIVE = process.env.REPORTS_LIVE === '1';
const TEST_EMAIL = process.env.REPORTS_TEST_EMAIL ?? 'testerino-ia@digloservicer.com';
// Filtro opcional: enviar SOLO estos informes guardados (ids separados por coma). Vacío = todos.
const ONLY_IDS = (process.env.REPORT_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const NOW = Date.now();

initializeApp({ projectId: PROJECT });
const db = getFirestore();
const fmt = (t: number) => new Date(t).toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' });
// Tope de filas del Excel adjunto (base64 va inline en el doc `mail`, límite 1MB de Firestore).
const MAX_XLSX_ROWS = 5000;

// Envoltorio de marca para el email (cabecera Diglo ITSM + pie). `inner` = contenido del informe.
function emailShell(inner: string): string {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f4f6f9">`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f9;padding:24px 0"><tr><td align="center">`
    + `<table role="presentation" width="660" cellpadding="0" cellspacing="0" style="max-width:660px;background:#fff;border-radius:12px;overflow:hidden;font-family:system-ui,-apple-system,'Segoe UI',Arial,sans-serif;box-shadow:0 1px 4px rgba(20,30,60,.08)">`
    + `<tr><td style="background:#1b2a4a;padding:16px 28px"><span style="color:#fff;font-size:17px;font-weight:700;letter-spacing:.2px">Diglo ITSM</span><span style="color:#9fb3d1;font-size:13px;margin-left:8px;vertical-align:1px">· Informes</span></td></tr>`
    + `<tr><td style="padding:22px 28px 26px">${inner}</td></tr>`
    + `<tr><td style="padding:14px 28px;border-top:1px solid #eef0f4;color:#9aa3b2;font-size:11.5px">Enviado automáticamente por <b>Atenza</b> · Mesa de servicio Diglo ITSM. No respondas a este correo.</td></tr>`
    + `</table></td></tr></table></body></html>`;
}

// Adjunto Excel (.xlsx) con las filas del informe. Devuelve el adjunto en base64 (formato Nodemailer).
async function xlsxAttachment(name: string, columns: { key: string; label: string }[], rows: Record<string, string>[], label: (k: string, raw: string) => string): Promise<{ filename: string; content: string; encoding: 'base64' }> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Informe');
  const header = ws.addRow(columns.map((c) => c.label));
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1B2A4A' } }; });
  for (const row of rows.slice(0, MAX_XLSX_ROWS)) ws.addRow(columns.map((c) => label(c.key, row[c.key] ?? '')));
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  columns.forEach((c, i) => { ws.getColumn(i + 1).width = Math.min(44, Math.max(12, c.label.length + 4)); });
  const buf = await wb.xlsx.writeBuffer();
  const safe = name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_').slice(0, 60) || 'Informe';
  return { filename: `${safe}.xlsx`, content: Buffer.from(buf as ArrayBuffer).toString('base64'), encoding: 'base64' };
}

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
    const html = emailShell(reportToHtml(result, label(sch), fmt));
    const subject = `[Diglo ITSM] ${sch.name} · informe ${sch.unit === 'week' ? 'semanal' : 'mensual'}`;
    const to_ = LIVE ? sch.recipients : [TEST_EMAIL];
    console.log(`• ${sch.name} [${sch.unit}] ${fmt(from)}–${fmt(to - 1)}: ${result.total} tickets → ${to_.join(', ')}${LIVE ? '' : ' (TEST)'}`);
    previews.push(html);
    if (APPLY) await db.collection('mail').add({ to: to_, message: { subject, html } });
  }

  // --- Informes guardados programados (resumen / tabular / matriz) ---
  const periodTxt = (from?: number, to?: number) => (from != null && to != null ? `${fmt(from)} – ${fmt(to - 1)}` : 'Todo el histórico');
  type Attach = { filename: string; content: string; encoding: 'base64' };
  let sentSaved = 0;
  for (const rep of savedSched) {
    if (ONLY_IDS.length && !ONLY_IDS.includes(rep.id)) continue;
    try {
      const unit = rep.schedule!.unit, kind = rep.kind ?? 'summary';
      let inner = '', total = 0; const attachments: Attach[] = [];
      if (kind === 'table') {
        const scope = (rep.scopes ?? [])[0];
        if (!scope) { console.log(`• [guardado] ${rep.name}: sin ámbito, omitido`); continue; }
        const field = SCOPE_DB_FIELD[scope.field] ?? scope.field;
        const tickets = (await db.collection(`tenants/${TENANT}/tickets`).where(field, '==', scope.value).get()).docs.map((d) => d.data() as Ticket);
        let from: number | undefined, to: number | undefined;
        if (rep.period && rep.period !== 'none') ({ from, to } = previousPeriod(NOW, rep.period));
        const res = runTableReport(rep, tickets, from, to); total = res.total;
        const note = total > MAX_XLSX_ROWS ? `primeras ${MAX_XLSX_ROWS} de ${total} filas` : `${total} ${total === 1 ? 'fila' : 'filas'}`;
        inner = `<h1 style="margin:0 0 4px;font-size:19px;color:#1b2a4a">${rep.name}</h1>`
          + `<p style="margin:0 0 18px;color:#6b7688;font-size:13px">${periodTxt(from, to)} · <b>${total}</b> solicitudes</p>`
          + `<div style="padding:14px 16px;background:#eef3fb;border:1px solid #dce6f5;border-radius:8px;color:#1b2a4a;font-size:14px">📎 Los datos completos van en el <b>Excel adjunto</b> (${note}). El listado también está en Atenza → Informes.</div>`;
        attachments.push(await xlsxAttachment(rep.name, rep.columns ?? [], res.rows, colLabel));
      } else if (kind === 'matrix') {
        const { from, to } = previousPeriod(NOW, unit);
        const tickets = (await db.collection(`tenants/${TENANT}/tickets`).where('createdAt', '>=', from).where('createdAt', '<', to).get()).docs.map((d) => d.data() as Ticket);
        const res = runMatrixReport(rep, tickets, from, to); total = res.total; inner = matrixToHtml(res, dimLabel, fmt);
      } else {
        const { from, to } = previousPeriod(NOW, unit);
        const tickets = (await db.collection(`tenants/${TENANT}/tickets`).where('createdAt', '>=', from).where('createdAt', '<', to).get()).docs.map((d) => d.data() as Ticket);
        const res = runReport(rep, tickets, from, to); total = res.total; inner = reportToHtml(res, label(rep), fmt);
      }
      const html = emailShell(inner);
      const subject = `[Diglo ITSM] ${rep.name} · informe ${unit === 'week' ? 'semanal' : 'mensual'}`;
      const to_ = LIVE ? rep.schedule!.recipients : [TEST_EMAIL];
      console.log(`• [guardado] ${rep.name} [${kind}/${unit}]: ${total} tickets → ${to_.join(', ')}${LIVE ? '' : ' (TEST)'}${attachments.length ? ' +xlsx' : ''}`);
      previews.push(html);
      if (APPLY && to_.length) { await db.collection('mail').add({ to: to_, message: { subject, html, ...(attachments.length ? { attachments } : {}) } }); sentSaved++; }
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
