// Entorno de ejecución de la app (dv / pd / local), para avisos de UI y ajustes por entorno.
//
// Regla del modelo común Diglosfera/HUB360: nada específico de entorno en commits. El
// entorno llega por la variable de build VITE_ENVIRONMENT (opcional, en el entorno de
// GitHub `development` = dv y `production` = pd). Si no viene, se deduce del proyecto
// de Firebase (sufijo -dv) y, sin backend, es "local" (modo local-first).
import { firebaseEnabled, PROJECT_ID } from './firebase.js';

export type AppEnvironment = 'dv' | 'pd' | 'local';

export function appEnvironment(): AppEnvironment {
  const explicit = (import.meta.env.VITE_ENVIRONMENT as string | undefined)?.trim().toLowerCase();
  if (explicit === 'dv' || explicit === 'pd') return explicit;
  if (!firebaseEnabled) return 'local';
  return PROJECT_ID.endsWith('-dv') ? 'dv' : 'pd';
}

/** URL de producción, para enlazar desde el aviso de entorno de desarrollo. */
export const PRODUCTION_URL = 'https://diglo-desk-pd.web.app';
