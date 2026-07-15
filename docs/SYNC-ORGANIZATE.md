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
- OrganiZate guarda TODO su estado en un único doc `orgs/{ORG_ID}/state/app`
  (`{ payload: <zustand-persist: {state, version}>, rev }`) con concurrencia por `rev`.
  El puente escribe con **transacción** (guardia por rev, reintentos) y toca **solo**
  las tareas que él crea (marcadas `sourceAtenzaTaskId`); nunca las del equipo.
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

## Desatendido (pendiente de infra)

Cloud Run Job + Cloud Scheduler (mismo patrón que la sync de SDP), con una service
account con `roles/datastore.user` en **diglo-organizate-pd** (acceso cruzado) además
de lectura en diglo-desk-pd. Terraform pendiente de aplicar por el propietario.

## Notas / límites

- Mapeo de prioridad Atenza→OrganiZate: Crítica/Alta→high, Baja→low, resto→medium.
- Estado de tarea: `done` si la tarea está hecha o el ticket está cerrado/resuelto.
- `projectId: null` (v1): las tareas del puente no se agrupan en un proyecto de
  OrganiZate; cuentan igual para la carga. Se puede asignar un proyecto dedicado.
- Fechas: inicio = creación del ticket (o hoy); fin = vencimiento de la tarea (o hoy).
