// Test END-TO-END contra las reglas reales (firestore.rules) usando el
// emulador de Firestore. REQUIERE Java (JRE) + emulador arrancado.
//
//   npm run test:rules
//
// (arranca el emulador con firebase-tools y ejecuta este fichero dentro).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { beforeAll, afterAll, beforeEach, describe, it } from 'vitest';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc } from 'firebase/firestore';

const here = dirname(fileURLToPath(import.meta.url));
const rules = readFileSync(join(here, '..', 'firestore.rules'), 'utf8');

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'organizate-ticketing-test',
    firestore: { rules },
  });
});

afterAll(async () => { await env?.cleanup(); });

beforeEach(async () => {
  // Sembramos con permisos de administrador (saltándose las reglas).
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'tenants/diglo-it/members/u-tech-it'),
      { role: 'technician', status: 'active', email: 't@diglo.com', external: false });
    await setDoc(doc(db, 'tenants/diglo-it/members/u-req-1'),
      { role: 'requester', status: 'active', email: 'r1@diglo.com', external: false });
    await setDoc(doc(db, 'tenants/diglo-it/tickets/t1'),
      { type: 'incident', subject: 'x', requesterId: 'u-req-1', technicianId: null });
    // tenant del cliente externo
    await setDoc(doc(db, 'tenants/leasys/members/u-tech-leasys'),
      { role: 'technician', status: 'active', email: 'ext@leasys.com', external: true });
  });
});

const ctxOf = (uid: string) => env.authenticatedContext(uid).firestore();

describe('reglas reales · aislamiento entre tenants', () => {
  it('técnico de IT NO lee un ticket de IT de otro… sí (es técnico), pero NO entra en Leasys', async () => {
    await assertSucceeds(getDoc(doc(ctxOf('u-tech-it'), 'tenants/diglo-it/tickets/t1')));
    await assertFails(getDoc(doc(ctxOf('u-tech-it'), 'tenants/leasys/members/u-tech-leasys')));
  });

  it('el solicitante solo ve su propio ticket', async () => {
    await assertSucceeds(getDoc(doc(ctxOf('u-req-1'), 'tenants/diglo-it/tickets/t1')));
  });

  it('un extraño no lee nada', async () => {
    await assertFails(getDoc(doc(ctxOf('u-outsider'), 'tenants/diglo-it/tickets/t1')));
  });

  it('técnico externo (dominio ajeno) SÍ opera en su tenant', async () => {
    await assertSucceeds(getDoc(doc(ctxOf('u-tech-leasys'), 'tenants/leasys/members/u-tech-leasys')));
    await assertFails(getDoc(doc(ctxOf('u-tech-leasys'), 'tenants/diglo-it/tickets/t1')));
  });
});
