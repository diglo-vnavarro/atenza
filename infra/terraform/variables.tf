variable "project_id" {
  type        = string
  description = "ID del proyecto GCP YA creado (con cuenta de facturación vinculada)."
}

variable "region" {
  type        = string
  description = "Región por defecto para recursos regionales."
  default     = "europe-west1"
}

variable "location" {
  type        = string
  description = "Ubicación multi-región de Firestore (p. ej. eur3)."
  default     = "eur3"
}

variable "bucket_location" {
  type        = string
  description = "Ubicación del bucket de Cloud Storage (multi-región: EU/US/ASIA, o una región)."
  default     = "EU"
}

variable "github_repo" {
  type        = string
  description = "owner/repo de GitHub autorizado a desplegar vía Workload Identity Federation."
  default     = "diglo-vnavarro/atenza"
}

variable "web_app_display_name" {
  type        = string
  description = "Nombre visible de la app web en Firebase."
  default     = "Atenza"
}

# --- Google como proveedor de identidad (usuarios internos) ---
# Atenza NO bloquea por dominio (es multi-tenant con clientes externos): el
# aislamiento vive en firestore.rules. Google se ofrece para los internos;
# email/contraseña (abajo, siempre activo) para externos e invitados.
# Si dejas estos vacíos, habilita Google desde la consola de Firebase.
variable "google_oauth_client_id" {
  type        = string
  description = "Client ID de OAuth para el proveedor Google (opcional)."
  default     = ""
}

variable "google_oauth_client_secret" {
  type        = string
  description = "Client secret de OAuth para el proveedor Google (opcional)."
  default     = ""
  sensitive   = true
}
