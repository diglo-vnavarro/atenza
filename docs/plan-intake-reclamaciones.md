# Plan — Intake web de Reclamaciones (L1)

> Estado: **planificado, pendiente de decisiones de negocio.** Retomar la semana del
> **2026-09-01** (cuando negocio vuelva de vacaciones). Redactado 2026-08-28.

## Objetivo
Que un cliente abra una reclamación desde la **web pública** y entre como **ticket en Atenza**
(`diglo-it`), clasificado a su cola de Reclamaciones y con **confirmación al cliente**.

## Lo que YA existe (no hay que construirlo)
- Las **12 colas** de Reclamaciones en el árbol v3 + grupos «Técnicos Reclamaciones X» +
  ciclo **RLC-Incidencias** (todo cableado en Sprint 2).
- **Patrón de intake externo** ya montado: `src/inbound.ts` (`parseInbound`) +
  `store.createFromEmail` + flag `inboundEnabled` + admin «Correo entrante → ticket». El web es
  **análogo** (otro transporte, misma ingesta).
- **Cloud Functions** (`functions/`, región europe-west1: `autoProvisionOnRequest`,
  `adminProvisionAccess`) + `firestore.rules` que **bloquean la escritura pública** de tickets →
  el intake entra por una **Cloud Function con admin SDK** (no cliente directo).
- **Extensión de correo saliente** (`firestore-send-email`) para las confirmaciones.

## Arquitectura (flujo)
`Cliente (web)` → `Formulario` → POST → **`Cloud Function HTTPS`** (valida + antispam) →
**crea ticket** (admin SDK) en `tenants/diglo-it` → aparece en la **bandeja** (cola correcta) +
**email de confirmación** al cliente.

## Componentes
| # | Componente | Detalle |
|---|---|---|
| 1 | Formulario web | tipo de reclamación · nombre · email · teléfono · referencia/contrato · descripción · adjuntos · consentimiento RGPD. Público. |
| 2 | Endpoint (`reclamacionesIntake`, onRequest, europe-west1) | recibe POST, valida, antispam, crea el ticket vía admin SDK. |
| 3 | Mapeo → ticket | tipo → subcategoría (cola) + `groupId` (ya cableado) · datos cliente → campos + `notifyEmails` · `requester = «web»`. |
| 4 | Seguridad | reCAPTCHA v3 / App Check + rate-limit + honeypot + validación + CORS al dominio del cliente. |
| 5 | Notificaciones | confirmación al cliente (nº de ticket) + aviso al equipo (`notifRules`). |
| 6 | Adjuntos | subida a Storage (ligado a **M1**). Opcional en v1. |

## Fases (estimación orientativa)
- **F1 (MVP)** ~2-3 días: función + form básico (tipo + contacto + descripción) + creación de
  ticket + email de confirmación. **Sin adjuntos.**
- **F2** ~+2-3 días: adjuntos (Storage) + reCAPTCHA robusto + triage/validación fina.
- **F3 (opcional, aparte)**: portal de **seguimiento sin login** (el cliente consulta estado con
  nº + email).

## Decisiones de negocio PENDIENTES (para acotar F1)
1. **¿Dónde vive el formulario?** ¿Lo integra Diglo en su web pública, o Atenza hostea una página
   (link/iframe)?
2. **Identidad del cliente** (no es miembro de Atenza): ¿ticket con «solicitante web» + contacto en
   campos *(recomendado)*, o buscar/crear contacto por email?
3. **Elección de cola**: ¿el cliente elige el tipo (12 colas) en el form, o entra a una cola de
   **triage** y se reasigna? *(recomendado: desplegable con las 12 + «No sé» → triage)*
4. **Adjuntos**: ¿en F1 o los dejamos para F2?
5. **Anti-abuso**: reCAPTCHA v3 *(recomendado; necesita clave de Google)*.
6. **RGPD**: textos de consentimiento y base legal (los aporta legal).

## Riesgos
Spam/abuso (form público) · RGPD/datos personales · que el cliente elija mal la cola (→ triage
manual como red) · spoofing de identidad del cliente.
