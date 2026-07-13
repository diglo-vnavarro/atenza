# OrganiZate Ticketing — prototipo del cimiento multi-tenant

Valida la parte que hay que probar **antes** de decidir construir el ITSM propio:
que el aislamiento entre clientes y los roles (técnico / solicitante) se sostienen,
y que las **identidades externas al dominio** funcionan sin el candado corporativo de OrganiZate.

No es la app: es el esqueleto de seguridad y datos.

## Qué hay aquí

| Fichero | Qué es |
|---|---|
| `firestore.rules` | **Reglas de aislamiento reales** (frontera de seguridad de producción). |
| `src/model.ts` | Tipos del modelo de datos multi-tenant. |
| `src/access.ts` | La misma lógica de autorización, en TS, como funciones legibles y testeables. |
| `src/lifecycle.ts` | Ciclos de vida configurables por tipología (máquina de estados, transiciones). |
| `src/sla.ts` | Motor de SLA que **solo cuenta el tiempo de los estados que consumen** (pausa en "En espera"). |
| `test/access.test.ts` · `test/lifecycle.test.ts` | Matriz de permisos + ciclos de vida y SLA — **corren sin Java** (`npm test`). |
| `test/rules.emulator.ts` | Test end-to-end contra `firestore.rules` — **requiere Java + emulador**. |

## Modelo de datos

```
tenants/{tenantId}                 un "ITSM" por cliente (= instancia de Zoho)
  ├─ members/{uid}                 pertenencia + rol EN ESTE tenant
  ├─ tickets/{ticketId}
  │    ├─ conversations/  worklog/  attachments/
  ├─ catalog/  slas/  workflows/  groups/  approvals/
userTenants/{uid}                  índice de tenants por usuario (Cloud Function)
platformAdmins/{uid}               superadmin de Diglo
```

**Regla de oro:** todo cuelga de `tenants/{tenantId}` y el acceso se decide por la
**pertenencia** a ese tenant y el **rol** en él. No se mira el dominio del correo — por eso
un técnico o cliente externo funciona igual que uno interno. Esa es la diferencia estructural
con OrganiZate (que bloquea todo lo que no sea `@digloservicer.com`).

## Probarlo

### Tests puros de la matriz de permisos (sin Java — funciona ya)
```bash
npm install
npm test
```

### Test contra las reglas reales (requiere Java 11+ y firebase-tools)
En una máquina con JRE instalado:
```bash
npm install
npm run test:rules      # arranca el emulador de Firestore y ejecuta rules.emulator.ts
```

## Limitaciones conocidas (a propósito, documentadas)

- **Listado de tickets del solicitante**: las reglas de Firestore no pueden inspeccionar el
  filtro de una consulta `list`, así que el listado libre queda para técnico/admin. El
  solicitante recupera "sus" tickets mediante una consulta acotada validada en Cloud Function
  o un índice por usuario. Ver comentario en `firestore.rules`.
- `src/access.ts` debe mantenerse **alineado** con `firestore.rules`; el test de emulador es
  quien confirma que el fichero de reglas implementa fielmente la matriz.

## Siguiente paso sugerido

Con el cimiento validado: definir el **motor de SLA** (Cloud Function programada) y el
**puente de migración** (webhook Zoho → Function → reflejo de solo lectura).
