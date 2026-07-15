# ============================================================================
# Puente periódico Atenza → OrganiZate (carga del técnico).
#
#   Cloud Scheduler --(HTTP :run, OAuth SA)--> Cloud Run Job "sync-organizate"
#     El job ejecuta `npm run sync:organizate` (scripts/sync-organizate.ts):
#     refleja las tareas de los tickets (de los grupos activados en
#     tenant.organizateGroupIds) como tareas en OrganiZate, para que sumen a la
#     carga. Idempotente; escribe con transacción tocando solo tareas propias.
#
# CLAVE — acceso CRUZADO a dos proyectos:
#   - lee Atenza      → Firestore de var.project_id (diglo-desk-pd)
#   - escribe OrganiZate → Firestore de var.organizate_project_id (diglo-organizate-pd)
#   La service account del job necesita roles/datastore.user en AMBOS proyectos.
#   El binding en diglo-organizate-pd lo aplica el propietario de ESE proyecto.
#
# Reparto:
#   - Terraform (este fichero): SA del job, IAM (datastore.user en los dos
#     proyectos), SA invocadora y Cloud Scheduler. Reutiliza el Artifact Registry
#     "atenza" y la imagen del job (mismo contenedor, distinto comando).
#   - Tú, una vez (deploy de la imagen con el comando del puente):
#       gcloud run jobs deploy sync-organizate --region ${REGION} \
#         --image ${REGION}-docker.pkg.dev/${PROJECT}/atenza/sync:latest \
#         --command npm --args run,sync:organizate \
#         --service-account atenza-organizate-sync@${PROJECT}.iam.gserviceaccount.com \
#         --set-env-vars TENANT=diglo-it,ATENZA_PROJECT=${PROJECT},ORGANIZATE_PROJECT=diglo-organizate-pd,ORGANIZATE_ORG_ID=diglo,DEFAULT_TASK_HOURS=1 \
#         --max-retries 1 --task-timeout 300s
#   Ver docs/SYNC-ORGANIZATE.md.
# ============================================================================

variable "organizate_project_id" {
  type        = string
  description = "Proyecto GCP de OrganiZate (destino de la carga)."
  default     = "diglo-organizate-pd"
}
variable "organizate_sync_schedule" {
  type        = string
  description = "Cron (zona horaria en sync_timezone) del puente Atenza→OrganiZate."
  default     = "*/30 * * * *" # cada 30 min
}
variable "organizate_job_name" {
  type    = string
  default = "sync-organizate"
}

# --- Service account del job del puente (lee Atenza, escribe OrganiZate) ---
resource "google_service_account" "org_sync" {
  project      = var.project_id
  account_id   = "atenza-organizate-sync"
  display_name = "Atenza · puente de carga Atenza→OrganiZate"
}

# Lectura/escritura de Firestore en Atenza (proyecto del job).
resource "google_project_iam_member" "org_sync_atenza_datastore" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.org_sync.email}"
}

# Acceso CRUZADO: Firestore de OrganiZate. Requiere permiso para conceder IAM en
# ese proyecto (lo aplica su propietario). Si Terraform no gestiona el otro
# proyecto, crear este binding aparte con la misma SA.
resource "google_project_iam_member" "org_sync_organizate_datastore" {
  project = var.organizate_project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.org_sync.email}"
}

# --- Service account que usa el Scheduler para invocar el job ---
resource "google_service_account" "org_sync_invoker" {
  project      = var.project_id
  account_id   = "atenza-org-sync-invoker"
  display_name = "Atenza · Scheduler que dispara el puente OrganiZate"
}
resource "google_project_iam_member" "org_invoker_run" {
  project = var.project_id
  role    = "roles/run.invoker"
  member  = "serviceAccount:${google_service_account.org_sync_invoker.email}"
}

# --- Cloud Scheduler: dispara el job por HTTP (API run v2 :run) ---
resource "google_cloud_scheduler_job" "org_sync" {
  project   = var.project_id
  region    = var.region
  name      = "atenza-sync-organizate"
  schedule  = var.organizate_sync_schedule
  time_zone = var.sync_timezone

  http_target {
    http_method = "POST"
    uri         = "https://${var.region}-run.googleapis.com/v2/projects/${var.project_id}/locations/${var.region}/jobs/${var.organizate_job_name}:run"
    oauth_token {
      service_account_email = google_service_account.org_sync_invoker.email
    }
  }
  depends_on = [google_project_service.services]
}
