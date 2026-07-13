// Bootstrap de datos en Firestore (una sola vez). Usa firebase-admin con ADC de
// owner (salta las reglas). Siembra las instancias del seed, mapea el miembro
// superadmin a su uid REAL de Firebase, y crea platformAdmins + userTenants.
//
//   SUPERADMIN_UID=... SUPERADMIN_EMAIL=... \
//   GOOGLE_APPLICATION_CREDENTIALS=<adc> GOOGLE_CLOUD_PROJECT=diglo-desk-pd \
//   npx tsx scripts/bootstrap.ts
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { makeSeed } from '../src/data/seed.js';

const SUPERADMIN_UID = process.env.SUPERADMIN_UID;
const SUPERADMIN_EMAIL = process.env.SUPERADMIN_EMAIL ?? 'vnavarro@digloservicer.com';
if (!SUPERADMIN_UID) throw new Error('Falta SUPERADMIN_UID');

initializeApp({ projectId: process.env.GOOGLE_CLOUD_PROJECT ?? 'diglo-desk-pd' });
const db = getFirestore();

async function main() {
  const seed = makeSeed(Date.now());

  // Remapea el miembro cuyo email == superadmin a su uid real (para que las
  // reglas —que usan request.auth.uid— le den acceso como tenant_admin).
  for (const t of seed.tenants) {
    for (const mem of t.members) {
      if (mem.email.toLowerCase() === SUPERADMIN_EMAIL.toLowerCase() && mem.uid !== SUPERADMIN_UID) {
        const old = mem.uid; mem.uid = SUPERADMIN_UID!;
        if (t.capacity[old]) { t.capacity[SUPERADMIN_UID!] = t.capacity[old]!; delete t.capacity[old]; }
      }
    }
  }

  for (const t of seed.tenants) {
    await db.doc(`tenants/${t.id}`).set({ name: t.name, key: t.key, active: t.active, categories: t.categories, capacity: t.capacity });
    for (const mem of t.members) await db.doc(`tenants/${t.id}/members/${mem.uid}`).set(mem);
    for (const tk of t.tickets) await db.doc(`tenants/${t.id}/tickets/${tk.id}`).set(tk);
    for (const lc of t.lifecycles) if (lc.id) await db.doc(`tenants/${t.id}/lifecycles/${lc.id}`).set(lc);
    for (const tp of t.templates) await db.doc(`tenants/${t.id}/templates/${tp.id}`).set(tp);
    for (const s of t.slas) await db.doc(`tenants/${t.id}/slas/${s.id}`).set(s);
    for (const g of t.groups) await db.doc(`tenants/${t.id}/groups/${g.id}`).set(g);
    console.log(`✓ tenant ${t.id}: ${t.members.length} miembros, ${t.tickets.length} tickets, ${t.lifecycles.length} flujos`);
  }

  await db.doc(`platformAdmins/${SUPERADMIN_UID}`).set({ email: SUPERADMIN_EMAIL });
  await db.doc(`userTenants/${SUPERADMIN_UID}`).set({ tenantIds: seed.tenants.map((t) => t.id) });
  console.log(`✓ superadmin ${SUPERADMIN_EMAIL} (${SUPERADMIN_UID}) + userTenants [${seed.tenants.map((t) => t.id).join(', ')}]`);
  console.log('Bootstrap completo.');
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
