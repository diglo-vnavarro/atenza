# ticketIN · Flujo Git y promoción entre entornos

## Propósito

Este documento define cómo se trabaja en el repositorio y cómo se mueven los cambios entre
entornos. Es la **misma convención que el resto de repositorios Diglosfera/HUB360**
(`hub360-platform/docs/git-workflow.md`, con la misma adaptación que `OrganiZate/docs/git-workflow.md`),
ajustada a que ticketIN tiene **dos entornos**: `dv` (desarrollo) y `pd` (producción). No hay `stg`.

El objetivo es evitar la deriva manual entre entornos y que `dv` y `pd` sean reproducibles.

## Modelo de ramas

| Rama | Entorno | Propósito |
| --- | --- | --- |
| `main` | `dv` | Rama integrada de desarrollo. Cada cambio mergeado despliega a desarrollo (`deploy-app.yml`). |
| `release/pd` | `pd` | Rama de promoción a producción. Solo recibe cambios ya validados en `dv`, por fast-forward desde `main` (`deploy-app-pd.yml`; y `deploy-sync.yml` para el Job de la sync). |

No se trabaja directamente sobre las ramas de entorno. Cada cambio va en una rama corta.

| Entorno | Proyecto GCP | URL |
| --- | --- | --- |
| `dv` | `diglo-desk-dv` | https://diglo-desk-dv.web.app (sin datos; solo entra quien sea miembro de un tenant, ver infra/README.md §5) |
| `pd` | `diglo-desk-pd` | https://diglo-desk-pd.web.app |

## Flujo diario

Parte siempre del último `main`:

```bash
git switch main
git pull --ff-only origin main
git switch -c feature/mi-cambio
```

Haz el cambio, valídalo y commitea:

```bash
git add .
git commit -m "feat: describe el cambio"
git push -u origin feature/mi-cambio
```

Abre un Pull Request hacia `main`. La CI (`ci.yml`: typecheck + tests + build + functions) debe pasar.

## Nombres de rama

| Prefijo | Uso |
| --- | --- |
| `feature/...` | Nueva capacidad o mejora visible |
| `fix/...` | Corrección de un error |
| `chore/...` | Mantenimiento, docs, CI, refactor sin cambio de comportamiento |
| `hotfix/...` | Corrección urgente que puede necesitar promoción rápida |

Nada de ramas permanentes por persona: una rama representa un cambio, no a alguien.

## Reglas de Pull Request

Antes de mergear a `main`:

- Actualiza desde `main` si la rama está desfasada.
- Ejecuta las comprobaciones locales cuando sea práctico (`npm run lint && npm test && npm run build`;
  `lint` es el typecheck de TypeScript, el repo no tiene ESLint).
- PRs pequeñas y revisables; un cambio lógico por PR.
- Nada de ediciones manuales específicas de un entorno que no sean reproducibles.
- Nunca valores secretos reales en commits (tokens de Zoho, ADC, `.env.local`, `*.local`).

`main` debe estar siempre desplegable en `dv`.

## Promoción a producción (`pd`)

Promociona **solo** cuando el cambio esté validado en `dv`.

```bash
git fetch origin
# 1) Punto de retorno: etiqueta el estado actual de producción
git tag rollback/release-pd-$(date +%Y%m%d) origin/release/pd
git push origin rollback/release-pd-$(date +%Y%m%d)
# 2) Promoción por fast-forward
git switch release/pd
git pull --ff-only origin release/pd
git merge --ff-only origin/main
git push origin release/pd
```

Si `--ff-only` falla, **para e investiga**: la rama ha divergido. No hagas `--force` como parte de
una promoción normal. El push a `release/pd` dispara el despliegue a producción (hosting + reglas;
y el Job de la sync si cambiaron `Dockerfile`/`scripts`/`importer`/`src` y `CI_DEPLOY_SYNC=true`).

Tras desplegar, valida en https://diglo-desk-pd.web.app (acceso, bandeja, crear/asignar un ticket,
informes) y, si hubo cambios en la sync, la siguiente ejecución del Job `sync-sdp`
(`docs/deploy-sync.md`).

### Rollback

