// Nombre del producto en la pantalla de acceso.
//
// Vive en un fichero propio, y no escrito en el JSX, para que cambiar el nombre sea UNA línea.
// El 2026-09-01 se maquetaron «Atenza» y «TicketIN» sobre la misma plantilla y se mantuvo Atenza
// (ya está en los correos, los informes y la cabeza del equipo), a secas: la pantalla enseña el
// nombre y la marca Diglosfera, sin descriptor debajo.
//
// Si se decide otro nombre, además de esta constante hay que tocar tres sitios que NO pasan por aquí:
//   · `index.html`            — el <title>, que es HTML estático y no entra en el bundle;
//   · `src/ui/App.tsx`         — los chips de marca («A» + Atenza) de la cabecera, el portal de
//                                plataforma y el selector de instancia, más la copy de admin;
//   · `src/ui/ErrorBoundary.tsx` — la cabecera de la pantalla de error.
export const NOMBRE_PRODUCTO = 'Atenza';

/** Con el prefijo corporativo, como aparece en el bloque de acceso. */
export const NOMBRE_COMPLETO = `Diglo ${NOMBRE_PRODUCTO}`;
