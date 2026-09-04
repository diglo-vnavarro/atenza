# Infraestructura de ticketIN (GCP + Firebase)

Terraform que aprovisiona **cada proyecto** (un módulo, dos entornos): Firestore, Identity
Platform (Google + email/contraseña, sin candado de dominio), Cloud Storage, Firebase Hosting,
Workload Identity Federation para el deploy por CI y (solo producción) los Schedulers de las
sincronizaciones. Reglas de aislamiento multi-tenant en `../firestore.rules` (ya escritas y testeadas).

| Entorno | Proyecto GCP | Estado Terraform | Rama que despliega | URL |
| --- | --- | --- | --- | --- |
| `pd` (producción) | `diglo-desk-pd` | `backend.hcl` + `terraform.tfvars` | `release/pd` | https://diglo-desk-pd.web.app |
| `dv` (desarrollo) | `diglo-desk-dv` | `backend.dev.hcl` + `dev.tfvars` | `main` | https://diglo-desk-dv.web.app |

Flujo de ramas (común a los repos Diglosfera/HUB360): [`../docs/git-workflow.md`](../docs/git-workflow.md).

## Requisitos previos (los hace el usuario)

1. **Crear el proyecto GCP** nuevo y **vincular una cuenta de facturación**. Terraform NO crea
   el proyecto ni el billing.
2. `gcloud auth application-default login` (ADC) con una cuenta con permisos de
   Owner/Editor sobre el proyecto.
3. Habilitar una vez las 2 APIs de arranque (el resto las habilita Terraform):
   ```
   gcloud services enable serviceusage.googleapis.com cloudresourcemanager.googleapis.com --project PROYECTO
   ```

## Bootstrap del estado remoto (una vez por proyecto)

```bash
gcloud storage buckets create gs://atenza-tfstate-PROYECTO \
  --project PROYECTO --location EU --uniform-bucket-level-access
gcloud storage buckets update gs://atenza-tfstate-PROYECTO --versioning
```

