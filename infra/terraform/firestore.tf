resource "google_firestore_database" "default" {
  provider    = google-beta
  project     = var.project_id
  name        = "(default)"
  location_id = var.location
  type        = "FIRESTORE_NATIVE"

  # Protección contra borrado accidental de la base de datos (y sus datos).
  delete_protection_state = "DELETE_PROTECTION_ENABLED"

  # Recuperación a un punto en el tiempo (ventana de 7 días).
  point_in_time_recovery_enablement = "POINT_IN_TIME_RECOVERY_ENABLED"

  depends_on = [google_firebase_project.default]
}
