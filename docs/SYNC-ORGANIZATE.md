# Puente Atenza → OrganiZate (carga del técnico)

Refleja las **tareas** de los tickets de Atenza (de los grupos de soporte activados)
como **tareas** en OrganiZate, para que sumen a la **carga real** del técnico:
crear al asignar, cerrar al cerrar (deja de contar).

## Cómo funciona

- Config en Atenza: **Administración → Gobierno → Integración OrganiZate** activa,
  por **grupo de soporte**, qué tickets sincronizan sus tareas (`tenant.organizateGroupIds`).
  De momento solo el tenant **diglo-it**.
- Las tareas necesitan **horas estimadas** (se definen en la plantilla, pestaña
  «Tareas», o en el ticket). Sin horas, el puente asume `DEFAULT_TASK_HOURS` (1h).
- OrganiZate reparte su estado en **un documento por tipo de dato**:
  `orgs/{ORG_ID}/state/{clave}` (tasks, members, projects…), cada uno
  `{ payload: <JSON del array de ese tipo>, rev, version }`. El puente lee el shard
  `members` (identidad) y `tasks`, y **escribe SOLO el shard `tasks`** con una
  **transacción** (re-lee dentro de la transacción, conserva las tareas propias
  actuales y toca solo las suyas `sourceAtenzaTaskId`). Fallback: si aún no se hubiera
  migrado a shards, lee/escribe el doc legacy único `orgs/{ORG_ID}/state/app`
  (`{ payload: {state,version}, rev }`).
- Identidad: técnico de Atenza ↔ miembro de OrganiZate **por email**. Los que no
  casan se omiten (se registran en el log).

## Ejecución manual (requiere ADC con acceso de lectura/escritura a AMBOS proyectos)

```bash
# Previsualiza (solo lectura; muestra correspondencia de identidad y diff):
GOOGLE_APPLICATION_CREDENTIALS=<adc> TENANT=diglo-it npm run sync:organizate:dry

# Prueba contra grupos concretos sin tocar la config del tenant:
SYNC_GROUPS=<gid1>,<gid2> ... npm run sync:organizate:dry

# Aplica (escribe en OrganiZate):
GOOGLE_APPLICATION_CREDENTIALS=<adc> TENANT=diglo-it npm run sync:organizate
```

Variables: `ATENZA_PROJECT` (diglo-desk-pd), `ORGANIZATE_PROJECT` (diglo-organizate-pd),
`ORGANIZATE_ORG_ID` (diglo), `TENANT` (diglo-it), `DEFAULT_TASK_HOURS` (1), `SYNC_GROUPS`.

## Desatendido (Cloud Run Job + Scheduler)

Infra en `infra/terraform/sync_organizate_job.tf` (Cloud Run Job `sync-organizate`
+ Cloud Scheduler `atenza-sync-organizate`, cada 30 min). Reutiliza el Artifact
Registry `atenza` y la imagen del job de SDP (mismo contenedor, distinto comando).

Service account `atenza-organizate-sync` con `roles/datastore.user` en **ambos**
proyectos: `diglo-desk-pd` (lee Atenza) y `diglo-organizate-pd` (escribe OrganiZate,
acceso cruzado — el binding lo aplica el propietario de ese proyecto).

Pasos del propietario (una vez):
1. `terraform apply` (crea SAs, IAM en ambos proyectos, scheduler).
2. Desplegar el job con el comando del puente:
   ```
   gcloud run jobs deploy sync-organizate --region <REGION> \
     --image <REGION>-docker.pkg.dev/<PROJECT>/atenza/sync:latest \
     --command npm --args run,sync:organizate \
     --service-account atenza-organizate-sync@<PROJECT>.iam.gserviceaccount.com \
     --set-env-vars TENANT=diglo-it,ATENZA_PROJECT=<PROJECT>,ORGANIZATE_PROJECT=diglo-organizate-pd,ORGANIZATE_ORG_ID=diglo,DEFAULT_TASK_HOURS=1 \
     --max-retries 1 --task-timeout 300s
   ```

## Concurrencia (resuelta por el modelo sharded)

Antes, con el doc único, un cliente con estado previo podía revertir la tarea-puente
al guardar el blob completo. Desde que OrganiZate **reparte el estado por tipo de
dato** (commit «repartir el estado en un documento por tipo de dato»), el puente
escribe **solo el shard `tasks`**, aislado del resto (calendario, sugerencias…). La
transacción re-lee el shard y conserva las tareas propias; y el propio OrganiZate,
si detecta cambio de `rev` al escribir, **fusiona en 3 vías** en vez de pisar, así
que las tareas del puente se conservan. El job periódico sigue convergiendo. La
carrera queda reducida a «dos escrituras del shard tasks a la vez», absorbida por
la transacción + reintentos.

## Notas / límites

- Mapeo de prioridad Atenza→OrganiZate: Crítica/Alta→high, Baja→low, resto→medium.
- Estado de tarea: `done` si la tarea está hecha o el ticket está cerrado/resuelto.
- `projectId: null` (v1): las tareas del puente no se agrupan en un proyecto de
  OrganiZate; cuentan igual para la carga. Se puede asignar un proyecto dedicado.
- Fechas: inicio = creación del ticket (o hoy); fin = vencimiento de la tarea (o hoy).
