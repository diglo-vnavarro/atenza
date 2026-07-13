// Autenticación (Identity Platform) — Google + email/contraseña.
// firebase/auth se importa dinámicamente para no engordar el bundle en local.
import { create } from 'zustand';
import { firebaseEnabled, getFirebaseApp } from '../firebase.js';

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

export async function signInEmail(email: string, password: string): Promise<void> {
  try {
    const { mod, auth: a } = await auth();
    await mod.signInWithEmailAndPassword(a, email, password);
    useAuth.getState().setError(null);
  } catch (e) { useAuth.getState().setError(friendly(e)); }
}

export async function signUpEmail(email: string, password: string, name: string): Promise<void> {
  try {
    const { mod, auth: a } = await auth();
    const cred = await mod.createUserWithEmailAndPassword(a, email, password);
    if (name) await mod.updateProfile(cred.user, { displayName: name });
    useAuth.getState().setError(null);
  } catch (e) { useAuth.getState().setError(friendly(e)); }
}

export async function doSignOut(): Promise<void> {
  const { mod, auth: a } = await auth();
  await mod.signOut(a);
}
