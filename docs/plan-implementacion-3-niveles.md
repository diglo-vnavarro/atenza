# Plan de implementación — clasificación 3 niveles + asignación viva

> Plan de ejecución de [propuesta-taxonomia-3-niveles.md](propuesta-taxonomia-3-niveles.md).
> Creado 2026-07-24. Instancia objetivo: **Diglo-ITSM** (`diglo-it`).

---

## 1. Principios rectores

1. **Aditivo, no destructivo.** La config actual (`serviceCategories`, `categoryTree`) se
   conserva; lo nuevo entra en paralelo.
2. **Gobernado por flag.** `classificationVersion: 'legacy' | 'v3'` por instancia (patrón del
   actual `operationMode`). Apagar = volver a hoy, al instante.
3. **Reversible en toda fase.** Nada se activa sin backup previo y sin poder desactivarse.
4. **Editable por instancia.** El árbol vive en `tenants/{tid}`; cada instancia el suyo.
5. **Convivencia con SDP.** Mientras SDP sea el origen, un mapa determinista
   plantilla→clasificación mantiene la sync; con fallback «Sin clasificar».

---

## 2. Despliegue y reversibilidad

| Mecanismo | Cómo | Fichero |
|---|---|---|
| **Flag** | `classificationVersion` en `TenantData` (default `legacy`) | `src/data/seed.ts`, `src/ui/store.ts` |
| **Backup previo** | Snapshot de config antes de migrar | [`scripts/backup-config.ts`](../scripts/backup-config.ts) |
| **Restore** | Volver a la config anterior | [`scripts/restore-config.ts`](../scripts/restore-config.ts), [`restore-service-cat.ts`](../scripts/restore-service-cat.ts) |
| **Rollback** | `flag → legacy` (+ restore si hace falta) | — |
| **Aislamiento** | Trabajar en **worktree** (agente Codex comparte el checkout) | — |
| **Pruebas** | Emulador Firestore + seed antes de tocar `diglo-it` | `firebase emulators`, `src/data/seed.ts` |

**Regla de oro de rollback:** ninguna fase borra datos legacy ni sobrescribe campos
existentes del ticket; solo **añade** estructura y campos nuevos.

---

## 3. Sincronización (SDP → clasificación v3)

- La sync ([`etl.ts`](../importer/etl.ts) → [`sync-tickets.ts`](../scripts/sync-tickets.ts))
  ya trae `template` + `category/subcategory/item`. Se añade un **paso de mapeo**:
  `plantilla / service_category → (Área, Servicio)`; `Elemento` desde el árbol cuando exista.
- Precedente reutilizable: [`template-category-map.json`](../importer/template-category-map.json)
  + [`apply-service-categories.ts`](../scripts/apply-service-categories.ts) (hoy plantilla→categoría de servicio).
- **Tickets nuevos:** clasificados al vuelo. **Ya sincronizados:** *backfill* de una pasada.
- **Fallback:** plantilla no mapeada ⇒ «Sin clasificar» (nunca se pierde ni rompe la sync).
- Escribe **campos nuevos** (`area/service/element`) sin tocar los legacy → rollback trivial.

---

## 4. Modelo de datos (objetivo)

```ts
// árbol editable, en TenantData (tenants/{tid})
interface Article  { name: string; groupId?: string; inactive?: boolean }          // N3
interface CatSub   { name: string; groupId?: string; userGroups?: string[];        // N2 (Servicio)
                     allowedTypes?: { incident?: { lifecycleId: string|null };
                                      service_request?: { lifecycleId: string|null } };
                     fields?: FieldDef[]; approvalLevels?: ApprovalLevelDef[];
                     inactive?: boolean; sortIndex?: number; articles: Article[] }
interface CatNode  { name: string; groupId?: string; userGroups?: string[];         // N1 (Área)
                     inactive?: boolean; sortIndex?: number; subs: CatSub[] }

// Ticket: campos nuevos EN PARALELO a los legacy
Ticket += { area?: string; service?: string; element?: string; ownerHistory?: OwnerSegment[] }
// Member: visibilidad de técnico
Member += { visibilityScope?: 'all' | 'groups' }
```

Resolución de grupo (bottom-up): `element.groupId ?? service.groupId ?? area.groupId`.

---

## 5. Fases

Cada fase es entregable, reversible y (donde hay riesgo) tras el flag.

### Fase 0 — Red de seguridad *(sin cambios funcionales)*
- **Tareas:** worktree; backup de config `diglo-it`; añadir flag `classificationVersion`
  (default `legacy`).
- **Ficheros:** `seed.ts`, `store.ts`, `scripts/backup-config.ts`.
- **Aceptación:** flag presente y en `legacy`; backup guardado; app idéntica a hoy.
- **Reversibilidad:** total (no cambia nada).

### Fase 1 — Modelo del árbol + resolución *(sin UI)*
- **Tareas:** tipos `CatNode/CatSub/Article` (§4); módulo de resolución grupo + ACL
  (herencia bottom-up); semilla del árbol destino de `diglo-it` derivada del **Anexo A**;
  tests unitarios.
- **Ficheros:** `src/model.ts`, `src/data/seed.ts`, nuevo `src/classification.ts`, tests.
- **Aceptación:** dado `(Área,Servicio,Elemento)` devuelve grupo y ACL correctos; suite verde.
- **Reversibilidad:** código nuevo inerte tras flag; legacy intacto.

