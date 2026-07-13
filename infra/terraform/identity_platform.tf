# Configuración de Identity Platform (Authentication).
# Atenza admite identidades EXTERNAS: email/contraseña siempre activo (clientes,
# invitados) + Google opcional (internos). Sin candado de dominio: el aislamiento
# multi-tenant se impone en firestore.rules.
resource "google_identity_platform_config" "default" {
  provider = google-beta
  project  = var.project_id

  authorized_domains = [
    "localhost",
    "${var.project_id}.web.app",
    "${var.project_id}.firebaseapp.com",
  ]

  sign_in {
    allow_duplicate_emails = false

    email {
      enabled           = true
      password_required = true
    }

    phone_number {
      enabled = false
    }

    anonymous {
      enabled = false
    }
  }

  # Multi-tenancy NATIVA de Identity Platform desactivada: el aislamiento entre
  # clientes de Atenza vive en firestore.rules (tenants/{id}), no en IP.
  multi_tenant {
    allow_tenants = false
  }

  depends_on = [
    google_project_service.services,
    google_firebase_project.default,
  ]
}

# Proveedor Google (internos). Se crea solo si se aportan las credenciales OAuth;
# si no, habilítalo en la consola de Firebase (más simple).
resource "google_identity_platform_default_supported_idp_config" "google" {
  count = var.google_oauth_client_id != "" ? 1 : 0

  provider      = google-beta
  project       = var.project_id
  idp_id        = "google.com"
  enabled       = true
  client_id     = var.google_oauth_client_id
  client_secret = var.google_oauth_client_secret

  depends_on = [google_identity_platform_config.default]
}
