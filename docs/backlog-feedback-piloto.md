# Backlog — feedback del piloto ticketIN

> Fuente: email de revisión de los compañeros + `ITSM.xlsx` (hojas **Tipologías** y **Grupos**;
> tachado/rojo = quitar, azul = nuevo). Fecha 2026-08-19.
>
> Leyenda de esfuerzo: **✅ directo** (formulario/config) · **🟡 medio** (lógica/UI) ·
> **🔴 grande** (flujo/infra/módulo nuevo) · **🔀 cambio de enfoque** vs lo diseñado ·
> **❓ decisión de negocio** · **⛔ no factible sin integración externa**.

---

## 0. El cambio de enfoque de fondo (leer primero)

El feedback consolida un giro respecto a lo que activamos:

- **Desaparece la «Categoría de servicio» como eje/Área.** La clasificación pasa a ser el árbol
  **`Categoría › Subcategoría › Tipología`** (limpio, el del Excel), con un **GRUPO por Tipología**
  (heredable hacia arriba). No hay Áreas IT/Operaciones/BI/Negocio como Nivel 1: el Nivel 1 son
  las Categorías del árbol (Aplicaciones, Arquitectura, Dispositivos, Gestión Managers,
  Operaciones, Reclamaciones, Seguridad, Clientes, Visualización de informes).
- **Enrutado explícito** tipología→grupo (ej.: Gemini→Técnicos IA, Recovery→Técnicos Recovery,
  CRM→Técnicos REO-CRM, Citrix→CAU, Looker→Técnicos BI).
- **Categoría y Subcategoría obligatorias** (y Tipología si existe).
- Varios servicios **«van por fuera»** con flujo propio: Reclamaciones (desde la web),
  Liquidaciones (Operaciones), Altas/Bajas de usuarios.

**Buena noticia:** el motor que construimos lo soporta casi tal cual — árbol de 3 niveles con
`groupId` heredable por nodo, plantilla única, editor de administración, enrutado y ACL de
visibilidad. Cambia el **contenido** del árbol y se **retira el selector «Categoría de servicio»**.
No es reescribir el motor.

**🔀 Impacto en la asignación viva (Fases 7-8):** el negocio quiere un mapa **explícito**
tipología→grupo. El enrutado/reparto «vivos» (afinidad/carga) quedan como **capa opcional** encima,
no como mecanismo primario. → Decisión: ¿mantenerlos o aparcarlos?

---

## 1. Formulario general — quick wins

| # | Tarea | Esfuerzo |
|---|---|---|
| F1 | «Tipo» y primer selector **sin valor por defecto** y **obligatorios** (placeholder «— Selecciona —» + validación) | ✅ |
| F2 | **Ocultar «Ciclo de vida»** al solicitante (visible solo a técnico/admin) | ✅ |
| F3 | **Prioridad** = solo `Media · Alta · Crítica` (en ese orden), por defecto Media | ✅ (picklist) |
| F4 | **Quitar «Sede»** | ✅ |
| F5 | **Categoría + Subcategoría obligatorias**; Tipología obligatoria si el nodo la tiene | 🟡 (el árbol pasa a ser el clasificador principal, con validación) |
| F6 | **«Solicitante» al inicio**, autocompletado con el usuario actual, **editable** (abrir en nombre de otro — lo usa Jonatan) | 🟡 |
| F7 | **BUG: no deja escribir en «Descripción»** (RichText). Investigar y corregir | 🟡 |
| F8 | Sustituir «Detalles del impacto» por desplegable **«Impacto»** = `Afecta a un usuario / a un grupo / a un área` (def. usuario), donde estaba «Sede» | ✅ |
| F9 | **Quitar «Activos / elementos afectados»** | ✅ |
| F10 | **«Correos a notificar»** con autocompletado del directorio (nombre/email), al inicio junto a «Solicitante» | 🟡 internos (miembros) · ⛔ directorio completo Google = integración |
| F11 | Campo **«Estado»** visible (deriva del estado actual del ticket) | ✅ |
| F12 | Campo **«Clasificación»** (solo peticiones): `Solicitud de información / Petición de servicio / Evolutivo` | ✅ (picklist nueva) |
| F13 | Campo **«Funcionalidad»** (para REO y BI) | ❓ definir con Elena (REO) y Bea (BI) |