### Fase 2 — Mapa de sync + backfill
- **Tareas:** extender el mapa a 3 niveles (plantilla/service_category → Área/Servicio);
  fallback «Sin clasificar»; integrar en la sync escribiendo `area/service/element`; script
  de backfill con `--dry-run` y reporte de cobertura (% mapeado).
- **Ficheros:** `importer/`, `scripts/sync-tickets.ts`, nuevo `scripts/map-classification.ts`.
- **Aceptación:** dry-run clasifica >95 % de tickets; sync no altera campos legacy.
- **Reversibilidad:** solo añade campos nuevos.

### Fase 3 — Editor de administración (CRUD del árbol)
- **Tareas:** panel «Clasificación»: alta/baja/modificación de Área/Servicio/Elemento y sus
  atributos (grupo, `userGroups`, tipos+ciclo, campos, aprobaciones, activo/inactivo, orden).
- **Ficheros:** `src/ui/App.tsx` (o componente nuevo), `src/ui/store.ts`.
- **Aceptación:** un admin edita el árbol y persiste en Firestore; «quitar» = inactivar.
- **Reversibilidad:** es config, con backup; sin impacto en tickets.

### Fase 4 — Formulario (plantilla única) con la nueva clasificación
- **Tareas:** selectores en cascada Área→Servicio→Elemento; Tipo (Inc/Pet) según Servicio;
  aplicar ACL de solicitante (`userGroups`); `createTicket` enruta por herencia y setea
  `area/service/element`.
- **Ficheros:** `src/ui/App.tsx`, `src/ui/store.ts` (`createTicket`), `src/formrules.ts`.
- **Aceptación:** levantar un ticket clasifica y enruta bien; el solicitante solo ve lo permitido.
- **Reversibilidad:** `flag → legacy` restaura el formulario actual.

### Fase 5 — Visibilidad de técnico por grupo *(seguridad; bloqueante para externos)*
- **Tareas:** `Member.visibilityScope`; reglas `get/list` de tickets acotadas a
  `groupId ∈ grupos del miembro` cuando `scope='groups'`; UI respeta el criterio; tests de reglas.
- **Ficheros:** `firestore.rules`, `src/model.ts`, `src/data/firestore.ts`, `src/ui/App.tsx`.
- **Aceptación:** un externo de REO solo ve tickets REO por **API y UI**; tests emulador verdes.
- **Reversibilidad:** default `'all'` = comportamiento actual; solo cambia para quien marques.

### Fase 6 — Instrumentar histórico de propiedad
- **Tareas:** `Ticket.ownerHistory` (espejo de `statusHistory`); registrar cambios de
  grupo/técnico (o auditar `setGroup`).
- **Ficheros:** `src/model.ts`, `src/ui/store.ts` (`assign`/`transition`), `src/rules.ts`, `src/audit.ts`.
- **Aceptación:** cada cambio de grupo/técnico deja segmento con timestamps.
- **Reversibilidad:** solo añade datos; sin cambio de comportamiento.

### Fase 7 — Enrutado vivo a grupo (Etapa 1)
- **Tareas:** scoring `prior(nodo) + afinidad_histórica − reasignaciones_salientes` con decay;
  entrenado con histórico + `ownerHistory`; explicable.
- **Ficheros:** nuevo `src/routing-live.ts`, `src/rules.ts`/`src/ui/store.ts`.
- **Aceptación:** casos conocidos enrutan al grupo **real** (Gemini→Tecnicos Gemini,
  Waiver→CAU), no al configurado (validar contra Anexo A.4).
- **Reversibilidad:** desactivable → usa solo el prior fijo.

### Fase 8 — Reparto vivo a técnico (Etapa 2)
- **Tareas:** `pickBySkillAndLoad` = afinidad(técnico, servicio/elemento) + carga OrganiZate −
  `off`; pesos configurables.
- **Ficheros:** `src/assign.ts`, `src/ui/store.ts` (`autoAssign`), `scripts/sync-organizate.ts`.
- **Aceptación:** reparte al técnico con afinidad+capacidad respetando `off` (caso Recovery:
  propondría a Maria Isabel Juan pese a no estar en el grupo configurado).
- **Reversibilidad:** cae a `pickByLoad` (solo carga) desactivando la afinidad.

---

## 6. Orden e hitos

```
Fase 0 ─▶ Fase 1 ─▶ Fase 2 ─┐
                            ├─▶ Fase 3 ─▶ Fase 4 ──▶ (MVP editable + clasificación viva-fija)
                            │
Fase 5 (paralela, seguridad) ─────────────▶ (habilita externos)
Fase 6 ─▶ Fase 7 ─▶ Fase 8 ───────────────▶ (asignación viva completa)
```

- **Hito 1 (MVP):** Fases 0–4 → clasificación 3 niveles editable y enrutado fijo en `diglo-it`,
  tras flag, reversible. Ya deduplica y ordena.
- **Hito 2 (seguridad):** Fase 5 → antes de dar de alta a externos.
- **Hito 3 (viva):** Fases 6–8 → enrutado y reparto que aprenden del histórico.

---

## 7. Riesgos y mitigación

| Riesgo | Mitigación |
|---|---|
| Romper producción `diglo-it` | Flag + backup + pruebas en emulador antes de activar |
| Tickets sin clasificar en sync | Fallback «Sin clasificar»; reporte de cobertura en dry-run |
| Conflicto con agente Codex | Trabajar en worktree; commits acotados por fichero |
| ACL mal configurada expone tickets | Fase 5 con tests de reglas en emulador; default seguro (`all`) |
| Deriva grupo configurado vs real | El enrutado vivo (Fase 7) corrige; validar contra Anexo A.4 |
