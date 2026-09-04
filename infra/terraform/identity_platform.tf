# Configuración de Identity Platform (Authentication).
# ticketIN admite identidades EXTERNAS: email/contraseña siempre activo (clientes,
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

  # MFA (2º factor TOTP) para los usuarios externos (email/contraseña); Google (internos)
  # lo cubre Workspace. state=ENABLED (opcional a nivel de IP: la app lo hace obligatorio
  # para externos en src/ui/MfaGate.tsx). En pd se activó por la Admin API el 2026-09-03
  # con estos mismos valores; aquí queda declarado para que dv y cualquier proyecto nuevo
  # nazcan igual. adjacent_intervals=5 = tolerancia de ±5 ventanas de 30 s.
  mfa {
    state = "ENABLED"
    provider_configs {
      state = "ENABLED"
      totp_provider_config {
        adjacent_intervals = 5
      }
    }
  }

  # Multi-tenancy NATIVA de Identity Platform desactivada: el aislamiento entre
  # clientes de ticketIN vive en firestore.rules (tenants/{id}), no en IP.
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
