# Propuesta: clasificación de 3 niveles + asignación viva (ticketIN)

> Estado: **borrador para revisión**. Documento reescrito 2026-07-24 sobre datos reales de
> Diglo-ITSM (23.535 tickets en Zoho SDP) y las decisiones tomadas hasta la fecha.

---

## 1. TL;DR

- La app sigue teniendo **una sola plantilla** (no cambia). Dentro se elige **Tipo**
  (Incidencia / Petición) y una **clasificación en 3 niveles**.
- Los 3 niveles son **`Área → Servicio → Elemento`**:
  - **N1 Área** = la actual «categoría de servicio», pero **al alto nivel**: `IT ·
    Operaciones · BI · Negocio`.
  - **N2 Servicio** = lo que en SDP era una *plantilla* (Gemini, Recovery, REO,
    Liquidaciones, Reclamación, Datos BI…). **Aquí cuelga el grupo de soporte** y los
    permisos.
  - **N3 Elemento** = la *aplicación afectada* (Gmail, Outlook, Citrix, Looker…), opcional.
- El **grupo de soporte no es un nivel**: es un **atributo del Servicio** (heredable).
- **Dos ejes de visibilidad** por nodo: quién puede *levantar* (solicitante) y quién puede
  *atender* (técnico).
- Sobre el enrutado fijo, una capa de **asignación viva** que aprende del histórico.

---

## 2. Punto de partida en ticketIN (lo que NO cambia)

ticketIN opera en modo simplificado: **1 plantilla única** + `Tipo` + `Categoría de servicio`
(ver `operationMode: 'simplified'`, [`seed.ts:293`](../src/data/seed.ts)). El formulario
pide:

```
[ Tipo: Incidencia | Petición ]          ← ortogonal, no es un nivel de la taxonomía
[ Área ▸ Servicio ▸ Elemento ]           ← la clasificación en 3 niveles
[ campos… ]
```

Seguimos accediendo a todo por la misma plantilla. Lo que rediseñamos es **la
clasificación** que va dentro y **a qué grupo enruta**.

---

## 3. El cambio: de 4 niveles a 3

### 3.1 Diagnóstico (por qué había duplicados)

Hoy conviven **dos taxonomías que compiten**:

| Eje | Qué es | Función |
|---|---|---|
| **A · Categoría de servicio** | 15 categorías finas (`AI·Gemini`, `BI/Datos`, `Operaciones·Liquidaciones`…) | Filtra visibilidad + enruta a grupo |
| **B · Categoría › Subcategoría › Artículo** | árbol temático | Clasificación del formulario (no enruta) |

Por eso el mismo servicio aparecía en sitios distintos: **Gmail** (artículo del eje B) vs
**Correo Electrónico** (categoría del eje B); **Gemini** (artículo) vs **AI·Gemini**
(categoría de servicio del eje A). Causa raíz: *«qué es»* y *«quién lo atiende»* estaban
mezclados.

### 3.2 Modelo destino (una sola jerarquía)

```
N1 ÁREA        IT · Operaciones · BI · Negocio          (= categoría de servicio, al alto nivel)
   └ N2 SERVICIO   Gemini · Recovery · Liquidaciones · Reclamación · Datos BI …
        └ N3 ELEMENTO   Gmail · Outlook · Citrix · Looker …   (aplicación afectada, opcional)
```

- **N1 Área** = la categoría de servicio de ticketIN, pero coarse: `IT/Operaciones/BI/Negocio`.
- **N2 Servicio** hereda lo que hoy hace la categoría de servicio fina: **grupo de soporte,
  permisos, Tipo permitido + ciclo de vida, campos propios, aprobaciones, activo/inactivo**.
  Es el nivel donde de verdad cambia el enrutado (Gemini≠Recovery≠CAU dentro de IT).
- **N3 Elemento** = el árbol temático, reducido a su papel real: decir *qué aplicación*.
  Solo el 20 % de los tickets lo rellena, así que es **opcional** y se poda por uso.

