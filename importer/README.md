# Importador SDP → Atenza (API v3)

Trae **metadatos reales** de ServiceDesk Plus Cloud (categorías, plantillas, SLAs, grupos, técnicos, solicitantes, prioridades, estados) y los transforma al modelo de Atenza, escribiendo `imported-seed.json`.

> **Qué NO trae:** la estructura interna de los ciclos de vida (estados/transiciones) — SDP la dibuja en un canvas y la v3 no la expone de forma fiable. Los **nombres** de flujo y sus plantillas sí se pueden listar; los internos se definen en el editor de Atenza o se piden a soporte de ManageEngine.

## 1. Conseguir un token OAuth (Zoho)

La API Cloud usa OAuth 2.0 de Zoho (no la sesión del navegador).

1. Entra en **Zoho API Console** del DC europeo: `https://api-console.zoho.eu` → crea un cliente **Self Client**.
2. Genera un **código** con estos scopes (solo lectura):
   ```
   SDPOnDemand.setup.READ,SDPOnDemand.requests.READ,SDPOnDemand.users.READ
   ```
3. Cámbialo por un **refresh/access token** en `https://accounts.zoho.eu/oauth/v2/token`.
4. El **access token** (dura ~1h) es lo que necesita el importador.

## 2. Ejecutar

```bash
cd organizate-ticketing
export SDP_OAUTH_TOKEN="1000.xxxxxxxx"          # access token de Zoho (DC .eu)
export SDP_BASE="https://digloitsm.sdpondemand.manageengine.eu/app/itdesk"   # instancia (portal)
# opcionales:
export SDP_INSTANCE_NAME="Diglo ITSM"
export SDP_CORP_DOMAIN="digloservicer.com"       # para marcar externos
npm run import
```

Genera `importer/imported-seed.json`.

## 3. Cargar en la app

Abre Atenza → **Administración → Catálogo → «Importar datos»** y pega el contenido de `imported-seed.json`. Reemplaza categorías, plantillas, SLAs, grupos y personas de la instancia activa por los importados.

## Notas y ajustes

- **Endpoints**: en `client.ts` (`ENDPOINTS`) están los nombres estándar v3 (`request_templates`, `categories`, `slas`, `groups`, `technicians`, `requesters`, `priorities`, `statuses`). Si tu instancia usa otro nombre, cámbialo ahí.
- **Cabecera Accept**: por defecto `application/vnd.manageengine.sdp.v3+json`; ajústala con `SDP_ACCEPT` si hace falta.
- **Paginación**: automática (`list_info`, 100/página).
- **Mappers**: en `map.ts`, testeados en `test/importer.test.ts` (`npm test`) — la transformación está verificada aunque la llamada de red dependa de tu token.
- **Tickets**: este importador trae *configuración*. Migrar tickets (histórico) es el paso ETL de la migración (colección `requests`), a añadir cuando toque el corte.
