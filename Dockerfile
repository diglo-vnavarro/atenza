# Imagen del Cloud Run Job de sincronización SDP → Atenza.
# Corre `npm run sync:job` = ETL de tickets activos de SDP + merge idempotente a
# Firestore (preservando lo añadido en Atenza). Sin estado; se dispara por Scheduler.
#
# Credenciales:
#   - Firestore: ADC de la service account del job (automático en Cloud Run).
#   - Zoho/SDP: ZOHO_REFRESH_TOKEN/ZOHO_CLIENT_ID/ZOHO_CLIENT_SECRET desde
#     Secret Manager (montados como env). El access token se refresca al arrancar.
FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json ./
# npm ci con devDeps: el job corre con tsx (TypeScript en runtime) y firebase-admin.
RUN npm ci --include=dev
COPY tsconfig.json ./
COPY src ./src
COPY importer ./importer
COPY scripts ./scripts
CMD ["npm", "run", "sync:job"]
