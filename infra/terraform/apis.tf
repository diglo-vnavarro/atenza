# APIs necesarias. disable_on_destroy=false para no romper otros recursos del
# proyecto si algún día se hace destroy de este módulo.
locals {
  services = [
    "cloudresourcemanager.googleapis.com",
    "serviceusage.googleapis.com",
    "firebase.googleapis.com",
    "firebasehosting.googleapis.com",
    "firebaserules.googleapis.com",
    "firestore.googleapis.com",
    "identitytoolkit.googleapis.com",
    "storage.googleapis.com",
    "firebasestorage.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "sts.googleapis.com",
    # Sync periódica SDP → ticketIN (Cloud Run Job + Scheduler)
    "run.googleapis.com",
    "cloudscheduler.googleapis.com",
    "secretmanager.googleapis.com",
    "cloudbuild.googleapis.com",
    "artifactregistry.googleapis.com",
    # Cloud Functions 2ª gen (auto-alta de acceso, correo): las habilitaba a mano la
    # primera `firebase deploy --only functions` en prod; en dv las despliega el CI, cuya
    # SA no puede habilitar APIs. Así el proyecto nace completo.
    "cloudfunctions.googleapis.com",
    "eventarc.googleapis.com",
    "pubsub.googleapis.com",
    "logging.googleapis.com",
  ]
}

resource "google_project_service" "services" {
  for_each           = toset(local.services)
  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}
