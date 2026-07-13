# Infraestructura de Atenza (GCP + Firebase)

Terraform que aprovisiona el proyecto: Firestore, Identity Platform (Google +
email/contraseña, sin candado de dominio), Cloud Storage, Firebase Hosting y
Workload Identity Federation para el deploy por CI. Reglas de aislamiento
multi-tenant en `../firestore.rules` (ya escritas y testeadas).

## Requisitos previos (los hace el usuario)

1. **Crear el proyecto GCP** nuevo y **vincular una cuenta de facturación**
   (ej.: `atenza-prod`). Terraform NO crea el proyecto ni el billing.
2. `gcloud auth application-default login` (ADC) con una cuenta con permisos de
   Owner/Editor sobre el proyecto.
3. Habilitar una vez las 2 APIs de arranque (el resto las habilita Terraform):
   ```
   gcloud services enable serviceusage.googleapis.com cloudresourcemanager.googleapis.com --project ATENZA_PROJECT
   ```

## Bootstrap del estado remoto (una vez)

```bash
gcloud storage buckets create gs://atenza-tfstate-ATENZA_PROJECT \
  --project ATENZA_PROJECT --location EU --uniform-bucket-level-access
gcloud storage buckets update gs://atenza-tfstate-ATENZA_PROJECT --versioning
```

## Aplicar

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars   # edita project_id, github_repo…
cp backend.hcl.example backend.hcl             # pon el bucket de estado
terraform init -backend-config=backend.hcl
terraform apply
```

## Tras el apply

```bash
terraform output -json firebase_config          # valores VITE_FIREBASE_*
terraform output deploy_service_account_email    # secret DEPLOY_SA_EMAIL
terraform output workload_identity_provider       # secret WIF_PROVIDER
```

- Pon esos valores en `.env.local` (build local) y como **secrets** del repo
  `diglo-vnavarro/atenza` (Actions): `VITE_FIREBASE_*`, `DEPLOY_SA_EMAIL`, `WIF_PROVIDER`.
- **Habilita el proveedor Google** en la consola de Firebase (Authentication) si
  no lo configuraste vía Terraform. Email/contraseña ya queda activo.
- Despliega reglas + hosting: push a `main` (workflow `deploy.yml`) o a mano:
  ```
  cp ../../.firebaserc.example ../../.firebaserc   # pon el project id
  npx firebase-tools deploy --only firestore:rules,storage --project ATENZA_PROJECT
  ```

## Notas / gotchas heredados de OrganiZate

- `providers.tf` usa `user_project_override=true` + `billing_project` (lo exige
  Identity Platform, si no da error de quota project).
- El bucket de Storage usa `bucket_location` (`EU`), no `eur3` (eso solo vale para
  Firestore).
- Al hacer ADC login puede salir un aviso benigno `Regional Access Boundary 404`;
  se ignora.
