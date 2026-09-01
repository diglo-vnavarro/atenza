# Plan — Migrar adjuntos de SDP (M1)

> Estado: **planificado, script listo (dry-run validado).** Falta decidir alcance/coste con
> negocio y ejecutar. Retomar la semana del 2026-09-01. Redactado 2026-08-28.

## Objetivo
Traer los **adjuntos históricos de SDP** a **Firebase Storage** y referenciarlos en cada ticket
de ticketIN (`diglo-it`). Hoy el **ETL no los trae** → el histórico está sin adjuntos (la sync
preserva los adjuntos nativos de ticketIN pero no importa los de SDP).

## Volumen y coste
- **Prevalencia**: ~27-41% de tickets con adjuntos · ~0,5 ficheros/ticket · media ~1-1,8 MB.
- **Estimado**: **~10-21 GB · ~12k ficheros** (rango de muestreo; el **tamaño exacto** lo da el
  `--dry-run` completo del script, recorriendo los ~24k tickets).
- **Coste de almacenamiento: negligible** — ~$0,43/mes en Standard (~$5/año) para 21 GB; menos con
  clases frías. El coste real de M1 es el **esfuerzo de desarrollo + tiempo de proceso** y el
  **egress** al servir (solo por lo que se abre; el histórico se abre poco).

## Bucket + lifecycle (YA aplicado)
- Bucket de adjuntos: **`gs://diglo-desk-pd-atenza-files`** (EU). Es un bucket **GCS** (Firebase
  Storage lo es); ruta `tenants/{tid}/tickets/{ticketId}/…`.
- **Lifecycle aplicado** (`infra/attachments-lifecycle.json`): objetos bajo `tenants/` →
  **Nearline a los 30 días** → **Coldline a los 90**. Abarata el histórico sin perder
  funcionalidad (misma API de acceso; solo sube algo la latencia/coste de recuperación de lo muy
  viejo). Reversible (quitar la regla).

## Script de migración
`scripts/migrate-attachments.ts` (dry-run/`--apply`, `LIMIT=N` para acotar):
- **dry-run**: recorre SDP, cuenta ficheros y suma tamaños EXACTOS. No descarga ni escribe.
- **--apply**: descarga de SDP → sube a Storage (`tenants/{tid}/tickets/{docId}/sdp-{attId}-{name}`)
  → patch `ticket.attachments`. **Idempotente** (salta tickets que ya tienen adjuntos) y reanudable.
- OJO al `--apply`: verificar el **endpoint de descarga** de SDP (usa `attachment.content_url`, con
  fallback `/requests/{id}/_uploads/{attId}/download`) con una prueba pequeña (`LIMIT=5 --apply`)
  antes de la pasada completa.

## Decisiones pendientes (negocio/técnicas)
1. **Alcance**: ¿migrar **todo** el histórico, o solo **abiertos + últimos N meses**? *(recomendado:
   empezar por abiertos+reciente; el resto en 2ª pasada o bajo demanda)*.
2. **Cuándo**: ¿backfill una vez (histórico) + **extender la sync** para traer adjuntos de tickets
   SDP nuevos durante la convivencia, o solo al corte?
3. **Confirmar coste** de egress/almacenamiento con el tamaño exacto del dry-run completo.
