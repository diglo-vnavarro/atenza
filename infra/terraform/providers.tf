provider "google" {
  project = var.project_id
  region  = var.region
  # Adjunta el proyecto como quota/billing en APIs que lo exigen (Identity Platform).
  user_project_override = true
  billing_project       = var.project_id
}

# Muchos recursos de Firebase/Identity Platform solo existen en el provider beta.
provider "google-beta" {
  project               = var.project_id
  region                = var.region
  user_project_override = true
  billing_project       = var.project_id
}
