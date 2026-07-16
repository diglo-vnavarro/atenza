// Solo lectura: inspecciona catálogo de estados, ciclos de vida, categorías y un
// ticket concreto para diagnosticar la disponibilidad de transiciones.
//   GOOGLE_CLOUD_PROJECT=diglo-desk-pd TENANT=diglo-it TICKET=24529 npx tsx scripts/inspect-status.ts
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT ?? 'diglo-desk-pd';
const TENANT = process.env.TENANT ?? 'diglo-it';
const TICKET = process.env.TICKET ?? '24529';
initializeApp({ projectId: PROJECT });
const db = getFirestore();

async function main() {
  const root = (await db.doc(`tenants/${TENANT}`).get()).data() ?? {};
  const statuses = (root.statuses ?? []) as { name: string; timer?: string }[];
  console.log('== STATUS CATALOG (tenant.statuses) ==');
  console.log(statuses.map((s) => `${s.name}${s.timer ? ' ['+s.timer+']' : ''}`).join(' | '));

  const lcs = (await db.collection(`tenants/${TENANT}/lifecycles`).get()).docs.map((d) => ({ _id: d.id, ...d.data() })) as any[];
  console.log(`\n== LIFECYCLES (${lcs.length}) ==`);
  for (const lc of lcs) {
    console.log(`\n[${lc._id}] ${lc.name}`);
    console.log('  states:', (lc.states ?? []).map((s: any) => `${s.key}=«${s.label}»${s.isInitial ? '*' : ''}${s.isTerminal ? '(T)' : ''}`).join(', '));
    console.log('  transitions:', (lc.transitions ?? []).map((t: any) => `${t.from}→${t.to}`).join(', '));
  }

  const cats = (root.serviceCategories ?? []) as any[];
  console.log(`\n== SERVICE CATEGORIES (${cats.length}) — lifecycle por tipo ==`);
  for (const c of cats) console.log(`  ${c.id} «${c.name}» inc=${c.incident?.lifecycleId ?? '-'} req=${c.service_request?.lifecycleId ?? '-'}`);

  // Buscar el ticket por id (docId o campo id)
  let tk: any = (await db.doc(`tenants/${TENANT}/tickets/${TICKET}`).get()).data();
  if (!tk) { const q = await db.collection(`tenants/${TENANT}/tickets`).where('id', '==', TICKET).limit(1).get(); tk = q.docs[0]?.data(); }
  if (!tk) { const q = await db.collection(`tenants/${TENANT}/tickets`).where('id', '==', `INC-${TICKET}`).limit(1).get(); tk = q.docs[0]?.data(); }
  console.log(`\n== TICKET ${TICKET} ==`);
  if (!tk) { console.log('  NO ENCONTRADO'); return; }
  console.log(`  id=${tk.id} type=${tk.type} status=«${tk.status}» archived=${tk.archived}`);
  console.log(`  serviceCategoryId=${tk.serviceCategoryId} serviceCategory=«${tk.serviceCategory}» templateId=${tk.templateId}`);
  const cat = cats.find((c) => c.id === tk.serviceCategoryId);
  const lcId = cat ? cat[tk.type]?.lifecycleId : null;
  const lc = lcs.find((l) => l._id === lcId);
  console.log(`  → lifecycle resuelto: ${lcId ?? 'NINGUNO'}${lc ? ' ('+lc.name+')' : ''}`);
  if (lc) {
    const onGraph = (lc.states ?? []).some((s: any) => s.key === tk.status);
    console.log(`  → ¿status es nodo del ciclo? ${onGraph} ${onGraph ? '' : '(status es NOMBRE de catálogo, no key del ciclo → sin transiciones)'}`);
    const out = (lc.transitions ?? []).filter((t: any) => t.from === tk.status);
    console.log(`  → transiciones salientes: ${out.length}`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
