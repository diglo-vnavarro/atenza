# Config web para las variables VITE_FIREBASE_* (build local y secrets de CI).
# Recupérala con:  terraform output -json firebase_config
output "firebase_config" {
  description = "Valores para .env.local y para los secrets del workflow de deploy."
  sensitive   = true
  value = {
    VITE_FIREBASE_API_KEY             = data.google_firebase_web_app_config.default.api_key
    VITE_FIREBASE_AUTH_DOMAIN         = data.google_firebase_web_app_config.default.auth_domain
    VITE_FIREBASE_PROJECT_ID          = var.project_id
    VITE_FIREBASE_APP_ID              = google_firebase_web_app.default.app_id
    VITE_FIREBASE_STORAGE_BUCKET      = google_storage_bucket.files.name
    VITE_FIREBASE_MESSAGING_SENDER_ID = try(data.google_firebase_web_app_config.default.messaging_sender_id, "")
  }
}

output "deploy_service_account_email" {
  description = "Secret DEPLOY_SA_EMAIL del workflow de deploy."
  value       = google_service_account.deployer.email
}

output "workload_identity_provider" {
  description = "Secret WIF_PROVIDER del workflow de deploy (nombre completo del provider)."
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "files_bucket" {
  description = "Bucket de Cloud Storage para adjuntos."
  value       = google_storage_bucket.files.name
}
