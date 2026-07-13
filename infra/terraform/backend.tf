# Estado remoto en Cloud Storage (versionado, compartible por el equipo y CI).
# El bucket NO se define aquí: se pasa en el init con
#   terraform init -backend-config=backend.hcl
# (usa backend.hcl.example como plantilla). El bucket se crea una vez en el
# bootstrap (ver infra/README.md).
terraform {
  backend "gcs" {
    prefix = "atenza/infra"
  }
}
