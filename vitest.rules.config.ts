import { defineConfig } from 'vitest/config';

// Config aparte para el test de emulador: se ejecuta solo bajo `npm run test:rules`
// (dentro de firebase emulators:exec) y no en el `npm test` por defecto.
export default defineConfig({
  test: {
    include: ['test/rules.emulator.ts'],
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
