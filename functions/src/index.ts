// Auto-onboarding: trigger de autenticación BLOQUEANTE (Identity Platform) que se
// dispara justo antes de completar el inicio de sesión (Google/email). Concede
// acceso automáticamente a quien ya figura como miembro de un tenant por su email,
// evitando que un usuario provisionado a mano tenga que esperar (hoy caen en
// "Sin acceso" porque su ficha está keyed por el id de SDP, no por su uid real).
//
// La app decide el acceso en startCloud (src/ui/store.ts): hay acceso sii existe
// userTenants/{uid} con tenantIds no vacío (o platformAdmins/{uid}). Aquí solo
// GARANTIZAMOS ese acceso rápido; la unificación/dedup pesada (reasignar tickets,
// borrar fichas viejas) la sigue haciendo el script manual scripts/provision-access.ts.
import { beforeUserSignedIn } from 'firebase-functions/v2/identity';
import { logger } from 'firebase-functions';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

initializeApp();
const db = getFirestore();

export const autoOnboard = beforeUserSignedIn(async (event) => {
  const uid = event.data?.uid;
  // Email autenticado en minúsculas (así se comparan las fichas de miembro).
  const email = event.data?.email?.toLowerCase();
  if (!uid || !email) return; // sin email no hay nada que emparejar → no-op

  try {
    // Idempotencia: si ya tiene acceso (userTenants con tenantIds), no tocamos nada.
    const utSnap = await db.doc(`userTenants/${uid}`).get();
    const already = (utSnap.get('tenantIds') as string[] | undefined) ?? [];
    if (already.length) return;

    // Fichas de miembro cuyo email coincide, en TODOS los tenants (collectionGroup).
    // Requiere un índice single-field de ALCANCE COLLECTION_GROUP sobre `email`
    // (ver firestore.indexes.json → fieldOverrides).
    const matches = await db.collectionGroup('members').where('email', '==', email).get();
    if (matches.empty) return; // email sin ficha → NO auto-alta (no hay autoservicio abierto)

    for (const doc of matches.docs) {
      // Derivamos el tenantId de la ruta del doc: tenants/{tid}/members/{docId}.
      const tid = doc.ref.parent.parent?.id;
      if (!tid) continue;
      try {
        const data = doc.data();
        // Reescribe la ficha keyed por el uid REAL para que la app lo reconozca
        // (merge: conserva los campos existentes; marca activo).
        await db.doc(`tenants/${tid}/members/${uid}`).set({ ...data, uid, status: 'active' }, { merge: true });
        // Si la ficha vieja estaba keyed por otro id (SDP), deja el mapa id→uid para
        // que la futura importación del histórico atribuya esos tickets al uid unificado.
        // NO borramos la ficha vieja ni reasignamos tickets: eso es tarea del script manual.
        if (doc.id !== uid) {
          await db.doc(`tenants/${tid}/idmap/${doc.id}`).set({ uid, email }, { merge: true });
        }
        // Concede acceso (índice userTenants que consulta la app).
        await db.doc(`userTenants/${uid}`).set({ tenantIds: FieldValue.arrayUnion(tid) }, { merge: true });
      } catch (e) {
        // Fallo aislado por tenant: lo registramos y seguimos con los demás.
        logger.error(`auto-onboarding: fallo provisionando tenant ${tid} para ${email}`, e);
      }
    }
  } catch (e) {
    // Defensivo: nunca bloqueamos un inicio de sesión legítimo por un fallo de
    // provisión. Registramos y permitimos entrar (sin provisionar).
    logger.error(`auto-onboarding: error inesperado para ${email}`, e);
  }
  // Devolver undefined permite el inicio de sesión sin modificar el token.
});
