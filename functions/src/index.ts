// ⚠️ AUTO-ONBOARDING DESACTIVADO (2026-07-16) — INCIDENCIA DE LOGIN EN PRODUCCIÓN
// ============================================================================
// El trigger BLOQUEANTE `beforeUserSignedIn` (autoOnboard) tumbó TODOS los inicios
// de sesión con `auth/error-code:-47`. Causa: desajuste de audiencia del token de
// bloqueo — Identity Platform tenía registrado el trigger con la URL gen1
//   https://europe-west1-diglo-desk-pd.cloudfunctions.net/autoOnboard
// mientras que la función gen2 verifica el token contra su URL `run.app`. El
// verificador de firebase-functions lanzaba `auth/argument-error` en CADA login y,
// al ser una función bloqueante, Identity Platform rechazaba el acceso (-47).
//
// SOLUCIÓN aplicada: se eliminó el trigger `beforeSignIn` de la config de Identity
// Platform (PATCH admin/v2/config con blockingFunctions vacío) y se borró la Cloud
// Function. El acceso se concede por el flujo de aprobación de la app y por
// scripts/provision-access.ts (no dependemos del auto-alta).
//
// NO volver a exportar aquí una función bloqueante sin resolver antes la audiencia:
//   - Alinear la URL registrada en Identity Platform con la real de la función, o
//   - Actualizar firebase-functions a una versión que verifique bien gen2, o
//   - Mover el auto-alta a un mecanismo NO bloqueante (p. ej. trigger onCreate de
//     usuario, o una función callable invocada tras el login desde startCloud),
//     de modo que un fallo NUNCA impida iniciar sesión.
//
// Este paquete no exporta ninguna función a propósito: `firebase deploy --only
// functions` no registrará ningún trigger de auth.
export {};
