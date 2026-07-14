# Sincronización periódica SDP → Atenza (Cloud Run Job + Scheduler)

Mantiene Atenza alineado con SDP durante la convivencia: cada N horas trae los
tickets **activos** de SDP (API v3) y hace un **merge idempotente** en Firestore,
**preservando** lo añadido en Atenza (worklog, tareas, aprobaciones, adjuntos,
comentarios, resolución) y **reconciliando identidades** (uid SDP → uid Firebase).

- Job: `npm run sync:job` = `importer/etl.ts` (ETL) + `scripts/sync-tickets.ts` (merge).
- Imagen: `Dockerfile` (raíz). Firestore por ADC de la SA del job; Zoho por env/Secret Manager.

## Prerрequisitos (una vez)

Terraform (`infra/terraform/`) ya declara: Artifact Registry `atenza`, los 3 secretos
de Zoho (vacíos), la SA del job `atenza-sync`, la SA invocadora `atenza-sync-invoker`,
el IAM y el Cloud Scheduler `atenza-sync-sdp`.

### 1. Aplicar la infra
```bash
cd infra/terraform
terraform apply   # crea repo, secretos (sin valor), SAs, IAM, scheduler
```

### 2. Poner los VALORES de los secretos de Zoho (TÚ; no pasan por Terraform ni por Claude)
Los valores están en tu `.zoho.local` (`refresh_token`, `client_id`, `client_secret`).
```bash
P=diglo-desk-pd
printf '%s' "<REFRESH_TOKEN>"  | gcloud secrets versions add zoho-refresh-token  --project $P --data-file=-
printf '%s' "<CLIENT_ID>"      | gcloud secrets versions add zoho-client-id      --project $P --data-file=-
printf '%s' "<CLIENT_SECRET>"  | gcloud secrets versions add zoho-client-secret  --project $P --data-file=-
```

### 3. Construir y desplegar el job
```bash
P=diglo-desk-pd; R=europe-west1
gcloud builds submit --project $P --tag $R-docker.pkg.dev/$P/atenza/sync:latest
gcloud run jobs deploy sync-sdp --project $P --region $R \
  --image $R-docker.pkg.dev/$P/atenza/sync:latest \
  --service-account atenza-sync@$P.iam.gserviceaccount.com \
  --set-env-vars TENANT=diglo-it,IDENTITY_MAP_JSON='{"9207000000198722":"QzdANMSSOuTQJWF9h18gaV0TRwo2"}' \
  --set-secrets ZOHO_REFRESH_TOKEN=zoho-refresh-token:latest,ZOHO_CLIENT_ID=zoho-client-id:latest,ZOHO_CLIENT_SECRET=zoho-client-secret:latest \
  --max-retries 1 --task-timeout 900s
```

> El mapa de identidad va en `IDENTITY_MAP_JSON` (env del job). Añade una entrada
> `"<uidSDP>":"<uidFirebase>"` por cada persona que traspases y vuelve a desplegar
> (`gcloud run jobs update sync-sdp --set-env-vars ...`).

## Probar a mano
```bash
gcloud run jobs execute sync-sdp --project diglo-desk-pd --region europe-west1 --wait
gcloud run jobs executions list --job sync-sdp --project diglo-desk-pd --region europe-west1
gcloud logging read 'resource.type=cloud_run_job AND resource.labels.job_name=sync-sdp' --project diglo-desk-pd --limit 30
```
Esperado en logs: `tickets: N nuevos, M actualizados · … · K identidades remapeadas.`

## Cadencia
Por defecto cada 4 h (`sync_schedule="0 */4 * * *"`, `Europe/Madrid`). Cambia con
`-var 'sync_schedule=...'` en `terraform apply`. El scheduler ya está creado y
dispara `sync-sdp:run`.

## ETL histórico completo (corte por instancia)

Durante la convivencia la sync trae solo tickets **activos**. En el corte de una
instancia (cuando se apaga SDP para ella) se trae el histórico completo con
`SCOPE=all` (incluye Cancelada/Cerrada/Resuelta, ~23k en Diglo ITSM):

```bash
SCOPE=all npx tsx importer/etl.ts   # regenera imported-tickets.json con TODO
GOOGLE_APPLICATION_CREDENTIALS=<adc> GOOGLE_CLOUD_PROJECT=diglo-desk-pd TENANT=diglo-it npm run sync
```

El merge sigue siendo idempotente y preserva lo añadido en Atenza. El **archivado /
retención** a largo plazo (mover histórico frío a almacenamiento barato / BigQuery)
queda como política de gobierno posterior, no bloquea el corte.

## Seguridad / convivencia
- Solo trae tickets **activos** (excluye Cancelada/Cerrada/Resuelta).
- Es **idempotente** y **no destructivo** (preserva lo de Atenza). Reejecutable.
- **No cambia dónde llega el correo**: los técnicos siguen en SDP. El corte por
  instancia (redirigir buzón) es el hito de correo entrante, más adelante.
- Secretos: solo en Secret Manager. Nunca en el repo ni en la imagen (ver `.gcloudignore`).
