# Service account que usa GitHub Actions para desplegar (hosting + reglas).
# Sin claves JSON: se autentica por Workload Identity Federation (OIDC de GitHub).
resource "google_service_account" "deployer" {
  project      = var.project_id
  account_id   = "atenza-deployer"
  display_name = "Atenza CI deployer"
  depends_on   = [google_project_service.services]
}

resource "google_project_iam_member" "deployer_roles" {
  for_each = toset([
    # Rol canónico para deploy de Firebase por CI (hosting + reglas + storage).
    "roles/firebase.admin",
    "roles/firebasehosting.admin",
    "roles/firebaserules.admin",
    "roles/firebase.developAdmin",
    "roles/serviceusage.serviceUsageConsumer",
  ])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.deployer.email}"
}

# --- Workload Identity Federation para GitHub Actions ---
resource "google_iam_workload_identity_pool" "github" {
  project                   = var.project_id
  workload_identity_pool_id = "github-actions"
  display_name              = "GitHub Actions"
  depends_on                = [google_project_service.services]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  display_name                       = "GitHub OIDC"

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
  }

  # Solo este repositorio puede impersonar la SA de deploy.
  attribute_condition = "assertion.repository == \"${var.github_repo}\""

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account_iam_member" "deployer_wif" {
  service_account_id = google_service_account.deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_repo}"
}