---

## 2. Clasificación y enrutado (el núcleo)

| # | Tarea | Esfuerzo |
|---|---|---|
| C1 | **Cargar el árbol del Excel** como `classificationTree` (Categoría→Subcategoría→Tipología) — sustituye al árbol v3 actual | 🔀🟡 (script de carga desde el Excel) |
| C2 | **Grupo por Tipología** (heredable). El motor ya lo soporta (`groupId` por nodo + `resolveGroup`) | 🔀✅ |
| C3 | **Retirar el selector «Categoría de servicio»** del formulario y del modelo como eje | 🔀🟡 |
| C4 | Fundir en el árbol lo que eran categorías de servicio: Recovery→Aplic./Herr. Negocio/Recovery; Gemini→Herr. Google/Gemini; Looker→Herr. Google/Looker; REO→Herr. Negocio/CRM·Prinex·Web; BI→Visualización de informes | 🔀✅ (ya reflejado en el Excel) |
| C5 | **Seguimiento Infoser/Diglo**: visible **solo desde IT** (ACL de solicitante) | ✅ (`userGroups`) |
| C6 | Podas del Excel: quitar Comunicaciones, Consulta Doc., Correo Electrónico, Datos, Errores en Consultas, General, Internet, MS Office, Móviles, Otros, Problemas de Datos, VDI, Unidades/File Server (y tipologías tachadas: Informa, Edición Contenidos, Gestor Documental, TAAF, TPV Virtual, Azure, Google…) | ✅ |
| C7 | Altas del Excel: **Agentes (IA)** (9 tipologías→Técnicos IA), **Seguridad** (MFA/Phishing/Vulnerabilidades), **Clientes** (Leasys/UCI/Lynxcap), ADN, Sharepoint, Grupos, Saneamiento Jurídico, unidad compartida, etc. | ✅ |
| C8 | **ITSM BI vs BI/Datos**: aclarar la diferencia (los compañeros lo preguntan) | ❓ |
| C9 | **Clientes (Leasys/Lynxcap/UCI)** como Categoría dentro de diglo-it **vs** instancia/tenant aparte (hoy Leasys es tenant separado) | ❓🔀 decisión de arquitectura |

---

## 3. Flujos «por fuera» (ciclos de vida propios)

| # | Tarea | Esfuerzo |
|---|---|---|
| L1 | **Reclamaciones**: flujo propio + **apertura desde el formulario web** del cliente (canal de entrada nuevo) | 🔴 (intake web = integración) · ❓ scope |
| L2 | **Operaciones · Liquidaciones de deuda**: flujo propio (hoy buzón `operaciones-itsm@`) | 🟡 (ciclo dedicado) · ❓ |
| L3 | **Altas/Bajas de usuarios** (internos y externos): flujo con aprobación (Silvia/Virginia; aviso Nuria) | 🟡🔴 (lifecycle + aprobaciones; ya tenemos `lc-alta`/`approvalLevels`) · ❓ lógica exacta |
| L4 | Visor de **ciclos de vida** para los usuarios/técnicos («¿dónde veo los flujos?») → ya existe el editor «Ciclos de vida» en Administración; documentarlo/enlazarlo | ✅ (existe) |

---

## 4. Grupos y roster (hoja «Grupos»)

| # | Tarea | Esfuerzo |
|---|---|---|
| G1 | **Renombrar**: Técnicos BI ⇒ Técnicos IT · Técnicos Gemini ⇒ Técnicos IA · Técnicos ITSM BI ⇒ Técnicos BI | ✅ config |
| G2 | **Eliminar**: Técnicos GCP · Técnicos PD · Técnicos REO (genérico) | ✅ |
| G3 | **Nuevos**: Técnicos IA · Técnicos Portal Deudor · Técnicos Leasys · Técnicos UCI · Técnicos Lynxcap | ✅ |
| G4 | **Membresías**: quitar Elena Andrés de todos los Reclamaciones; añadir Elena a NPL/Recovery y Vicente a Recovery; quitar Nuria de CAU L2; etc. (según Excel) | ✅ (roster) |
| G5 | CAU = L1 (Jonatan); CAU L2 = Marcos Díaz, Miguel Moya | ✅ |

