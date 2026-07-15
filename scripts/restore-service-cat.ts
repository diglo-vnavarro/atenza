// Reparación: re-asigna serviceCategoryId/serviceCategory/type a los tickets ACTIVOS
// que lo perdieron (el job sync-sdp los sobrescribió con `set` completo, deshaciendo
// la migración F4c). Como las plantillas ya no están en Firestore (F4c las borró),
// el mapa plantilla→group se toma del SNAPSHOT de backup. Dry-run por defecto.
//
//   GOOGLE_CLOUD_PROJECT=diglo-desk-pd TENANT=diglo-it \
//   BACKUP=scripts/backups/classic-diglo-it-2026-07-15.json [APPLY=1] npx tsx scripts/restore-service-cat.ts
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'node:fs';

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT ?? 'diglo-desk-pd';
const TENANT = process.env.TENANT ?? 'diglo-it';
const BACKUP = process.env.BACKUP ?? 'scripts/backups/classic-diglo-it-2026-07-15.json';
const APPLY = process.env.APPLY === '1';
const DEFAULT_CAT = 'Incidencias generales';

const MAP: { name: string; src?: string[]; srcNames?: string[] }[] = [
  { name: 'Incidencias generales', src: ['Plantillas generales de incidentes'] },
  { name: 'Reclamaciones de clientes', src: ['Reclamaciones  de Clientes'] },
  { name: 'Recovery', src: ['Recovery'] },
  { name: 'BI / Datos', src: ['Solicitudes BI'] },
  { name: 'PD', src: ['Solicitudes PD'] },
  { name: 'AI · Gemini', src: ['AI - Gemini'] },
  { name: 'Informes (Looker/Google)', src: ['Informes Looker'] },
  { name: 'ITSM BI', src: ['ITSM BI'] },
  { name: 'Alta de usuario', srcNames: ['Alta de usuarios internos'] },
  { name: 'Baja de usuario', srcNames: ['Baja de usuario interno', 'Baja de usuario externo'] },
  { name: 'Modificación / alta externos', srcNames: ['Modificación de usuario', 'Alta de usuarios externos'] },
  { name: 'Peticiones generales', src: ['Peticiones'] },
  { name: 'Waiver', src: ['Solicitud Waiver'] },
  { name: 'Operaciones · Liquidaciones deuda', src: ['Operaciones'] },
  { name: 'Tareas REO', src: ['Tareas REO'] },
  { name: 'Seguimiento Infoser/Diglo', src: ['Seguimiento Operativo Infoser/Diglo'] },
];

initializeApp({ projectId: PROJECT });
const db = getFirestore();
type Cat = { id: string; name: string; incident?: unknown; service_request?: unknown };

async function main() {
  const snap = JSON.parse(readFileSync(BACKUP, 'utf8')) as { templates: ({ _id: string; name?: string; group?: string })[] };
  const tplById = new Map(snap.templates.map((t) => [t._id, t]));
  const cats = ((await db.doc(`tenants/${TENANT}`).get()).data()?.serviceCategories ?? []) as Cat[];
  const catByName = new Map(cats.map((c) => [c.name, c]));
  const defCat = catByName.get(DEFAULT_CAT)!;
  const catOf = (tplId?: string): Cat => {
    const t = tplId ? tplById.get(tplId) : undefined;
    const spec = t && MAP.find((m) => (m.src?.includes(t.group ?? '') ?? false) || (m.srcNames?.includes(t.name ?? '') ?? false));
    return (spec && catByName.get(spec.name)) || defCat;
  };
  const typeOf = (cat: Cat, cur?: string): 'incident' | 'service_request' => {
    const ty = (cur ?? 'incident') as 'incident' | 'service_request';
    if (cat[ty]) return ty; return cat.incident ? 'incident' : 'service_request';
  };

  // Solo activos (archived=false): son los que el sync pudo tocar.
  const tks = (await db.collection(`tenants/${TENANT}/tickets`).where('archived', '==', false).get()).docs;
  const missing = tks.filter((d) => !d.data().serviceCategoryId);
  console.log(`${APPLY ? '' : 'DRY-RUN · '}activos: ${tks.length} · sin serviceCategoryId: ${missing.length}`);
  if (!APPLY) { missing.slice(0, 5).forEach((d) => { const cat = catOf(d.data().templateId as string); console.log(`  ${d.id} tpl=${d.data().templateId} → ${cat.name}`); }); console.log('Repite con APPLY=1.'); return; }

  let n = 0;
  for (let i = 0; i < missing.length; i += 400) {
    const batch = db.batch();
    for (const d of missing.slice(i, i + 400)) {
      const cat = catOf(d.data().templateId as string); const type = typeOf(cat, d.data().type as string);
      batch.set(d.ref, { serviceCategoryId: cat.id, serviceCategory: cat.name, type }, { merge: true }); n++;
    }
    await batch.commit();
  }
  console.log(`✓ ${n} tickets con categoría restaurada.`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
