import { useEffect } from 'react';
import { appEnvironment, PRODUCTION_URL } from '../env.js';

/**
 * Aviso fijo en la parte superior cuando la app corre en el entorno de DESARROLLO (dv),
 * igual que en OrganiZate: una línea verde que recuerda que los datos y los avisos son de
 * prueba, con enlace a producción. En producción (pd) y en modo local no se muestra nada.
 *
 * Publica `data-env="dv"` en <html> para que styles.css fije --banner-h y el layout
 * (topbar pegajosa, paneles laterales) deje hueco debajo del aviso.
 */
export function EnvBanner() {
  const env = appEnvironment();
  useEffect(() => {
    if (env === 'dv') document.documentElement.dataset.env = 'dv';
    else delete document.documentElement.dataset.env;
  }, [env]);
  if (env !== 'dv') return null;
  return (
    <div className="env-banner" role="status">
      <span aria-hidden>🧪</span>
      <span className="env-banner-text">
        <strong>Entorno de desarrollo (dv)</strong>
        <span className="env-banner-more"> · los datos y los avisos son de prueba</span>
      </span>
      <a className="env-banner-link" href={PRODUCTION_URL}>Ir a producción →</a>
    </div>
  );
}