---

## 5. Notificaciones, KB, histórico

| # | Tarea | Esfuerzo |
|---|---|---|
| N1 | **Notificar por email solo en apertura y cierre** (+ intercambio de correos de resolución) | ✅ (`notifRules`) |
| N2 | **Base de conocimiento** activa desde el día 1 (sugerir soluciones de tickets cerrados) | 🟡 (módulo KB existe; falta poblar/activar sugerencia) |
| N3 | **Continuidad de IDs** crecientes desde el ITSM actual | 🟡 (esquema de id; se importa `#display_id` de SDP) · ❓ confirmar corte |
| N4 | **Histórico con nuevas tipologías**: ¿recategorizar desde el día de migración? Se puede aplicar el árbol nuevo a partir de X y dejar el histórico con su categoría origen (alias) | 🟡 · ❓ política |

---

## 6. Migración e infraestructura

| # | Tarea | Esfuerzo |
|---|---|---|
| M1 | **Migrar adjuntos** de los tickets del ITSM actual (SDP) | 🔴⛔ el ETL no trae adjuntos hoy; depende de la API de adjuntos de SDP + almacenamiento. Nuevo desarrollo |
| M2 | **Informes** semanales actuales (altas/bajas, BI, WEB…) | 🔴 módulo de informes no construido |
| M3 | **ITSM de Leasys** | ❓ ligado a C9 (tenant vs categoría Clientes) |

---

## 7. Qué se puede hacer ya vs qué no

**Se puede (rápido, dentro del motor):** F1-F5, F8, F9, F11, F12 · C1-C7 · G1-G5 · N1 · L4.
**Se puede (con algo de trabajo):** F6, F7 (bug), F10 (internos), N2, N3, N4, L2, L3.
**Requiere decisión de negocio (❓):** F13, C8, C9, L1-scope, N3-corte, N4-política, M3.
**No factible aquí / integración externa (⛔):** F10 (directorio Google completo), M1 (adjuntos SDP), M2 (informes), L1 (intake web).

---

## 8. Dudas / cambios de enfoque a resolver con el equipo

1. **🔀 Adiós a las Áreas (IT/Ops/BI/Negocio):** confirmar que el eje pasa a ser el árbol
   `Categoría·Subcategoría·Tipología` con grupo por tipología, y que NO se mantiene una capa de
   Área. (Nuestra propuesta previa la usaba de Nivel 1.)
2. **🔀 Asignación viva:** ¿se mantiene como capa opcional (afinidad/carga sobre el grupo fijo) o
   se aparca a favor del mapa explícito tipología→grupo?
3. **❓ Clientes externos (Leasys/UCI/Lynxcap):** ¿categoría dentro de diglo-it o instancias
   separadas? Choca con el modelo multi-tenant actual (Leasys era tenant propio).
4. **❓ ITSM BI vs BI/Datos:** unificar o distinguir.
5. **❓ «Funcionalidad»:** definir valores con Elena (REO) y Bea (BI).
6. **❓ Flujos «por fuera»:** ¿dentro de ticketIN con ciclo dedicado, o sistemas separados? Aplica a
   Reclamaciones (web), Liquidaciones y Altas/Bajas.

---

## 9. Propuesta de orden

1. **Sprint «formulario»** (quick wins F1-F5, F8, F9, F11, F12 + bug F7) — visible y de bajo riesgo.
2. **Sprint «clasificación»** (C1-C7 + G1-G5): cargar el árbol del Excel + grupos, retirar la
   categoría de servicio, ACL de Seguimiento. Es el grueso del cambio de enfoque.
3. **Notificaciones + KB** (N1, N2).
4. **Flujos por fuera + migración** (L1-L3, M1-M3): los grandes, tras cerrar las dudas de negocio.
