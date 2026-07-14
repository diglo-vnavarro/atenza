# ============================================================================
# Sincronización periódica SDP → Atenza (fase de convivencia).
#
#   Cloud Scheduler  --(HTTP :run, OAuth SA)-->  Cloud Run Job "sync-sdp"
#     El job: ETL de tickets activos de SDP (API v3) + merge idempotente a
#     Firestore (preservando lo añadido en Atenza). Ver scripts/sync-tickets.ts
#     e importer/etl.ts (npm run sync:job).
#
# Reparto de responsabilidades:
#   - Terraform (este fichero): Artifact Registry, secretos (declarados; los
#     VALORES los pones tú), service accounts, IAM y el Cloud Scheduler.
#   - Tú, una vez (build + deploy de la imagen del job), con gcloud:
#       gcloud builds submit --tag ${REGION}-docker.pkg.dev/${PROJECT}/atenza/sync:latest
#       gcloud run jobs deploy sync-sdp --region ${REGION} \
#         --image ${REGION}-docker.pkg.dev/${PROJECT}/atenza/sync:latest \
#         --service-account atenza-sync@${PROJECT}.iam.gserviceaccount.com \
#         --set-env-vars TENANT=diglo-it,IDENTITY_MAP_JSON='{"9207000000198722":"QzdANMSSOuTQJWF9h18gaV0TRwo2"}' \
#         --set-secrets ZOHO_REFRESH_TOKEN=zoho-refresh-token:latest,ZOHO_CLIENT_ID=zoho-client-id:latest,ZOHO_CLIENT_SECRET=zoho-client-secret:latest \
#         --max-retries 1 --task-timeout 900s
#   Ver docs/SYNC-JOB.md para el runbook completo.
# ============================================================================

variable "sync_schedule" {
  type        = string
  description = "Cron (zona horaria en sync_timezone) para la sincronización SDP→Atenza."
  default     = "0 */4 * * *" # cada 4 horas
}
variable "sync_timezone" {
  type        = string
  description = "Zona horaria del cron del scheduler."
  default     = "Europe/Madrid"
}
variable "sync_job_name" {
  type    = string
  default = "sync-sdp"
}

# --- Artifact Registry: repo para la imagen del job ---
resource "google_artifact_registry_repository" "atenza" {
  project       = var.project_id
  location      = var.region
  repository_id = "atenza"
  format        = "DOCKER"
  description   = "Imágenes de Atenza (job de sincronización SDP→Atenza)."
  depends_on    = [google_project_service.services]
}

# --- Secretos de Zoho/SDP (VALORES fuera de Terraform; ver runbook) ---
locals {
  zoho_secrets = ["zoho-refresh-token", "zoho-client-id", "zoho-client-secret"]
}
resource "google_secret_manager_secret" "zoho" {
  for_each  = toset(local.zoho_secrets)
  project   = var.project_id
  secret_id = each.value
  replication {
    auto {}
  }
  depends_on = [google_project_service.services]
}

# --- Service account del job (escribe Firestore + lee secretos) ---
resource "google_service_account" "sync" {
  project      = var.project_id
  account_id   = "atenza-sync"
  display_name = "Atenza · job de sincronización SDP→Atenza"
}
resource "google_project_iam_member" "sync_datastore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.sync.email}"
}
resource "google_secret_manager_secret_iam_member" "sync_secret_access" {
  for_each  = google_secret_manager_secret.zoho
  project   = var.project_id
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.sync.email}"
}

# --- Service account que usa el Scheduler para invocar el job ---
resource "google_service_account" "sync_invoker" {
  project      = var.project_id
  account_id   = "atenza-sync-invoker"
  display_name = "Atenza · Scheduler que dispara el job de sincronización"
}
# Permite ejecutar (run) el Cloud Run Job.
resource "google_project_iam_member" "invoker_run" {
  project = var.project_id
  role    = "roles/run.invoker"
  member  = "serviceAccount:${google_service_account.sync_invoker.email}"
}

# --- Cloud Scheduler: dispara el job por HTTP (API run v2 :run) ---
resource "google_cloud_scheduler_job" "sync" {
  project   = var.project_id
  region    = var.region
  name      = "atenza-sync-sdp"
  schedule  = var.sync_schedule
  time_zone = var.sync_timezone

  http_target {
    http_method = "POST"
    uri         = "https://${var.region}-run.googleapis.com/v2/projects/${var.project_id}/locations/${var.region}/jobs/${var.sync_job_name}:run"
    oauth_token {
      service_account_email = google_service_account.sync_invoker.email
    }
  }
  depends_on = [google_project_service.services]
}
