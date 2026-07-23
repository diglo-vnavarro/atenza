# Portal de Administración de Plataforma — Plan de diseño

> Estado: **PROPUESTA** para validar antes de implementar. Autor de borrador: sesión de trabajo 2026‑07‑23.
> Ámbito: Atenza multi‑instancia (proyecto `diglo-desk-pd`). Piloto con 2 instancias (`diglo-it`, `leasys`), previsión de crecer.

---

## 1. Objetivo

Dar una **superficie de administración transversal** a Atenza para que:

1. El **administrador de plataforma** vea el estado de todas las instancias, cree instancias nuevas desde cero con una configuración base, gestione accesos y permisos transversales, y personalice el branding de cada una (logo, color…).
2. **Cualquier usuario con ≥1 instancia** disponga de una pantalla de **selección de instancia** (landing), complementaria al selector del topbar.

Motivación concreta: **todo lo que hoy se hace a mano con scripts** (crear la instancia Leasys, arreglar un ciclo de vida, provisionar a un usuario, consultar el estado/sync) es exactamente lo que este portal convierte en operación de producto, auditable y sin intervención de un desarrollador.

---

## 2. Modelo conceptual: usuario de plataforma vs usuario de instancia

La distinción que motiva este trabajo **ya existe en el esquema de datos**; el portal la hace operable desde la UI.

| Concepto | Dónde vive hoy | Notas |
|---|---|---|
| **Usuario de plataforma** (Atenza) | `platformAdmins/{uid}` (colección top‑level) | `buildUser` → `platformAdmin`. Poder transversal: en las reglas, `isPlatformAdmin()` salta el aislamiento entre instancias |
| **Usuario de instancia** | `tenants/{tid}/members/{uid}` con `role` | `tenant_admin` \| `technician` \| `requester` |
| **Qué instancias ve un usuario** | `userTenants/{uid}.tenantIds` | índice uid → instancias |
| **Permisos finos dentro de la instancia** | `members/{uid}.caps` (+ `roles` del tenant) | `hasCap()` |

**Reglas de negocio (confirmadas y a mantener):**

- Un usuario puede ser **técnico y/o solicitante** de una o varias instancias **sin** ser usuario de plataforma.
- Un **admin de plataforma** puede acceder a una, varias o **todas** las instancias. Hoy `tenantsForUser` (store.ts:150) le devuelve **todas**.
- Rol de plataforma y rol de instancia son **ortogonales**: se puede ser admin de plataforma y, a la vez, solo técnico en una instancia concreta (o admin en ella).

### 2.1 Refinamiento propuesto de roles de plataforma

Hoy "plataforma" es binario (eres `platformAdmin` o no). Propongo un pequeño escalón para el futuro, **opt‑in y retrocompatible**:

- `platform_owner` — control total, incl. gestionar otros admins de plataforma y crear/borrar instancias.
- `platform_admin` — crear instancias, gestionar accesos, ver todo; **no** gestiona owners.
- `platform_viewer` — dashboard de solo lectura (soporte/dirección) sin poder mutar.

Implementación: un campo `role` en el doc `platformAdmins/{uid}` (por defecto `platform_admin` para los existentes → retrocompatible). Si no interesa aún, se deja binario.

---

## 3. Cambios en el modelo de datos

### 3.1 Registro de instancias (documento‑resumen ligero)

Hoy `Tenant` = `{ id, name, key, active }` (model.ts:51) y la config rica vive en el mismo doc + subcolecciones; cargarla entera es **pesado** (`subscribeTenant` trae tickets y todo). Para un dashboard de N instancias necesitamos **datos de cabecera** en el propio doc `tenants/{tid}`, mantenidos por procesos server‑side:

```ts
interface TenantHeader {            // campos añadidos a tenants/{tid}
  active: boolean;
  branding?: Branding;              // §6
  summary?: {                       // lo estampa el job de sync / una función programada
    ticketsActive: number;
    ticketsArchived: number;
    members: number;
    lastSyncAt?: number;            // el job de sync ya corre: que escriba aquí
    lastSyncStatus?: 'ok' | 'error';
    schedulerId?: string;           // p.ej. atenza-sync-leasys
  };
  createdAt: number;
  createdBy?: string;               // uid del admin de plataforma que la creó
  source?: 'sdp' | 'blank' | 'blueprint';
}
```

