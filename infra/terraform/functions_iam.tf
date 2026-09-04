# ============================================================================
# IAM que exige `firebase deploy --only functions` (Cloud Functions 2ª gen con
# triggers de Firestore vía Eventarc). En un proyecto nuevo el CLI intenta
# concederlos él mismo y, si quien despliega no puede tocar la política IAM del
# proyecto (la SA de CI), aborta con «We failed to modify the IAM policy». Aquí
# quedan declarados para que dv (y cualquier proyecto nuevo) nazca listo y el CI
# solo tenga que desplegar.
#
# Son exactamente los bindings que imprime el CLI cuando no puede aplicarlos:
#   service-<PN>@gcp-sa-pubsub  → roles/iam.serviceAccountTokenCreator
#   <PN>-compute@developer      → roles/run.invoker, roles/eventarc.eventReceiver
# más el rol del propio agente de Eventarc (roles/eventarc.serviceAgent), que Google
# concede al habilitar la API pero tarda en propagarse.
# ============================================================================

data "google_project" "current" {
  project_id = var.project_id
}

# Fuerza la creación de los service agents (si no, el binding falla por SA inexistente).
resource "google_project_service_identity" "pubsub" {
  provider   = google-beta
  project    = var.project_id
  service    = "pubsub.googleapis.com"
  depends_on = [google_project_service.services]
}

resource "google_project_service_identity" "eventarc" {
  provider   = google-beta
  project    = var.project_id
  service    = "eventarc.googleapis.com"
  depends_on = [google_project_service.services]
}

resource "google_project_iam_member" "pubsub_agent_token_creator" {
  project    = var.project_id
  role       = "roles/iam.serviceAccountTokenCreator"
  member     = "serviceAccount:service-${data.google_project.current.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
  depends_on = [google_project_service_identity.pubsub]
}

resource "google_project_iam_member" "eventarc_agent" {
  project    = var.project_id
  role       = "roles/eventarc.serviceAgent"
  member     = "serviceAccount:service-${data.google_project.current.number}@gcp-sa-eventarc.iam.gserviceaccount.com"
  depends_on = [google_project_service_identity.eventarc]
}

# SA de runtime por defecto de las functions 2ª gen (compute default). Existe en cuanto
# se habilita cloudfunctions/run en el proyecto.
resource "google_project_iam_member" "functions_runtime_roles" {
  for_each = toset([
    "roles/run.invoker",
    "roles/eventarc.eventReceiver",
  ])
  project    = var.project_id
  role       = each.value
  member     = "serviceAccount:${data.google_project.current.number}-compute@developer.gserviceaccount.com"
  depends_on = [google_project_service.services]
}
