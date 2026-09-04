# Entorno de DESARROLLO (diglo-desk-dv). Uso:
#   terraform init -reconfigure -backend-config=backend.dev.hcl
#   terraform plan  -var-file=dev.tfvars
#   terraform apply -var-file=dev.tfvars
# (Para volver a prod: terraform init -reconfigure -backend-config=backend.hcl)
project_id           = "diglo-desk-dv"
region               = "europe-west1"
location             = "eur3"
github_repo          = "diglo-vnavarro/atenza" # cambiar al transferir el repo a Digloservicer
web_app_display_name = "ticketIN DEV"

# En dv no corren las sincronizaciones (SDP→ticketIN, ticketIN→OrganiZate): sin Schedulers.
# Las SAs, secretos (vacíos) y el Artifact Registry sí se crean, por si hay que probar un Job a mano.
enable_sync_jobs      = false
organizate_project_id = "diglo-organizate-dv"