> El `summary` se actualiza sin coste extra: el job de sync ya recorre los tickets; que escriba los contadores y `lastSyncAt` al terminar. Instancias sin sync (nativas) lo actualiza una Cloud Function `onTicketWrite` con *debounce*, o una programada ligera.

### 3.2 Branding por instancia

Ver §6.

### 3.3 Auditoría transversal

Colección top‑level `platformAudit/{autoId}`: `{ at, actorUid, action, tenantId?, targetUid?, detail }`. Toda acción del portal (crear instancia, conceder acceso, cambiar rol, alta de admin de plataforma) deja traza inmutable.

---

## 4. Arquitectura y *gaps* actuales a cubrir

| Gap detectado | Hoy | Cambio |
|---|---|---|
| Listar todas las instancias | No hay `listTenants`; `startCloud` solo carga las de `userTenants` | Nueva `listTenantHeaders()` (query a `/tenants`, ya permitida a `isPlatformAdmin` por reglas, línea 90). Devuelve solo cabeceras, no `TenantData` completo |
| Admin de plataforma sin `userTenants` no ve nada | Bucle `for (tid of tids)` (store.ts:286) | El portal no depende de `userTenants`: lista por el registro. Al *entrar* a una instancia, entonces sí `subscribeTenant` |
| Carga pesada para el panel | `subscribeTenant` trae tickets | Dashboard usa `TenantHeader.summary`; la carga completa solo al abrir una instancia |
| Conceder acceso desde UI | Se hace por script | Reutiliza `writeMember` + `addUserTenant` (reglas ya lo permiten a `isPlatformAdmin`), + auto‑alta existente |
| Alta de admin de plataforma | `platformAdmins` es `write: if false` | Cloud Function *callable* `grantPlatformRole` (solo un `platform_owner` puede llamarla). Bootstrapping del primero: consola/script (ya hecho para vnavarro) |

---

## 5. Superficies / pantallas

Dos superficies **distintas** (importante no mezclarlas):

### 5.1 Landing / selector de instancias — *para cualquier usuario con ≥2 instancias*

- Se muestra tras el login cuando el usuario tiene 2+ instancias (con 1, entra directo; con 0, pantalla "sin acceso" actual).
- **Tarjetas de instancia**: logo + nombre + color de marca + mi rol en ella + chips de estado (tickets asignados a mí, sin asignar, SLA en riesgo si es técnico). Clic → entra a esa instancia (fija `activeTenantId`).
- Sigue existiendo el **selector del topbar** para cambiar sin volver a la landing.
- Extra *cool*: **cambiador rápido tipo ⌘K/Ctrl‑K** para saltar entre instancias sin ratón.

### 5.2 Portal de plataforma — *solo `platform_*`*

Entrada desde un icono nuevo en el topbar (visible solo si `platformAdmin`). Vistas:

- **Panel de instancias**: rejilla/tabla con cada instancia y su salud —
  `● activa/inactiva`, tickets activos/archivo, nº miembros, **último sync + semáforo**, estado del scheduler. Ordenar/filtrar/buscar. Clic en una fila → "entrar como" (abre la instancia) o "detalle".
- **Detalle de instancia**: cabecera con branding, KPIs, accesos directos a su configuración (ciclos, plantillas, categorías…), botón *entrar*.
- Acciones: **＋ Nueva instancia** (§5.3), gestionar accesos (§5.4), gestionar plataforma (§5.5).

### 5.3 Asistente "Nueva instancia desde cero" — *la pieza mayor*

Una instancia funcional necesita: estados, ≥1 ciclo de vida, ≥1 plantilla, prioridades, sedes, categorías de servicio, roles y **un primer admin**. El asistente parte de un **blueprint** (plantilla base) para no empezar en blanco.