## Aplicar (producción)

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars   # edita project_id, github_repo…
cp backend.hcl.example backend.hcl             # pon el bucket de estado
terraform init -reconfigure -backend-config=backend.hcl
terraform apply
```

> Producción tiene hoy **deriva conocida** respecto al módulo (política de ciclo de vida del bucket
> de adjuntos aplicada a mano, `attachments-lifecycle.json`; descripciones de SAs). Antes de un
> `apply` en prod, revisa el `plan` y codifica en Terraform lo que deba conservarse.

## Tras el apply

```bash
terraform output -json firebase_config          # valores VITE_FIREBASE_*
terraform output deploy_service_account_email    # secret DEPLOY_SA_EMAIL
terraform output workload_identity_provider       # secret WIF_PROVIDER
```

- Pon esos valores en `.env.local` (build local) y como **secrets** del entorno de GitHub que
  corresponda (§4): `VITE_FIREBASE_*`, `DEPLOY_SA_EMAIL`, `WIF_PROVIDER`.
- **Habilita el proveedor Google** en la consola de Firebase (Authentication) si
  no lo configuraste vía Terraform. Email/contraseña ya queda activo.
- Despliega reglas + hosting: por CI (§4) o a mano con los alias de `.firebaserc`:
  ```
  npx firebase-tools deploy --only firestore:rules,storage,hosting --project prod|dev
  ```

## 4. Despliegue por CI (GitHub Actions)

| Workflow | Disparador | Entorno GitHub | Proyecto | Alcance |
| --- | --- | --- | --- | --- |
| [`ci.yml`](../.github/workflows/ci.yml) | PRs a `main`/`release/pd` y push a `main` | — | — | quality gate: typecheck, tests, build, functions |
| [`deploy-app.yml`](../.github/workflows/deploy-app.yml) | push a `main` | `development` | `diglo-desk-dv` | hosting + reglas + **functions** |
| [`deploy-app-pd.yml`](../.github/workflows/deploy-app-pd.yml) | push a `release/pd` (fast-forward desde `main`) o `workflow_dispatch` | `production` | `diglo-desk-pd` | hosting + reglas |
| [`deploy-sync.yml`](../.github/workflows/deploy-sync.yml) | push a `release/pd` (si cambian `Dockerfile`/`scripts`/`importer`/`src` y `CI_DEPLOY_SYNC=true`) o manual | `production` | `diglo-desk-pd` | Cloud Run Job `sync-sdp` ([`../docs/deploy-sync.md`](../docs/deploy-sync.md)) |

Todos se autentican por **Workload Identity Federation** (sin claves JSON). Los deploy targets
`app` (hosting) y `attachments` (bucket de Storage) se resuelven por proyecto en `.firebaserc`
(versionado; alias `prod` / `dev`).

En **producción** las Cloud Functions y la extensión `firestore-send-email` se despliegan **a mano**
(`npx firebase-tools deploy --only functions --project prod`; la extensión **nunca** con
`--non-interactive --force`). Para llevar las functions de pd a CI hay que aplicar en prod los
roles añadidos a la SA de deploy (`iam.tf`) y ampliar `--only` en `deploy-app-pd.yml`.

Secrets por entorno (**Settings → Environments → `production` / `development`**), valores de los
outputs de Terraform del proyecto correspondiente:

| Secret | Origen |
|---|---|
| `WIF_PROVIDER` | `terraform output workload_identity_provider` |
| `DEPLOY_SA_EMAIL` | `terraform output deploy_service_account_email` |
| `VITE_FIREBASE_API_KEY` | `firebase_config.VITE_FIREBASE_API_KEY` |
| `VITE_FIREBASE_AUTH_DOMAIN` | `firebase_config.VITE_FIREBASE_AUTH_DOMAIN` |
| `VITE_FIREBASE_PROJECT_ID` | `firebase_config.VITE_FIREBASE_PROJECT_ID` |
| `VITE_FIREBASE_APP_ID` | `firebase_config.VITE_FIREBASE_APP_ID` |
| `VITE_FIREBASE_STORAGE_BUCKET` | `firebase_config.VITE_FIREBASE_STORAGE_BUCKET` |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | `firebase_config.VITE_FIREBASE_MESSAGING_SENDER_ID` |

Solo `production` lleva además `SYNC_DEPLOY_SA_EMAIL` (Job de la sync) y la variable de repo
`CI_DEPLOY_SYNC`.

**Protección de ramas**: `main` y `release/pd` exigen los checks de `CI`, historia lineal y no
admiten force-push ni borrado (rulesets de GitHub; los administradores pueden hacer push directo).

> El repositorio vive hoy en `diglo-vnavarro/atenza` (cuenta personal, **público**). Debería
> transferirse a la organización `Digloservicer` como el resto (OrganiZate ya lo hizo). Al hacerlo:
> cambiar `github_repo` en `terraform.tfvars` y `dev.tfvars` y aplicar en ambos proyectos (la
> condición del proveedor WIF está atada al `owner/repo`), y revisar los secrets de los entornos.

## 5. Entorno de desarrollo (`diglo-desk-dv`)

Mismo módulo de Terraform, **otro proyecto** y **otro bucket de estado**. Convención:
`-pd` = producción, `-dv` = desarrollo.

### 5.1 Manual (una sola vez, en consola/gcloud)

1. Proyecto GCP **`diglo-desk-dv`** con **cuenta de facturación** vinculada (hecho).
2. APIs de arranque y bucket de estado:
   ```bash
   PROJECT_ID=diglo-desk-dv
   gcloud services enable serviceusage.googleapis.com cloudresourcemanager.googleapis.com --project=$PROJECT_ID
   gcloud storage buckets create gs://atenza-tfstate-$PROJECT_ID --project=$PROJECT_ID --location=EU --uniform-bucket-level-access
   gcloud storage buckets update gs://atenza-tfstate-$PROJECT_ID --versioning
   ```

### 5.2 Terraform (dev)

```bash
cd infra/terraform
terraform init -reconfigure -backend-config=backend.dev.hcl
terraform plan  -var-file=dev.tfvars
terraform apply -var-file=dev.tfvars
terraform output -json firebase_config          # → secrets VITE_* del entorno development
terraform output deploy_service_account_email   # → DEPLOY_SA_EMAIL
terraform output workload_identity_provider     # → WIF_PROVIDER
# Para volver a operar prod: terraform init -reconfigure -backend-config=backend.hcl
```

> `-reconfigure` cambia de backend sin migrar estado. **Comprueba siempre** con
> `terraform state list` contra qué proyecto estás antes de `apply`.

`dev.tfvars` pone `enable_sync_jobs = false` (sin Schedulers ni Jobs de sincronización en dv) y
`organizate_project_id = diglo-organizate-dv` (la SA del puente solo tendría acceso al OrganiZate de dev).

### 5.3 Manual tras el apply (consola)

- **Firebase → Authentication → Sign-in method → Google**: habilitar (crea el cliente OAuth).
- **GitHub → Settings → Environments → `development`**: entorno y secrets (tabla de §4 con los
  outputs de **dev**).
- **Extensión de email** (`firestore-send-email`): en dev **no instalarla**. La app encola en `mail`
  y nada sale; así no se envían correos reales desde desarrollo.
- **MFA (TOTP) para externos**: Identity Platform lo lleva activado en prod por consola; en dev
  activarlo solo si se va a probar ese flujo (`scripts/mfa-admin.ts`).

### 5.4 Acceso y datos en dev

Dev arranca **vacío**: no hay tenants ni miembros, y las reglas solo dejan entrar a quien sea
miembro activo de un tenant (o `platformAdmins/{uid}`). Para poder usarlo:

```bash
# 1) entra una vez en https://diglo-desk-dv.web.app con Google para que exista tu uid
# 2) date de alta como superadmin de plataforma y siembra un tenant de pruebas
GOOGLE_CLOUD_PROJECT=diglo-desk-dv npx tsx scripts/bootstrap.ts
```

Los scripts de `scripts/` y `herramientas/` apuntan a **producción por defecto**: en dev pasa
siempre `GOOGLE_CLOUD_PROJECT=diglo-desk-dv`. **Nunca** copiar datos reales (tickets, PII) de
producción a dev; usa el seed o el importador con datos anonimizados.

## Notas / gotchas heredados de OrganiZate

- `providers.tf` usa `user_project_override=true` + `billing_project` (lo exige
  Identity Platform, si no da error de quota project).
- El bucket de Storage usa `bucket_location` (`EU`), no `eur3` (eso solo vale para
  Firestore).
- Al hacer ADC login puede salir un aviso benigno `Regional Access Boundary 404`;
  se ignora.
