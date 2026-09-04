# Marca de ticketIN — piezas para presentaciones

Imágenes listas para PowerPoint, Google Slides, Word o cualquier documento. Recortadas al
contenido: se alinean sin márgenes fantasma.

Vista de todas juntas, sobre fondo claro y oscuro: [`muestra.png`](muestra.png).

## Qué coger

| Pieza | Fondo claro | Fondo oscuro | Sin transparencia (JPG) |
|---|---|---|---|
| Icono | `ticketIN-icono.png` | `ticketIN-icono.png` | `ticketIN-icono-blanco.jpg` |
| Nombre | `ticketIN-nombre.png` | `ticketIN-nombre-negativo.png` | `ticketIN-nombre-blanco.jpg` |
| Icono + nombre | `ticketIN-logo.png` | `ticketIN-logo-negativo.png` | `ticketIN-logo-blanco.jpg` · `ticketIN-logo-verde.jpg` |

Los PNG llevan **transparencia**; los JPG no, por eso van con el fondo incrustado (blanco, o
verde `#044A3C` en el caso de `logo-verde`).

`ticketIN-icono-calado.png` es el icono con el check **calado** (un agujero, no pintado): toma el
color del fondo. Sobre blanco el check desaparece — úsalo solo sobre fondos con color. El icono
normal lleva el check en blanco y funciona en cualquier sitio.

## Reglas de uso

- **El nombre siempre con «t» minúscula**: `ticketIN`. Es parte de la marca y no se capitaliza ni
  a principio de frase. Si el editor lo autocorrige al teclearlo, usa el PNG.
- **No rehagas el nombre con otra tipografía.** Es **Diglo Aero Bold**, la corporativa; los `.otf`
  están en [`public/fonts/`](../../public/fonts).
- **No recolorees el icono.** Su degradado (menta → verde → destello naranja de Diglosfera) es el
  mismo que el fondo de la pantalla de acceso; cambiarlo rompe el parecido de familia con el
  módulo hermano (Diglo Recovery, en azul).
- Deja aire alrededor: como mínimo, la mitad del alto del icono.

## Vectorial

No se duplica aquí a propósito, para que no divergan dos copias: el original es
[`public/favicon.svg`](../../public/favicon.svg), que es a la vez el favicon de la aplicación.
Para rótulos grandes, portadas o Illustrator/Figma, usa ese.

## Cómo se generaron

Renderizadas con Chrome headless desde `public/favicon.svg` y Diglo Aero Bold, a 1024 px de icono
y 420 px de cuerpo de texto. Si cambia el nombre del producto (`NOMBRE_PRODUCTO` en
`src/lib/marca.ts`), estas imágenes **no** se actualizan solas: hay que regenerarlas.

## Paleta

| | Hex | Dónde |
|---|---|---|
| Verde del icono | `#0D8F66` → `#04553F` | degradado del glifo |
| Tinta del nombre | `#04553F` | nombre sobre fondo claro |
| Verde de fondo | `#044A3C` | `logo-verde.jpg` y la pantalla de acceso |
| Naranja Diglosfera | `#F5A623` | destello del icono — no se toca |