**Blueprints** (colección `blueprints/{id}`, curados por plataforma):
- `starter-es` — mínimo viable en español: estados Abierta/En curso/En espera/Resuelta/Cerrada, 1 ciclo incidencia + 1 petición, 4 prioridades, categorías genéricas. (Derivado y limpiado de `diglo-it`.)
- `sdp-import` — para instancias que vienen de ServiceDesk Plus (como Leasys): el flujo actual `leasys-fetch` + `build-*-tenant` **generalizado y parametrizado** (hoy es específico de Leasys).
- `blank` — solo lo imprescindible.

**Pasos del asistente:** 1) Identidad (nombre, `key`, **logo + color** §6) → 2) Blueprint → 3) Primer admin (email; se auto‑provisiona) → 4) (opcional) Origen SDP (credenciales → job de sync) → 5) Revisión y crear.

Server‑side (Cloud Function `createInstance`, transaccional): crea `tenants/{tid}` + subcolecciones desde el blueprint, siembra el primer admin, registra en `platformAudit`. Nunca a medias (o todo o nada).

> Reutilizamos y **generalizamos** los scripts existentes (`build-leasys-tenant.ts`, `gen-template-cat-map.ts`) como base del blueprint `sdp-import`.

### 5.4 Gestión de acceso (sustituye mis scripts)

- Bandeja de **solicitudes de acceso** (ya existe `accessRequests` + `AccessQueue`): aprobar/rechazar, elegir instancia y rol.
- **Provisionar directamente** un email a una instancia con rol (lo que hice a mano con Elena): `writeMember` + `addUserTenant`.
- Ver/editar los `userTenants` de una persona (en qué instancias está y con qué rol), revocar acceso.
- **Blindaje del auto‑servicio** (deuda detectada esta sesión): hoy `requestAccess` hace `.catch(errlog)` silencioso y la UI dice "enviada" aunque falle; el caso de Elena fue una build **cacheada** que no llegó a escribir la solicitud. Añadir: *cache‑busting* del bundle + error visible si la escritura falla.

### 5.5 Gestión de plataforma

- Listar admins de plataforma y su `role` (§2.1); conceder/revocar vía Cloud Function `grantPlatformRole`.
- Log de **auditoría transversal** (`platformAudit`).

---

## 6. Branding por instancia (logo y tema) — *el toque "producto"*

### 6.1 Modelo

```ts
interface Branding {
  logoUrl?: string;         // logo a color (topbar, landing, login)
  logoMarkUrl?: string;     // isotipo cuadrado (favicon, avatar de instancia)
  primaryColor?: string;    // acento de marca (#hex)
  loginTagline?: string;    // texto bajo el logo en la pantalla de entrada
}
```

### 6.2 Almacenamiento del logo

- **Recomendado:** Firebase Storage en `tenant-logos/{tid}/…`, se guarda la *download URL* en `branding.logoUrl`. Reglas de Storage: lectura pública o firmada; escritura solo `manageConfig`/`platformAdmin`.
- **MVP alternativo (sin Storage):** PNG/SVG pequeño como *data URI* dentro del doc (límite 1 MB de Firestore sobra para un logo). Cero fricción de reglas. Migrable a Storage después.

### 6.3 Dónde se aplica

- **Topbar**: sustituye el `"A Atenza"` hardcodeado (App.tsx:301) por `logo de instancia` + "en Atenza" pequeño (co‑marca).
- **Landing/selector** (§5.1): cada tarjeta con su logo y color.
- **Pantalla de login por *deep‑link***: si entras a la URL de una instancia concreta, la pantalla de acceso muestra **su** logo y tagline → sensación de portal propio.
- **`favicon` y `<title>` dinámicos** por instancia activa.
- **Acento de color**: `primaryColor` como variable CSS que retiñe el acento de la instancia activa (sin romper el tema claro/oscuro).

### 6.4 Permisos

- El **admin de la propia instancia** (`tenant_admin`, cap `manageConfig`) puede editar su branding — las reglas ya permiten `update` del doc del tenant con esa cap (línea 92).
- El **admin de plataforma** puede editarlo de cualquiera.

---

## 7. Seguridad y reglas

La mayoría **ya está**:

