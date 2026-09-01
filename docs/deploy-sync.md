# Despliegue de la sync SDP → ticketIN (Cloud Run Job)

La sincronización corre como **Cloud Run Job `sync-sdp`** (proyecto `diglo-desk-pd`,
región `europe-west1`), disparado por **Cloud Scheduler** (cada hora). La imagen se
construye del `Dockerfile` de la raíz: `CMD npm run sync:job` = `importer/etl.ts`
(ETL de SDP) + `scripts/sync-tickets.ts` (merge idempotente a Firestore).

- Imagen: `europe-west1-docker.pkg.dev/diglo-desk-pd/atenza/sync:latest`
- Service account del job: `atenza-sync@diglo-desk-pd.iam.gserviceaccount.com`
- Secrets (Secret Manager, montados como env): `ZOHO_REFRESH_TOKEN`, `ZOHO_CLIENT_ID`,
  `ZOHO_CLIENT_SECRET`. Env: `TENANT=diglo-it`, `IDENTITY_MAP_JSON` (fallback; hoy la
  fuente de verdad del idmap es la subcolección Firestore `tenants/diglo-it/idmap`).

> El CI de `deploy.yml` **solo** despliega Firebase (hosting + reglas). El Job de la
> sync NO se despliega ahí: usa el workflow `deploy-sync.yml` o los pasos manuales.

## Despliegue manual (fallback, requiere `gcloud` con permisos de owner/editor)

```bash
# 1) construir y subir la imagen (Cloud Build usa el Dockerfile; respeta .gcloudignore)
gcloud builds submit \
  --tag europe-west1-docker.pkg.dev/diglo-desk-pd/atenza/sync:latest \
  --project diglo-desk-pd .

# 2) apuntar el Job a la imagen nueva (preserva env/secrets/SA)
gcloud run jobs update sync-sdp \
  --image europe-west1-docker.pkg.dev/diglo-desk-pd/atenza/sync:latest \
  --region europe-west1 --project diglo-desk-pd

# 3) (opcional) ejecutar una vez para verificar (el Scheduler lo haría igual)
gcloud run jobs execute sync-sdp --region europe-west1 --project diglo-desk-pd --wait

# 4) revisar los logs de la ejecución (debe verse idmap de Firestore + fase roster)
gcloud logging read \
  'resource.type="cloud_run_job" AND labels."run.googleapis.com/execution_name"="<EXEC_ID>"' \
  --project diglo-desk-pd --limit 100 --format="value(textPayload)"
```

## Despliegue por CI (`.github/workflows/deploy-sync.yml`)

- **Manual**: pestaña *Actions → Deploy sync job → Run workflow* (opción `execute`
  para lanzarlo tras desplegar).
- **En push a `main`** (si cambian `Dockerfile`/`scripts`/`importer`/`src`): solo si
  la variable de repo `CI_DEPLOY_SYNC=true`.
- Autenticación por **Workload Identity Federation** (igual que `deploy.yml`).
  El SA usado (`secrets.SYNC_DEPLOY_SA_EMAIL`, o reutilizar `DEPLOY_SA_EMAIL` si tiene
  permisos) necesita los roles:
  - `roles/cloudbuild.builds.editor` (Cloud Build)
  - `roles/artifactregistry.writer` (subir la imagen)
  - `roles/run.developer` (actualizar/ejecutar el Job)
  - `roles/iam.serviceAccountUser` sobre `atenza-sync@…` (para actuar como el SA del Job)

## Verificación (qué debe aparecer en los logs)

```
idmap: +N de Firestore (total M).
members: … · K omitidos por estar en el mapa de identidad.   ← dedup durable
roster: A altas · B bajas · C miembros alineados a la verdad ticketIN.   ← roster durable
```
