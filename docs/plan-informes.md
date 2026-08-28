# Plan — Módulo de Informes (M2)

> Estado: **F1 y F2 HECHOS Y DESPLEGADOS (2026-08-28).** Falta la UI de administración de
> informes programados (F2.1/F3), poner `REPORTS_LIVE=1` con destinatarios reales, y afinar los
> presets con las plantillas actuales del equipo (retomar con negocio).

## F2 DESPLEGADO — envío semanal programado
- **Job**: Cloud Run job **`send-reports`** (europe-west1, imagen `atenza/sync:latest`, SA
  `atenza-sync@`, `TENANT=diglo-it`, comando `npm run reports:job`). Sin secretos Zoho (solo
  Firestore).
- **Scheduler**: `atenza-send-reports` → **lunes 07:00 Europe/Madrid** (`0 7 * * 1`), dispara el
  job vía SA invoker `atenza-sync-invoker@`.
- **Seguro por defecto**: envía a **TEST** (`REPORTS_TEST_EMAIL`, hoy testerino-ia@) salvo
  `REPORTS_LIVE=1` en el job (entonces usa los `recipients` de cada schedule).
- **Verificado**: ejecución manual → correo «Resumen semanal por grupo» encolado en `mail` y
  **entregado** (`delivery=SUCCESS`).
- Hay 1 `reportSchedule` de prueba sembrado (a TEST) como ejemplo. Configurar los reales (con
  destinatarios) = UI de admin (pendiente) o por script.
- Redeploy del job: reconstruir `atenza/sync:latest` (`gcloud builds submit`) + `gcloud run jobs
  update send-reports --image …`. Ver también `docs/deploy-sync.md`.

## Objetivo
Automatizar los **informes semanales** actuales (altas/bajas, BI, WEB/REO…) desde Atenza, con
**entrega por email** y **consulta/descarga en la app**. Es un **módulo nuevo** («Informes»), no un
ajuste.

## Reutilizable (no partimos de cero)
- **Agregaciones del Panel de servicio** (por estado/grupo/técnico/prioridad/evolución) →
  factorizadas al motor `src/reports.ts`.
- **Exportar CSV** ya existe (vista de tickets → CSV).
- **Entrega por email**: `enqueueMail` + extensión `firestore-send-email`.
- **Cloud Scheduler** (como la sync) + **Cloud Run job** para la generación programada.
- Cap `viewReports` (permiso ya contemplado).

## Arquitectura
`Definiciones de informe (admin)` → `Motor de informes` (agrega tickets por periodo/filtros) →
render **HTML/CSV/PDF** → **email a destinatarios** + **historial en la app**. Generación
**on-demand** (botón) y **programada** (Scheduler semanal).

## Componentes
| # | Componente | Detalle | Fase |
|---|---|---|---|
| 1 | Motor `src/reports.ts` (puro, testeable) | tickets + def + periodo → datos agregados por dimensión | **F1 (en curso)** |
| 2 | Presets | Por grupo/estado/categoría/técnico/prioridad/tipo + los del equipo (altas/bajas, BI, WEB con filtros) | F1 |
| 3 | Sección «Informes» (app) | ejecutar on-demand, ver resultado, **exportar CSV** | F1 |
| 4 | Programación + email | Cloud Run job + Scheduler (semanal); render HTML/CSV; envío a destinatarios | F2 |
| 5 | Historial/descarga | informes generados guardados (Storage/Firestore) + vista en la app | F2/F3 |
| 6 | Constructor a medida + PDF | definir informes con filtros/formato desde la UI | F3 |

## Fases
- **F1 (MVP, en curso)**: motor + presets + generación **on-demand** en la app + CSV.
- **F2**: **programación semanal** + entrega por email a destinatarios.
- **F3**: constructor a medida + PDF + historial.

## Insumos/decisiones (con negocio)
1. **Especificar los informes actuales** — qué métricas/cortes lleva cada uno (altas/bajas, BI,
   WEB…). El equipo aporta sus plantillas actuales → se traducen a presets con filtros.
2. **Formato de entrega**: ¿HTML en el correo + CSV adjunto? ¿PDF?
3. **Destinatarios y cadencia** por informe (semanal, qué día/hora).
4. **Historial en la app**: ¿guardar los generados para consultar/descargar?
