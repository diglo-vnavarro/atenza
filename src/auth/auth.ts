// Autenticación (Identity Platform) — Google + email/contraseña, con MFA (TOTP) para externos.
// firebase/auth se importa dinámicamente para no engordar el bundle en local.
//
// MFA (2º factor TOTP) SOLO en la vía email/contraseña (los externos). Google (internos) no lo
// toca: su MFA lo impone Workspace aguas arriba. Modelo replicado de hub360-module-debt-collector:
// Firebase Auth nativo (`multiFactor` + `TotpMultiFactorGenerator`); el secreto lo custodia
// Identity Platform, no Firestore. El proveedor TOTP debe estar ENABLED en Identity Platform.
import { create } from 'zustand';
import { firebaseEnabled, getFirebaseApp } from '../firebase.js';
import { NOMBRE_PRODUCTO } from '../lib/marca.js';

export interface AuthUser { uid: string; email: string | null; displayName: string | null }

interface AuthState {
  user: AuthUser | null;
  ready: boolean;
  error: string | null;
  init: () => Promise<void>;
  setError: (e: string | null) => void;
}

let subscribed = false;

export const useAuth = create<AuthState>((set) => ({
  user: null,
  ready: !firebaseEnabled, // en local no hay auth: listo desde el principio
  error: null,
  setError: (e) => set({ error: e }),
  init: async () => {
    if (!firebaseEnabled || subscribed) return;
    subscribed = true;
    const app = getFirebaseApp()!;
    const { getAuth, onAuthStateChanged } = await import('firebase/auth');
    const auth = getAuth(app);
    onAuthStateChanged(auth, (u) => {
      set({ user: u ? { uid: u.uid, email: u.email, displayName: u.displayName } : null, ready: true });
    });
  },
}));

async function auth() {
  const app = getFirebaseApp()!;
  const mod = await import('firebase/auth');
  return { mod, auth: mod.getAuth(app) };
}

function friendly(e: unknown): string {
  const code = (e as { code?: string }).code ?? '';
  const map: Record<string, string> = {
    'auth/invalid-credential': 'Credenciales no válidas.',
    'auth/invalid-email': 'Correo no válido.',
    'auth/wrong-password': 'Contraseña incorrecta.',
    'auth/user-not-found': 'No existe una cuenta con ese correo.',
    'auth/email-already-in-use': 'Ya existe una cuenta con ese correo.',
    'auth/weak-password': 'La contraseña debe tener al menos 6 caracteres.',
    'auth/popup-closed-by-user': 'Se cerró la ventana de Google.',
    'auth/operation-not-allowed': 'Ese método de acceso no está habilitado.',
    'auth/invalid-verification-code': 'Código incorrecto o caducado. Revisa tu app de autenticación.',
    'auth/missing-code': 'Introduce el código de 6 dígitos.',
    'auth/totp-challenge-timeout': 'El reto ha caducado. Vuelve a entrar.',
  };
  return map[code] ?? (e as Error).message ?? 'Error de autenticación.';
}

export async function signInGoogle(): Promise<void> {
  try {
    const { mod, auth: a } = await auth();
    await mod.signInWithPopup(a, new mod.GoogleAuthProvider());
    useAuth.getState().setError(null);
  } catch (e) { useAuth.getState().setError(friendly(e)); }
}

// ============================================================================
// MFA (TOTP) — para la vía email/contraseña (externos)
// ============================================================================
// El «issuer» que verá la app authenticator = la marca del producto (sigue a la marca).
const ISSUER = NOMBRE_PRODUCTO;

/** Resultado de un intento de login por email: continuar, enrolar 2º factor, o resolver reto. */
export type LoginStep =
  | { step: 'done' }
  | { step: 'enroll'; qrUrl: string; secretKey: string }
  | { step: 'challenge' };

// Estado transitorio entre pasos del MISMO intento de login (no persistente).
type FbUser = import('firebase/auth').User;
type FbTotpSecret = import('firebase/auth').TotpSecret;
type FbResolver = import('firebase/auth').MultiFactorResolver;
let mfaUser: FbUser | null = null;
let mfaSecret: FbTotpSecret | null = null;
let mfaResolver: FbResolver | null = null;
let mfaHintUid: string | null = null;

function clearMfa() { mfaUser = null; mfaSecret = null; mfaResolver = null; mfaHintUid = null; }

/** Login por email. Si el usuario no tiene 2º factor → fuerza enrol TOTP; si ya lo tiene y
 *  Firebase pide reto → devuelve 'challenge'. Devuelve null en error (queda en el store). */