> **Importante:** los atributos operativos (grupo, permisos, ciclo) **bajan de N1 a N2**. Si
> se dejaran en N1=Área, no podríamos enrutar Gemini distinto de Recovery. El Área solo
> agrupa y da el permiso base.

### 3.3 El grupo como atributo (heredable)

El grupo se resuelve **de lo más específico a lo general**:

```
grupo = elemento.groupId ?? servicio.groupId ?? área.groupId
```

Es el mismo comportamiento de hoy (`serviceCategory.groupId`,
[`store.ts:439`](../src/ui/store.ts)) pero heredable: basta fijarlo en el Servicio.

---

## 4. Los dos ejes de visibilidad

Confirmado con SDP: cada plantilla (`request_templates/{id}`) trae **las dos**. En el modelo
nuevo cuelgan del **Servicio (N2)**:

| Eje | Pregunta | Campo SDP | Campo ticketIN |
|---|---|---|---|
| **Solicitante** | ¿quién puede *levantar* esto? | `user_groups` + `show_to_requester` | `userGroups` (nodo) |
| **Técnico** | ¿quién puede *ver/atender* esto? | `support_groups` | grupo + `visibilityScope` |

- **Solicitante:** ejemplo real — «Plantilla Reclamación» tiene `user_groups: [IT,
  UsuariosReclamaciones]` ⇒ el resto de la organización **no la ve**. Mapea a
  `ServiceCategoryDef.userGroups` (ya existe: vacío = todos).
- **Técnico (hueco de seguridad actual):** hoy **cualquier técnico ve/lista TODOS los
  tickets** ([`firestore.rules:112-113`](../firestore.rules) y `:121`). Para los **externos
  de REO** (Omega CRM, Devoteam) que solo deben ver REO, hace falta un
  `visibilityScope: 'all' | 'groups'` aplicado **en reglas de servidor** (no solo UI).
- **Microsoft ↔ Google:** ambas ramas conviven en el N3; cada nodo con su ACL de
  solicitante + flag `inactive`, para **retirar Microsoft progresivamente** sin borrar
  histórico.

---

## 5. Taxonomía destino (con datos reales)

Volumetría del **último año** (8.322 tickets; 100 % tienen plantilla, 20 % rellenan el árbol
N3). Servicios (N2) = las plantillas reales; grupos = los reales de SDP.

### IT

| Servicio (N2) | Grupo (técnico) | Tipo | Notas |
|---|---|---|---|
| Incidencia (general) | `CAU` | Incidencia | mesa de ayuda |
| Petición (general) | `CAU` | Petición | mesa de ayuda |
| Gemini | `Tecnicos Gemini` | Inc + Pet | IA |
| Recovery | `Tecnicos Recovery` | Inc + Servicio | **solo subconjunto de IT** |
| REO | `Tecnicos REO` (+CRM/WEB/PRINEX) | Inc + Solicitud | **externos; visibilidad SOLO REO** |
| Gestión de usuarios | `Gestión de usuarios` | Petición | altas/bajas/modif. + buzones |
| ~~Formulario Incidencia DEFAULT NO USAR~~ | — | — | **retirar** (108 tickets pese al nombre) |
| ~~TEST IT~~ | — | — | **retirar** (basura de pruebas) |

**N3 «aplicación afectada» (podado, conviven MS y Google):**
`Microsoft {Outlook, SharePoint, OneDrive, Teams}` · `Google {Gmail, Drive, Sheets, Meet,
Calendar, Docs}` · `Apps banco {Citrix, Ares, SAP, Tallyman, TPX, OneHR, Tasaweb, Informa…}`
· `Negocio {Portal del Deudor, Logalty, TPV Virtual, Gestor Documental…}`.

### Operaciones

| Servicio (N2) | Grupo | Tipo | Notas |
|---|---|---|---|
| Liquidaciones informativas de deuda | `Tecnicos Operaciones` (buzón `operaciones-itsm@`) | Petición | **el 52 % del volumen**; lo tramita un buzón funcional, no un equipo humano |
| PD | `Tecnicos PD` | Petición | **INACTIVO** (`inactive`; último ticket 2024-06-17) |

