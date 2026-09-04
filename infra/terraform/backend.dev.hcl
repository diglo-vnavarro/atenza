# Backend de estado para DEV (bucket propio, mismo prefix atenza/infra).
# Créalo una vez en el bootstrap (ver infra/README.md §5) y luego:
#   terraform init -reconfigure -backend-config=backend.dev.hcl
bucket = "atenza-tfstate-diglo-desk-dv"
