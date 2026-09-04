# Clonar los datos de producción a `dv` (Firestore + adjuntos)

Deja `diglo-desk-dv` con una copia de la base de `diglo-desk-pd` (tenants, branding/iconos,
catálogos, tickets, informes…) para probar con datos reales. Requiere `gcloud` con permisos de
owner/editor en **ambos** proyectos.

> **Aviso.** Producción contiene datos personales (nombres, correos, asuntos de tickets). Al copiarlos
> a `dv` pasan a un entorno con menos control. `dv` solo es accesible para miembros de un tenant
> con cuenta en el Auth de `dv` (los usuarios de Auth **no** se copian, así que los externos no
> pueden entrar), pero sigue siendo una copia de datos reales: no la compartas ni la dejes crecer
> sin límite, y vuelve a borrarla cuando no haga falta (`firebase firestore:delete --all-collections`).

## 1. Bucket de exportación (en `dv`, una sola vez)

```bash
gcloud storage buckets create gs://diglo-desk-dv-firestore-import --project diglo-desk-dv --location EU --uniform-bucket-level-access
# el agente de Firestore de pd escribe la exportación; el de dv la lee al importar
# OJO: el export necesita también storage.buckets.get; objectAdmin solo no basta (PERMISSION_DENIED)
gcloud storage buckets add-iam-policy-binding gs://diglo-desk-dv-firestore-import --member=serviceAccount:service-557661475061@gcp-sa-firestore.iam.gserviceaccount.com --role=roles/storage.admin
gcloud storage buckets add-iam-policy-binding gs://diglo-desk-dv-firestore-import --member=serviceAccount:service-271576511236@gcp-sa-firestore.iam.gserviceaccount.com --role=roles/storage.objectViewer
```

## 2. Exportar producción (solo lectura sobre pd)

```bash
# (bash/Cloud Shell; en PowerShell escribe la fecha a mano)
gcloud firestore export gs://diglo-desk-dv-firestore-import/pd-$(date +%Y%m%d) --project diglo-desk-pd
```

Apunta la ruta que devuelve (`outputUriPrefix`).

## 3. Vaciar `dv` e importar

`dv` solo tiene el seed de demo; se borra para que no se mezcle con los datos reales.

```bash
npx firebase-tools firestore:delete --all-collections --project diglo-desk-dv --force
gcloud firestore import gs://diglo-desk-dv-firestore-import/pd-YYYYMMDD --project diglo-desk-dv
```

La importación no borra nada: sobrescribe documentos con el mismo id y añade el resto.

## 4. Índices

El CI de `dv` (`deploy-app.yml`) publica reglas **e índices** en cada push a `main`. Para publicarlos a mano:

```bash
npx firebase-tools deploy --only firestore:indexes --project dev
```

## 5. Recuperar tu acceso

Los miembros importados están keyed por los **uid de producción**, distintos de tu uid en el Auth de
`dv`. La function `autoProvisionOnRequest` lo resuelve por email: entra en https://diglo-desk-dv.web.app,
pulsa **Solicitar acceso** y en unos segundos tendrás la ficha bajo tu uid real (con `idmap`).
Para el superadmin de plataforma hace falta además:

```bash
GOOGLE_CLOUD_PROJECT=diglo-desk-dv npx tsx scripts/provision-access.ts        # revisa (dry-run)
GOOGLE_CLOUD_PROJECT=diglo-desk-dv APPLY=1 npx tsx scripts/provision-access.ts # unifica fichas y reasigna tickets
```

y crear `platformAdmins/<tu uid de dv>` (`{ email }`) si no existe (el bootstrap de demo ya lo creó;
la importación no lo toca porque en pd ese doc está bajo otro uid).

## 6. Adjuntos (opcional, ~8 GB)

Los iconos/branding de las instancias viven en Firestore (`tenants/{id}.branding`, data URI o URL) y
ya vienen con la exportación. El bucket `diglo-desk-pd-atenza-files` son los **adjuntos de tickets**
(8,1 GB). Copiarlos solo si hace falta probar adjuntos con datos reales:

```bash
gcloud storage rsync -r gs://diglo-desk-pd-atenza-files gs://diglo-desk-dv-atenza-files
```

## 7. Comprobar

```bash
GOOGLE_CLOUD_PROJECT=diglo-desk-pd npx tsx scripts/fs-counts.ts
GOOGLE_CLOUD_PROJECT=diglo-desk-dv npx tsx scripts/fs-counts.ts
```

Los recuentos por colección deben coincidir (salvo `accessRequests`/`idmap`, que cambian en dv).

## Refrescar la copia

Repetir 2 y 3 (con o sin el `firestore:delete` previo según se quiera partir de cero). Los Jobs de
sincronización no corren en `dv`, así que la copia no se actualiza sola.