export async function signInEmail(email: string, password: string): Promise<LoginStep | null> {
  clearMfa();
  try {
    const { mod, auth: a } = await auth();
    const cred = await mod.signInWithEmailAndPassword(a, email.trim(), password);
    const mf = mod.multiFactor(cred.user);
    if (mf.enrolledFactors.length === 0) {
      // Externo sin 2º factor → generar secreto y forzar enrolamiento.
      const secret = await mod.TotpMultiFactorGenerator.generateSecret(await mf.getSession());
      mfaUser = cred.user; mfaSecret = secret;
      useAuth.getState().setError(null);
      return { step: 'enroll', qrUrl: secret.generateQrCodeUrl(email.trim(), ISSUER), secretKey: secret.secretKey };
    }
    useAuth.getState().setError(null);
    return { step: 'done' };
  } catch (e) {
    if ((e as { code?: string }).code === 'auth/multi-factor-auth-required') {
      const { mod, auth: a } = await auth();
      mfaResolver = mod.getMultiFactorResolver(a, e as import('firebase/auth').MultiFactorError);
      const totpId = mod.TotpMultiFactorGenerator.FACTOR_ID;
      const hint = mfaResolver.hints.find((h) => h.factorId === totpId) ?? mfaResolver.hints[0];
      mfaHintUid = hint?.uid ?? null;
      useAuth.getState().setError(null);
      return { step: 'challenge' };
    }
    useAuth.getState().setError(friendly(e));
    return null;
  }
}

/** Completa el enrolamiento del 2º factor con el código de 6 dígitos de la app authenticator. */
export async function completarEnrol(codigo: string): Promise<boolean> {
  try {
    if (!mfaUser || !mfaSecret) throw new Error('La sesión de enrolamiento ha caducado; vuelve a entrar.');
    const { mod } = await auth();
    const cred = mod.TotpMultiFactorGenerator.assertionForEnrollment(mfaSecret, codigo.trim());
    await mod.multiFactor(mfaUser).enroll(cred, 'Authenticator (TOTP)');
    clearMfa();
    useAuth.getState().setError(null);
    return true; // onAuthStateChanged ya tiene la sesión; el usuario queda dentro con MFA.
  } catch (e) { useAuth.getState().setError(friendly(e)); return false; }
}

/** Resuelve el reto del 2º factor en logins posteriores. */
export async function completarReto(codigo: string): Promise<boolean> {
  try {
    if (!mfaResolver || !mfaHintUid) throw new Error('El reto ha caducado; vuelve a entrar.');
    const { mod } = await auth();
    const assertion = mod.TotpMultiFactorGenerator.assertionForSignIn(mfaHintUid, codigo.trim());
    await mfaResolver.resolveSignIn(assertion);
    clearMfa();
    useAuth.getState().setError(null);
    return true;
  } catch (e) { useAuth.getState().setError(friendly(e)); return false; }
}

/** Cancela un flujo MFA en curso (p. ej. al pulsar «Volver»). */
export function cancelMfa() { clearMfa(); useAuth.getState().setError(null); }

/** GATE de la app: si el usuario ACTUAL entró por email (externo) y NO tiene 2º factor,
 *  prepara el enrol y devuelve {qrUrl, secretKey} para forzarlo antes de usar la app; si no
 *  aplica (Google, o ya enrolado), devuelve null. Cubre el alta de cuenta y sesiones abiertas
 *  sin MFA (Firebase deja entrar con un solo factor; el 2º factor lo exige la app). */
export async function mfaGateForCurrentUser(): Promise<{ qrUrl: string; secretKey: string } | null> {
  if (!firebaseEnabled) return null;
  const { mod, auth: a } = await auth();
  const u = a.currentUser;
  if (!u) return null;
  const byPassword = u.providerData.some((p) => p.providerId === 'password');
  if (!byPassword) return null; // internos (Google): su MFA lo impone Workspace, no la app
  const mf = mod.multiFactor(u);
  if (mf.enrolledFactors.length > 0) return null; // ya tiene 2º factor
  const secret = await mod.TotpMultiFactorGenerator.generateSecret(await mf.getSession());
  mfaUser = u; mfaSecret = secret;
  return { qrUrl: secret.generateQrCodeUrl(u.email ?? 'usuario', ISSUER), secretKey: secret.secretKey };
}

export async function signUpEmail(email: string, password: string, name: string): Promise<void> {
  try {
    const { mod, auth: a } = await auth();
    const cred = await mod.createUserWithEmailAndPassword(a, email.trim(), password);
    if (name) await mod.updateProfile(cred.user, { displayName: name });
    useAuth.getState().setError(null);
    // El MFA se enrola en el primer login (enrolledFactors === 0 → paso 'enroll').
  } catch (e) { useAuth.getState().setError(friendly(e)); }
}

export async function doSignOut(): Promise<void> {
  clearMfa();
  const { mod, auth: a } = await auth();
  await mod.signOut(a);
}
