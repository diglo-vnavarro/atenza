// Nombre del producto en la pantalla de acceso.
//
// Vive en un fichero propio, y no escrito en el JSX, para que cambiar el nombre sea UNA línea.
// El 2026-09-01 se probaron «Atenza» y «ticketIN» sobre la misma plantilla y se eligió ticketIN
// «un tiempo, a ver qué tal» — con la «t» inicial en MINÚSCULA, que es parte de la marca: no se
// capitaliza ni a principio de frase.
//
// Toda la copy visible sale de aquí (App.tsx, ErrorBoundary, audit, informes, correos), así que
// un cambio de nombre es esta línea. Quedan fuera del bundle, y hay que tocarlos a mano:
//   · `index.html`               — el <title>, que es HTML estático;
//   · `public/manual.html` y `public/comparativa.html` — páginas estáticas de documentación;
//   · `functions/src/index.ts`    — es otro paquete y no importa de `src/`.
//
// Lo que NO se renombra: los identificadores de infraestructura (bucket
// `diglo-desk-pd-atenza-files`, imagen `…/atenza/sync`, cuentas `atenza-sync@`, el propio repo).
// Renombrarlos es una migración, no un cambio de marca.
export const NOMBRE_PRODUCTO = 'ticketIN';

/** Con el prefijo corporativo, como aparece en el bloque de acceso. */
export const NOMBRE_COMPLETO = `Diglo ${NOMBRE_PRODUCTO}`;
