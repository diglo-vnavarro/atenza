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
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

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

// ============================================================================
// Provisión DIRECTA de acceso por email (Fase 2 del portal) — callable.
//
// La invoca un ADMIN DE PLATAFORMA desde el portal para conceder acceso a una
// persona SIN esperar a que ésta pida acceso (el caso de un usuario que ya ha
// iniciado sesión pero cuya solicitud no llegó). El cliente NO puede resolver
// email → uid de Firebase Auth (es operación de Admin), de ahí esta función.
//
// Reglas: solo un platformAdmin puede llamarla; el usuario debe tener ya una
// cuenta (haber iniciado sesión al menos una vez). Escribe la ficha en su uid
// real, deja el idmap si había ficha de referencia, concede userTenants y borra
// cualquier solicitud pendiente. Equivale a lo que se hacía a mano por script.
//
// Despliegue: firebase deploy --only functions:adminProvisionAccess
// ============================================================================
const ROLES = ['tenant_admin', 'technician', 'requester'];
export const adminProvisionAccess = onCall({ region: 'europe-west1' }, async (req) => {
  const callerUid = req.auth?.uid;
  if (!callerUid) throw new HttpsError('unauthenticated', 'Debes iniciar sesión.');
  const isPA = (await db.doc(`platformAdmins/${callerUid}`).get()).exists;
  if (!isPA) throw new HttpsError('permission-denied', 'Solo un administrador de plataforma puede provisionar acceso.');

  const email = String((req.data as Record<string, unknown>)?.email ?? '').trim().toLowerCase();
  const tenantId = String((req.data as Record<string, unknown>)?.tenantId ?? '').trim();
  const role = String((req.data as Record<string, unknown>)?.role ?? 'technician');
  if (!email || !tenantId) throw new HttpsError('invalid-argument', 'Falta el email o la instancia.');
  if (!ROLES.includes(role)) throw new HttpsError('invalid-argument', 'Rol no válido.');
  if (!(await db.doc(`tenants/${tenantId}`).get()).exists) throw new HttpsError('not-found', 'La instancia no existe.');

  let userRec;
  try { userRec = await getAuth().getUserByEmail(email); }
  catch { throw new HttpsError('not-found', 'No hay ninguna cuenta con ese email. La persona debe iniciar sesión en Atenza al menos una vez antes de poder provisionar su acceso.'); }
  const uid = userRec.uid;

  // ¿había una ficha de referencia (id de SDP) con ese email? → idmap.
  const refMatch = await db.collection(`tenants/${tenantId}/members`).where('email', '==', email).limit(5).get();
  const refDoc = refMatch.docs.find((d) => d.id !== uid);
  const base = (refDoc?.data() ?? {}) as Record<string, unknown>;
  delete base.caps; // las capacidades se derivan del rol nuevo (no arrastrar las viejas)
  const member = { ...base, uid, email, name: (base.name as string) ?? userRec.displayName ?? email, role, status: 'active', enabled: true };
  await db.doc(`tenants/${tenantId}/members/${uid}`).set(member, { merge: true });
  if (refDoc) await db.doc(`tenants/${tenantId}/idmap/${refDoc.id}`).set({ uid, email }, { merge: true });
  await db.doc(`userTenants/${uid}`).set({ tenantIds: FieldValue.arrayUnion(tenantId) }, { merge: true });
  await db.doc(`accessRequests/${uid}`).delete().catch(() => undefined);
  logger.info(`provisión directa: ${email} → ${tenantId} (${role}) por ${callerUid}`);
  return { ok: true, uid, name: member.name };
});