### BI

| Servicio (N2) | Grupo | Tipo |
|---|---|---|
| Solicitud de datos BI | `Tecnicos BI` | Petición |
| Petición ITSM BI | `Tecnicos ITSM BI` | Petición |
| Incidencias BI | `Tecnicos BI` | Incidencia |

**N3:** Looker · Power BI · Informes.

### Negocio

| Servicio (N2) | Grupo(s) | Visibilidad solicitante |
|---|---|---|
| Reclamación | 12 colas `Tecnicos Reclamaciones*` (se mantienen tal cual) | `IT` + `UsuariosReclamaciones` |
| Seguimiento Infoser/Diglo | `Seguimiento Infoser/Diglo` | (por confirmar) |
| Waiver | (por confirmar) | (por confirmar) |

---

## 6. Decisiones firmes (registro)

- **Áreas N1:** `IT · Operaciones · BI · Negocio` (independientes y confirmadas).
- **Eje = `categoría de servicio (=Área) → Servicio → Elemento`.** El grupo se **deriva del
  Servicio**, no es un nivel. Tipo (Inc/Pet) es ortogonal, se elige en la plantilla única.
- **REO y Recovery = Servicios dentro de IT** (mismo equipo humano: Nuria Imedio, Óscar
  Igualada, Elena Andrés…), distinto del buzón `operaciones-itsm@` de Liquidaciones.
  - Recovery: solo lo gestiona un subconjunto de IT.
  - REO: incluye **externos** (Omega CRM, Devoteam) con visibilidad **solo REO**.
- **PD** → bajo Operaciones pero **desactivado** (`inactive`).
- **Reclamaciones** → 4ª área (Negocio). **Se mantienen sus 12 colas tal cual, sin
  colapsar** (área poco conocida, no se toca).
- **Ciclo de vida de usuario** (alta/baja/modif.) va **bajo IT**, junto con Accesos (lo
  gestiona CAU/IT). Sin corte IT↔Negocio.
- **Microsoft y Google conviven** en el N3; Microsoft se retira progresivamente vía
  `inactive` + visibilidad.

---

## 7. Poda por uso real

Principio: **un nodo sin ni una petición no se ofrece** (se conserva como *alias de archivo*
para no romper el histórico). Umbral configurable (`usos == 0`, o `< N en 24 meses`).

Datos que respaldan la poda (histórico completo, 23.535 tickets):

- **Categorías del árbol con cero uso (8):** Consulta de Documentación · General · Internet ·
  Microsoft Office (raíz dup.) · Móviles (dup.) · Reclamaciones de Clientes (se gestiona por
  grupo, no por árbol) · Unidades dep./Filer Server (dup.) · VDI (raíz dup.).
- **Subcategorías con cero uso (18):** las 8 hijas de «Microsoft Office (raíz)», Móviles,
  VDI, Filer Server, «Buzón compartido», «Errores sintácticos», «ServiceDesk Plus».
- **Servicios (N2) a retirar:** `DEFAULT NO USAR`, `TEST IT`, `PD` (inactivo).

> Matiz: como el árbol N3 solo se rellena en el 20 % de los tickets, la poda por «cero uso»
> se aplica con rigor a **Servicio/plantilla** (ahí hay volumen) y con criterio al árbol de
> aplicaciones (podar ramas muertas; el resto es catálogo opcional).

**Microsoft vs Google (último año):** MS 287 (SharePoint 130, Outlook 69, OneDrive 24) ·
Google 151 (Gmail 70, Drive 20) · Gemini 52. Microsoft aún genera ~2× que Google → **conviven**,
no se elimina; se retira por fases.

---

## 8. Asignación viva (sobre suelo fijo)

La tabla `Servicio → grupo` (§5) es el **prior**. Encima, dos etapas que aprenden del
histórico:

> **Por qué hace falta (evidencia en Anexo A.4):** la configuración de grupos no coincide con
> quién resuelve de verdad — Gemini está configurado con ~24 grupos pero lo resuelve solo
> `Tecnicos Gemini`; Waiver dice `REO+BI` pero lo resuelve CAU; y el mayor resolutor de
> Recovery ni siquiera figura en el grupo. El enrutado vivo corrige esto solo.

