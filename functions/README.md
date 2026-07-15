# Atenza Cloud Functions — auto-onboarding

`autoOnboard` es un **trigger de autenticación bloqueante** (`beforeUserSignedIn`,
firebase-functions v2 / `firebase-functions/v2/identity`). Se dispara justo antes de
completar cada inicio de sesión (Google/email) y, si el email del usuario coincide con
la ficha de un miembro ya existente en algún tenant, le concede acceso automáticamente
escribiendo `userTenants/{uid}`. No hace auto-alta de emails que no coincidan con ningún
miembro (no hay autoservicio abierto). La unificación/dedup pesada (reasignar tickets,
borrar fichas viejas) la sigue haciendo `scripts/provision-access.ts`.

## Requisitos previos

- **Plan Blaze (pago por uso).** Las funciones de 2ª generación (todas las blocking
  functions lo son) requieren facturación Blaze.
- **Identity Platform habilitado** en el proyecto (ya lo está en `diglo-desk-pd`). Las
  blocking functions se **auto-registran** con Identity Platform al desplegar; no hay que
  configurar el trigger a mano.
- **APIs de Google Cloud habilitadas** (el primer deploy las suele activar solo; si falla,
  habilítalas a mano):
  - Cloud Functions (`cloudfunctions.googleapis.com`)
  - Cloud Build (`cloudbuild.googleapis.com`)
  - Artifact Registry (`artifactregistry.googleapis.com`)
  - Eventarc (`eventarc.googleapis.com`)
  - Cloud Run (`run.googleapis.com`) — las gen2 corren sobre Cloud Run
  - Identity Toolkit (`identitytoolkit.googleapis.com`)

## Compilar

```bash
cd functions
npm install
npm run build      # tsc → functions/lib
```

## Desplegar la función

Desde la **raíz del repo** (no desde `functions/`):

```bash
GOOGLE_CLOUD_QUOTA_PROJECT=diglo-desk-pd npx firebase-tools deploy --only functions --project diglo-desk-pd
```

El `predeploy` de `firebase.json` ejecuta `npm run build` automáticamente antes de subir.

## Desplegar el índice de Firestore

La consulta `collectionGroup('members').where('email','==', …)` necesita un índice
single-field de **alcance COLLECTION_GROUP** sobre `email` (ya declarado en
`firestore.indexes.json` → `fieldOverrides`). Despliégalo con:

```bash
npx firebase-tools deploy --only firestore:indexes --project diglo-desk-pd
```

> El índice tarda un rato en construirse. Hasta que esté `Enabled`, la función no podrá
> resolver la consulta (la registra en logs y permite el inicio de sesión sin provisionar).