- `/tenants` → `list: if isPlatformAdmin()` (✅ existe, línea 90) — habilita el registro de instancias.
- `/tenants/{tid}` → `create: if isPlatformAdmin()` (✅) y `update: if hasCap('manageConfig') || isPlatformAdmin()` (✅ branding).
- `/userTenants/{u}` → `write: if isPlatformAdmin()` (✅) — conceder/revocar acceso desde el portal.
- Subcolecciones de config → `write: hasCap('manageConfig') || isPlatformAdmin()` (✅) — sembrar instancia.

**A añadir:**
- `platformAudit/{id}` → `create: if isPlatformAdmin()`, `read: if isPlatformAdmin()`, `update/delete: if false` (append‑only).
- `blueprints/{id}` → `read: if isPlatformAdmin()`, `write: if false` (curados fuera de banda o por `platform_owner` vía función).
- `platformAdmins/{u}` sigue `write: if false`; la concesión pasa por **Cloud Function** `grantPlatformRole` que exige que el llamante sea `platform_owner`.
- Reglas de **Storage** para logos (§6.2).

> Principio: el portal **no afloja** el aislamiento; hace *visible y auditable* el poder que `isPlatformAdmin` ya tiene.

---

## 8. Detalles "cool" (candidatos)

- **Semáforo de salud** por instancia (sync al día, SLA en riesgo, errores) con color.
- **Sparkline** de tickets creados/cerrados por instancia en el panel.
- **⌘K / Ctrl‑K** cambiador rápido de instancia.
- **"Entrar como"** desde el panel (el admin de plataforma abre la instancia en su contexto), con banner de que está en modo plataforma.
- **Login co‑marcado** por deep‑link (logo + color de la instancia).
- **Favicon/título dinámicos** por instancia activa.
- **Tema de acento** por `primaryColor`, respetando claro/oscuro.
- **Estado del scheduler de sync** embebido (última ejecución, próxima, últimos errores) — hoy solo se ve por `gcloud`.
- **Reordenar instancias** por arrastre (persistido por usuario).

---

## 9. Fases (entregables mapeados a código)

**Fase 1 — Registro + landing + panel de solo lectura** (bajo riesgo, alto valor)
- `listTenantHeaders()` en `firestore.ts`; contadores `summary` estampados por el job de sync.
- Landing/selector (§5.1) reutilizando `tenantsForUser`.
- Panel de plataforma de solo lectura (§5.2) tras icono en topbar (solo `platformAdmin`).
- Branding **lectura** en topbar/landing (logo por instancia) — modelo §6 + edición simple.

**Fase 2 — Gestión de acceso desde UI** (sustituye scripts)
- Aprobar/provisionar/revocar (§5.4) sobre reglas ya existentes.
- Blindaje del auto‑servicio (cache‑busting + error visible).
- Auditoría `platformAudit`.

**Fase 3 — Asistente "Nueva instancia"** (la mayor)
- Blueprints (`starter-es`, `sdp-import`, `blank`); Cloud Function `createInstance` transaccional.
- Generalizar `build-leasys-tenant.ts`/`gen-template-cat-map.ts` como blueprint `sdp-import`.

**Fase 4 — Roles de plataforma + admins**
- `platformAdmins.role` (§2.1); Cloud Function `grantPlatformRole`; UI de gestión.

---

## 10. Decisiones abiertas (para cerrar antes de implementar)

1. **Roles de plataforma:** ¿binario (como hoy) o el escalón owner/admin/viewer de §2.1?
2. **Almacenamiento de logo:** ¿Firebase Storage (recomendado) o *data URI* para MVP?
3. **Blueprint inicial:** ¿derivamos `starter-es` de `diglo-it` (limpio) o partimos de un mínimo genérico?
4. **Alcance del admin de plataforma:** ¿siempre ve *todas* las instancias (como hoy) o queremos poder acotar a un subconjunto?
5. **"Entrar como":** ¿el admin de plataforma entra con su propia identidad o queremos impersonación explícita (con más auditoría)?
6. **Orden de fases:** ¿empezamos por Fase 1 completa, o priorizas el asistente de creación (Fase 3) porque vais a dar de alta más instancias pronto?