### Etapa 1 — Enrutado a grupo
```
score(grupo) = prior_taxonomía
             + Σ decay(antigüedad) · resueltos_por_grupo[nodo]        (afinidad)
             − Σ decay · reasignaciones_salientes[grupo→otro]         (net de reasignaciones)
```
- Señal primaria = **grupo que resolvió** (casi todo ticket tiene grupo; el árbol no).
- *Net de reasignaciones*: si Gemini entra en CAU pero acaba en `Tecnicos Gemini`, aprende
  que el dueño real es `Tecnicos Gemini`.
- *Prior como suelo*: en frío cae al grupo declarado; nunca sin ruta. Explicable.

### Etapa 2 — Reparto a técnico
```
score(técnico) = w_afinidad · afinidad(técnico, servicio/elemento)   (resolvió similares, buen desenlace)
               + w_carga    · (1 − ocupación)                        (carga OrganiZate)
               − penalización(off)                                    (vacaciones/baja)
```
Extiende [`pickByLoad`](../src/assign.ts) (hoy solo carga) → `pickBySkillAndLoad`.

### Requisito de datos
Hoy el ticket guarda grupo/técnico **actual**, no un histórico con marcas de tiempo. Añadir
`ownerHistory` (espejo de `statusHistory`, [`model.ts:321`](../src/model.ts)) **o** derivarlo
de la auditoría (`ticket.assign`, [`store.ts:486`](../src/ui/store.ts)) asegurando que los
cambios de **grupo** también se registran. Hay ~23k tickets para entrenar desde el día 1.

---

## 9. Impacto en modelo de datos y código

| Zona | Cambio |
|---|---|
| [`seed.ts:187`](../src/data/seed.ts) | Árbol `CatNode(Área) → CatSub(Servicio) → Article(Elemento)`; el **Servicio** lleva `groupId`, `userGroups`, `allowedTypes{lifecycleId}`, `fields`, `approvalLevels`, `inactive` |
| [`seed.ts:334`](../src/data/seed.ts) | `ServiceCategoryDef` se **funde en los nodos Servicio (N2)**; deja de ser lista aparte |
| [`model.ts`](../src/model.ts) | `Ticket`: `area/service/element` (N1/N2/N3) + `type`; nuevo `ownerHistory` |
| [`store.ts:414`](../src/ui/store.ts) | `createTicket`: grupo por herencia bottom-up sobre el árbol |
| [`firestore.rules`](../firestore.rules) | ACL técnico por grupo (`visibilityScope`) para externos |
| [`assign.ts`](../src/assign.ts) | `pickBySkillAndLoad` (afinidad + carga) |
| [`importer/etl.ts`](../importer/etl.ts) | Capturar `user_groups[]` e `inactive` por plantilla (hoy solo `show_to_requester`) |

---

## 10. Fases

0. **Volumetría y poda** — ya extraída; generar lista blanca. *(Hecho el análisis.)*
1. **Fase A — 3 niveles + enrutado fijo.** Unir ejes, migrar `ServiceCategoryDef` a nodos
   Servicio, tabla `Servicio → grupo` editable, flag `inactive`, ACL solicitante. Deduplica.
2. **Fase B — Visibilidad técnico por grupo** (`visibilityScope` + reglas). *Bloqueante antes
   de dar de alta externos.*
3. **Fase C — Instrumentar histórico** (`ownerHistory` / auditar cambios de grupo).
4. **Fase D — Enrutado vivo a grupo** (Etapa 1).
5. **Fase E — Reparto vivo a técnico** (Etapa 2, carga OrganiZate).

---

## 11. Pendientes

- [ ] Grupo/visibilidad de **Seguimiento** y **Waiver** (Negocio).
- [ ] Destino de «Consulta de Documentación» (¿base de conocimiento? ¿quitar?).
- [ ] `ownerHistory` nuevo vs derivar de auditoría.
- [ ] Semivida del decay y pesos `w_afinidad`/`w_carga`.
- [ ] Umbral de poda (`== 0` vs `< N en 24 meses`).

