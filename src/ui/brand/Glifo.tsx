// Glifo del producto: el mismo dibujo que `public/favicon.svg`, para que el icono de la pestaña y
// el de la interfaz sean literalmente la misma marca. Receta tomada del favicon de OrganiZate (el
// rayo morado): silueta a sangre —sin marco— rellena de una aurora borrosa recortada por una
// máscara con la forma. Aquí el glifo es un globo de conversación (la petición que entra) con el
// check CALADO (negro en la máscara = agujero), que es lo que la mesa hace con ella.
//
// Va sin letra a propósito: el nombre está en revisión y un glifo sobrevive al cambio.
//
// Los ids del <defs> se namespacian con useId: en una misma pantalla hay varios glifos (cabecera,
// portal, tarjetas) y con ids fijos el primero se llevaría la máscara de todos.
import { useId } from 'react';

export function Glifo({ size = 22, title }: { size?: number; title?: string }) {
  const uid = useId().replace(/:/g, '');
  const gl = `gl-${uid}`, soft = `soft-${uid}`, mask = `m-${uid}`;
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true} aria-label={title} style={{ display: 'block', flexShrink: 0 }}>
      <defs>
        <g id={gl}><path d="M16 6h16a10 10 0 0 1 10 10v10a10 10 0 0 1-10 10H20.5L8.8 43.2Q6 45 6 41.6V16A10 10 0 0 1 16 6z" /></g>
        <filter id={soft} x="-40%" y="-40%" width="180%" height="180%" colorInterpolationFilters="sRGB">
          <feGaussianBlur stdDeviation="6.2" />
        </filter>
        <mask id={mask} maskUnits="userSpaceOnUse" x="0" y="0" width="48" height="48">
          <use href={`#${gl}`} fill="#fff" />
          <path d="m14.4 21.6 6.9 6.9L34.4 15.4" fill="none" stroke="#000" strokeWidth="5.6"
            strokeLinecap="round" strokeLinejoin="round" />
        </mask>
      </defs>
      <g mask={`url(#${mask})`}>
        <rect width="48" height="48" fill="#0d8f66" />
        <g filter={`url(#${soft})`}>
          <ellipse cx="8" cy="2" rx="18" ry="14" fill="#cdf7e4" />
          <ellipse cx="25" cy="20" rx="21" ry="15" fill="#12a074" />
          <ellipse cx="44" cy="45" rx="20" ry="18" fill="#04553f" />
          <ellipse cx="46" cy="30" rx="13" ry="11" fill="#f5a623" opacity=".72" />
        </g>
      </g>
    </svg>
  );
}
