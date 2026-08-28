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
import { runReport, reportToHtml, previousPeriod, DEFAULT_REPORTS, type ReportSchedule, type ReportDef } from '../src/reports.js';
import type { Ticket } from '../src/model.js';

const APPLY = process.argv.includes('--apply');
const PROJECT = process.env.GOOGLE_CLOUD_PROJECT ?? 'diglo-desk-pd';
const TENANT = process.env.TENANT ?? 'diglo-it';
const LIVE = process.env.REPORTS_LIVE === '1';
const TEST_EMAIL = process.env.REPORTS_TEST_EMAIL ?? 'testerino-ia@digloservicer.com';
const NOW = Date.now();

initializeApp({ projectId: PROJECT });
const db = getFirestore();
const fmt = (t: number) => new Date(t).toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' });

async function main(): Promise<void> {
  const root = (await db.doc(`tenants/${TENANT}`).get()).data() ?? {};
  const groups = (await db.collection(`tenants/${TENANT}/groups`).get()).docs.map((d) => ({ id: d.id, name: String(d.data().name ?? '') }));
  const members = (await db.collection(`tenants/${TENANT}/members`).get()).docs.map((d) => ({ uid: d.id, name: String(d.data().name ?? '') }));
  const tree = (root.classificationTree ?? []) as { id: string; name: string; services: { id: string; name: string; elements?: { id: string; name: string }[] }[] }[];
  const label = (def: ReportDef) => (key: string): string => {
    switch (def.dimension) {
      case 'group': return groups.find((g) => g.id === key)?.name ?? key;
      case 'technician': return key === '(sin asignar)' ? key : (members.find((m) => m.uid === key)?.name ?? key);
      case 'area': { for (const a of tree) if (a.id === key) return a.name; return key; }
      case 'service': { for (const a of tree) for (const s of a.services) if (s.id === key) return s.name; return key; }
      case 'element': { for (const a of tree) for (const s of a.services) for (const e of s.elements ?? []) if (e.id === key) return e.name; return key; }
      case 'type': return key === 'incident' ? 'Incidencia' : 'Petición';
      default: return key;
    }
  };

  let schedules = ((root.reportSchedules ?? []) as ReportSchedule[]).filter((s) => s.enabled);
  const preview = !schedules.length && !APPLY;
  if (preview) { console.log('(sin reportSchedules configurados → PREVIEW con los presets por defecto)'); schedules = DEFAULT_REPORTS.map((d) => ({ ...d, unit: 'week' as const, recipients: [TEST_EMAIL], enabled: true })); }
  if (!schedules.length) { console.log('No hay informes programados. Nada que enviar.'); return; }

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

  if (!APPLY) {
    const file = process.env.PREVIEW_FILE;
    if (file) { writeFileSync(file, previews.join('<hr style="margin:24px 0;border:none;border-top:1px solid #ddd">')); console.log(`\nPreview HTML → ${file}`); }
    console.log(`\n(dry-run: NO se encoló correo. --apply para enviar${LIVE ? '' : ' (a TEST salvo REPORTS_LIVE=1)'}.)`);
  } else {
    console.log(`\n✓ ${schedules.length} informe(s) encolados en la colección mail${LIVE ? '' : ' (a TEST — pon REPORTS_LIVE=1 para destinatarios reales)'}.`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error('ERROR:', (e as Error).message); process.exit(1); });