---

## Anexo A — Matriz real (servicio → solicitante → grupo técnico)

Extraído de SDP el 2026-07-24 (`request_templates`, las dos ACL nativas por plantilla).
**N2 Servicio = la «categoría de servicio» real de SDP.** Solicitante = `user_groups` (quién
puede levantarlo; «TODOS» = sin restricción). Grupo técnico = `support_groups`.

### A.1 Servicios activos, por área

| N1 Área | N2 Servicio | Tipo | Solicitante (quién lo ve) | Grupo técnico |
|---|---|---|---|---|
| **IT** | Petición general | Petición | TODOS | CAU · CAU L2 · IT |
| **IT** | Incidencia general | Incidencia | TODOS | CAU |
| **IT** | Incidencias/Peticiones **GCP** | Inc + Pet | CAU · IT | **Técnicos GCP** |
| **IT** | **AI · Gemini** | Inc + Pet | TODOS | Tecnicos Gemini¹ |
| **IT** | Gestión de usuarios (alta/baja/modif.) | Petición | IT · Usuarios alta/baja · Usuarios RRHH · Usuarios Responsable | CAU · IT |
| **IT** | Gestiones de Correo Electrónico (buzón compartido) | Petición | Managers de departamentos | *(sin grupo en SDP → definir)* |
| **IT** | Gestión Unidades Departamentales | Petición | Managers de departamentos | *(sin grupo → definir)* |
| **IT** | Arquitectura IT (FTP, BBDD, automatización) | Petición | TODOS | *(sin grupo → definir)* |
| **IT** | **Recovery** | Inc + Pet | TODOS | Tecnicos Recovery¹ *(subconjunto de IT)* |
| **IT** | **Tareas REO** | Inc + Pet | TODOS | Tecnicos REO¹ *(externos; visibilidad solo REO)* |
| **BI** | Solicitudes BI (datos + incidencias) | Inc + Pet | IT · UserAdmin · Usuarios BI | Tecnicos BI |
| **BI** | ITSM BI | Petición | TODOS | Tecnicos ITSM BI |
| **BI** | Informes Looker | Petición | TODOS | Técnicos Informes Looker · IT |
| **Operaciones** | Liquidaciones informativas de deuda | Petición | IT · Usuarios NPL · Usuarios Operaciones | Tecnicos Operaciones (buzón `operaciones-itsm@`) |
| **Operaciones** | Solicitudes PD | Inc + Pet | IT · UserAdmin · Usuarios PD | Tecnicos PD — **INACTIVAR** |
| **Negocio** | **Reclamación** | Incidencia | IT · UsuariosReclamaciones | 10 colas `Tecnicos Reclamaciones*` |
| **Negocio** | Seguimiento Infoser/Diglo | Petición | Infoser · IT | CAU L2 |
| **Negocio** | Solicitud Waiver | Petición | Todos los usuarios Diglo | Tecnicos REO · Tecnicos BI |

¹ En SDP estas plantillas listan *casi todos* los grupos como `support_groups` (permiten
reasignar a cualquiera); el grupo **real** que las resuelve es el propio del servicio
(Gemini→Tecnicos Gemini, etc.). El **enrutado vivo (§8)** aprende justo esto.

### A.2 N3 «elemento / aplicación afectada» (solo donde aplica)

El N3 se usa sobre todo en **Incidencias de IT** (qué aplicación falla); el resto de
servicios normalmente no lo rellenan. Catálogo podado (conviven Microsoft y Google):

- **Microsoft:** Outlook · SharePoint · OneDrive · Teams
- **Google Workspace:** Gmail · Drive · Sheets · Meet · Calendar · Docs
- **Apps banco:** Citrix · Ares · SAP · Tallyman · TPX · OneHR · Tasaweb · Informa
- **Negocio:** Portal del Deudor · Logalty · TPV Virtual · Gestor Documental · Recovery

