# Bucket para adjuntos de tickets (binario aquí; metadatos en Firestore).
# Preparado para cuando el módulo de adjuntos entre en Atenza.
resource "google_storage_bucket" "files" {
  name                        = "${var.project_id}-atenza-files"
  project                     = var.project_id
  location                    = var.bucket_location
  uniform_bucket_level_access = true
  force_destroy               = false

  versioning {
    enabled = true
  }

  cors {
    origin          = ["https://${var.project_id}.web.app", "https://${var.project_id}.firebaseapp.com", "http://localhost:5190"]
    method          = ["GET", "PUT", "POST", "DELETE", "HEAD"]
    response_header = ["Content-Type", "Authorization", "Content-Length", "x-goog-resumable"]
    max_age_seconds = 3600
  }

  depends_on = [google_project_service.services]
}

# Vincula el bucket a Firebase Storage (para que apliquen las storage.rules).
resource "google_firebase_storage_bucket" "files" {
  provider   = google-beta
  project    = var.project_id
  bucket_id  = google_storage_bucket.files.name
  depends_on = [google_firebase_project.default]
}
