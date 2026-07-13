# Habilita Firebase sobre el proyecto GCP existente y registra la app web.
resource "google_firebase_project" "default" {
  provider   = google-beta
  project    = var.project_id
  depends_on = [google_project_service.services]
}

resource "google_firebase_web_app" "default" {
  provider     = google-beta
  project      = var.project_id
  display_name = var.web_app_display_name
  depends_on   = [google_firebase_project.default]
}

# Config pública de la app web (api_key, auth_domain, app_id...) que alimenta
# las variables VITE_FIREBASE_* del build. Se expone en outputs.tf.
data "google_firebase_web_app_config" "default" {
  provider   = google-beta
  project    = var.project_id
  web_app_id = google_firebase_web_app.default.app_id
}
