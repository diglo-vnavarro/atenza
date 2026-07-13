// Init de Firebase, gateado por las variables VITE_FIREBASE_*.
// Si NO están definidas (p. ej. en local sin .env.local), `firebaseEnabled` es
// false y la app funciona en modo local-first (localStorage), sin tocar la nube.
import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';

const cfg = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY as string | undefined,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string | undefined,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID as string | undefined,
  appId: import.meta.env.VITE_FIREBASE_APP_ID as string | undefined,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET as string | undefined,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID as string | undefined,
};

export const firebaseEnabled = !!cfg.apiKey && !!cfg.projectId;

let app: FirebaseApp | null = null;
export function getFirebaseApp(): FirebaseApp | null {
  if (!firebaseEnabled) return null;
  if (!app) app = getApps()[0] ?? initializeApp(cfg as Record<string, string>);
  return app;
}

export const PROJECT_ID = cfg.projectId ?? '';
