// ============================================================================
// Auto-alta de acceso — reintroducido de forma NO BLOQUEANTE (2026-07-18).
//
// Contexto: la versión anterior era un trigger BLOQUEANTE `beforeUserSignedIn`
// que, al fallar (audiencia del token mal), tumbó TODOS los inicios de sesión
// con `auth/error-code:-47`. Para que eso no pueda repetirse, el auto-alta ya
// NO está en el camino crítico del login: es un trigger de FONDO de Firestore
// que reacciona a la creación de una SOLICITUD DE ACCESO.
//
// Flujo: el usuario que entra sin acceso pulsa «Solicitar acceso» en la app,
// que crea `accessRequests/{uid}` (uid == su uid real, con su email). Este
// trigger comprueba si ese email ya figura como MIEMBRO de algún tenant; si es
// así, provisiona el acceso (reescribe la ficha con el uid real, deja el mapa
// id→uid y concede userTenants) y borra la solicitud. Si NO hay coincidencia,
// deja la solicitud para que un administrador la apruebe a mano.
//
// Nunca lanza: cualquier fallo se registra y no afecta a nada más (login, app).
//
// Despliegue (requiere Firebase CLI; es un trigger de fondo, sin problema de
// audiencia como el bloqueante):
//   cd functions && npm install && npm run build
//   firebase deploy --only functions:autoProvisionOnRequest --project diglo-desk-pd
// Requiere el índice de collection-group sobre members.email (ya en
// firestore.indexes.json). El acceso sigue funcionando por aprobación manual
// aunque este trigger no esté desplegado.
// ============================================================================
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { logger } from 'firebase-functions';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

initializeApp();
const db = getFirestore();

export const autoProvisionOnRequest = onDocumentCreated({ document: 'accessRequests/{uid}', region: 'europe-west1' }, async (event) => {
  const uid = event.params.uid;
  const data = event.data?.data() as { email?: string } | undefined;
  const email = data?.email?.toLowerCase();
  if (!uid || !email) return; // sin email no hay nada que emparejar

  try {
    // Idempotencia: si ya tiene acceso, cierra la solicitud y termina.
    const utSnap = await db.doc(`userTenants/${uid}`).get();
    if (((utSnap.get('tenantIds') as string[] | undefined) ?? []).length) {
      await db.doc(`accessRequests/${uid}`).delete().catch(() => undefined);
      return;
    }
    // Fichas de miembro con ese email en TODOS los tenants (collectionGroup).
    const matches = await db.collectionGroup('members').where('email', '==', email).get();
    if (matches.empty) return; // sin coincidencia → la deja para aprobación manual

    let provisioned = false;
    for (const doc of matches.docs) {
      const tid = doc.ref.parent.parent?.id;
      if (!tid) continue;
      try {
        await db.doc(`tenants/${tid}/members/${uid}`).set({ ...doc.data(), uid, status: 'active' }, { merge: true });
        if (doc.id !== uid) await db.doc(`tenants/${tid}/idmap/${doc.id}`).set({ uid, email }, { merge: true });
        await db.doc(`userTenants/${uid}`).set({ tenantIds: FieldValue.arrayUnion(tid) }, { merge: true });
        provisioned = true;
      } catch (e) {
        logger.error(`auto-alta: fallo provisionando tenant ${tid} para ${email}`, e);
      }
    }
    // Provisionado con éxito → cierra la solicitud (ya tiene acceso).
    if (provisioned) await db.doc(`accessRequests/${uid}`).delete().catch(() => undefined);
  } catch (e) {
    logger.error(`auto-alta: error inesperado para ${email}`, e);
  }
});
