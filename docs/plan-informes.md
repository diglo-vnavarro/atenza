# Plan — Módulo de Informes (M2)

> Estado: **EN CONSTRUCCIÓN.** F1 (motor) arrancado 2026-08-28. Necesita las plantillas de
> informe actuales del equipo para afinar los presets (retomar con negocio).

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