- Rápido: `git switch release/pd && git reset --hard rollback/release-pd-<fecha> && git push --force-with-lease origin release/pd`
  (redespliega el estado anterior), o lanza `Deploy app (pd)` por `workflow_dispatch` sobre la rama.
- Después, corrige en `main` y vuelve a promocionar. Nunca arregles directamente en `release/pd`.

## Reglas de la rama de release

`release/pd` es una rama de **despliegue**, no de desarrollo. Solo avanza por fast-forward desde `main`.

- **Sin commits directos, cherry-picks ni merges en `release/pd`.** Todo llega a producción pasando
  primero por `main`. Un arreglo aplicado directamente en la rama de release es invisible para `main`
  y rompe la cadena de fast-forward.
- **La promoción es siempre `--ff-only`.**
- **Los valores por entorno no viven en commits de rama.** Lo que difiere entre `dv` y `pd`
  (proyecto, bucket, URLs) está parametrizado: secrets del entorno de GitHub
  (`development` / `production`), `.firebaserc` (alias `dev`/`prod` y deploy targets `app` /
  `attachments`) y Terraform (`dev.tfvars` / `terraform.tfvars`). Los scripts operativos toman el
  proyecto de `GOOGLE_CLOUD_PROJECT` (por defecto, producción).
- **Protección de rama** en `main` y `release/pd`: exigir los checks de `CI`, historia lineal y
  prohibir force-push y borrado. Los administradores del repo pueden hacer push directo; el resto,
  por PR. *(Implementado con rulesets de GitHub; se conserva al pasar el repo a la organización
  `Digloservicer`, donde debería vivir como el resto.)*

### Si la rama de release ha divergido

Reconciliar de vuelta al modelo fast-forward, en una ventana controlada:

1. Etiqueta el HEAD actual para rollback: `git tag rollback/release-pd-<fecha> origin/release/pd` y súbelo.
2. Back-portea a `main` lo que viva **solo** en `release/pd` y deba conservarse
   (`git cherry -v origin/main origin/release/pd`).
3. Cuando `main` sea superconjunto, resetea la rama de release a `main` y valida:

   ```bash
   git fetch origin
   git switch release/pd
   git reset --hard origin/main
   git push --force-with-lease origin release/pd
   ```

`--force-with-lease` aquí es una reconciliación deliberada y puntual, no parte de la promoción normal.

## Infraestructura y secretos

La infraestructura y los prerrequisitos de entorno deben ser reproducibles (Terraform en
`infra/terraform`, un módulo para los dos proyectos). Ver `infra/README.md`.

- Cloud Functions: en `dv` se despliegan con la app (`deploy-app.yml`). En `pd` siguen
  desplegándose a mano (`firebase deploy --only functions --project prod`) hasta ampliar los roles
  de la SA de deploy de producción (ver infra/README.md §4).
- La extensión `firestore-send-email` (correo) solo existe en `pd` y **nunca** se despliega desde CI
  ni con `--non-interactive --force`. En `dv` no se instala: los correos encolados en `mail` no salen.
- Los secretos de runtime (Zoho/SDP) viven en Secret Manager de cada proyecto, no en secrets de
  GitHub. Los secrets de GitHub solo llevan configuración pública de build (`VITE_*`) e identidades
  de despliegue (WIF).
- Los Jobs de sincronización (`sync-sdp`, `sync-organizate`, `sync-leasys`) solo corren en `pd`:
  en `dv` Terraform no crea los Schedulers (`enable_sync_jobs = false`).

## Higiene del repositorio local

Antes de empezar:

```bash
git status
git fetch origin
git pull --ff-only origin main
```

Con cambios locales que aún no deben commitearse:

```bash
git stash push -u -m "por qué existe este stash"
git stash list
```

No dejes cambios locales desconocidos en `main` antes de promocionar o desplegar. Si hay otro
agente o persona trabajando sobre el mismo checkout, usa un worktree (`git worktree add`).

## Resumen del flujo

1. Rama corta desde `main` → PR → CI en verde → merge → **se despliega a `dv` solo**.
2. Validar en `dv`.
3. Tag de rollback + fast-forward `main` → `release/pd` → **se despliega a `pd` solo**.
4. Validar en `pd`.