### A.3 Servicios legacy a retirar (inactivos / sin grupo / era Microsoft-AD)

Sin grupo técnico y/o marcados inactivos en SDP — **no pasan al árbol vivo**:

- Genéricos: `Formulario Incidencia DEFAULT NO USAR` · `Plantilla (NO USAR)` · `Plantilla CRM` · `Plantilla Estándar` · `TEST IT`
- Era Microsoft/AD (inglés): **Intranet** (crear/borrar/reset cuentas Active Directory) · **Corporate Website** · **Payroll** (altas/bajas/cambios) · **VOIP or Telephone** (BlackBerry, iPhone, extensión…)
- Peticiones inactivas: Wifi invitados · nuevo Hardware · nuevo Software · acceso carpeta compartida · Waiver antiguo

> Dato relevante para la estrategia: **ya existe categoría GCP** (`Técnicos GCP`) — el
> soporte de Google Cloud Platform en marcha —, mientras que casi todo lo específico de
> Microsoft/AD está **inactivo o sin grupo**. Confirma la dirección Microsoft → Google.

### A.4 Quién resuelve DE VERDAD (histórico, 21.586 resueltos/cerrados)

Grupo y técnico reales de los tickets **resueltos/cerrados** (≠ `support_groups`
configurado). Es la evidencia base del enrutado vivo (§8).

| N2 Servicio | Grupo real (resueltos) | Persona(s) clave | vs configurado (A.1) |
|---|---|---|---|
| Liquidaciones (Operaciones) | Tecnicos Operaciones (11.826) | `Operaciones-ITSM` (buzón) | = |
| Incidencia/Petición grales. | CAU (~4.700) | **Jonatan Agudelo** (~3.000) · Sergio Pozo | = |
| Reclamación | ReclamacionesDeuda (1.182) · AtenciónComercial (296) | **Fabián García Tijero** (1.176) | 10 colas → 2 reales |
| Tareas REO | REO-CRM (1.018) · REO-WEB (313) · REO-PRINEX (118) | Elena Andrés · **Andreia da Cunha** (530) · Manuel Mayo (ext.) | lista gigante → 3 |
| ITSM BI | Tecnicos ITSM BI (272) | Virginia Torralba · David Durán | = |
| Recovery | Tecnicos Recovery (378) | **Maria Isabel Juan (205)** ⚠️ no figura hoy en el grupo | lista gigante → 1 |
| Solicitudes BI | Tecnicos BI (346) | Beatríz Cabado (231) · Sergio Frías | = |
| Gestión de usuarios | CAU (128) | Jonatan Agudelo · Sergio Pozo | CAU·IT ✓ |
| AI · Gemini | Tecnicos Gemini (22) | Vicente Navarro · Virginia Torralba | ~24 grupos → **1 real** |
| Informes Looker | Técnicos Informes Looker (14) | Nuria Imedio · Virginia Torralba | perfil **BI** ✓ |
| Seguimiento Infoser/Diglo | Seguimiento Infoser/Diglo (14) | Marcos Díaz | = |
| **Solicitud Waiver** | **CAU (4)** | Jonatan Agudelo | ✗ config decía REO+BI (no usado) |

**Correcciones que impone el dato:**

- **Waiver** → grupo real **CAU** (la config `Tecnicos REO + BI` no se usa).
- **Informes Looker** → confirmado en **BI** (lo resuelven perfiles BI).
- **Gemini / Recovery / REO** → el grupo real es **uno** (el propio del servicio), no la lista
  gigante de `support_groups`. El resto de esa lista es ruido de reasignación.
- **Recovery**: el mayor resolutor (Maria Isabel Juan, 205) **no está en el grupo actual** →
  la pertenencia configurada va por detrás de la realidad. Ejemplo perfecto de por qué el
  reparto debe mirar *quién resolvió similares*, no solo la pertenencia al grupo.
- Servicios **sin grupo** (Correo compartido, Unidades Departamentales, Arquitectura IT):
  **~0 resueltos** → residuales; caen a CAU, prioridad baja.
