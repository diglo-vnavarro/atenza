import { describe, it, expect } from 'vitest';
import { classifyToV3, resolveElementByName, isUnclassified, SIN_CLASIFICAR } from '../src/data/classification-map.js';

describe('classifyToV3', () => {
  it('mapea por plantilla', () => {
    expect(classifyToV3({ template: 'Plantilla Reclamación' })).toMatchObject({ area: 'ar-neg', service: 'sv-reclam' });
    expect(classifyToV3({ template: 'LIQUIDACIONES INFORMATIVAS DE DEUDA' })).toMatchObject({ area: 'ar-ops', service: 'sv-liq' });
    expect(classifyToV3({ template: 'Solicitudes Gemini' })).toMatchObject({ area: 'ar-it', service: 'sv-gemini' });
  });

  it('la plantilla tiene prioridad sobre la categoría de servicio', () => {
    // plantilla → BI aunque la SC diga otra cosa
    expect(classifyToV3({ template: 'Peticion ITSM BI', serviceCategory: 'AI - Gemini' }))
      .toMatchObject({ area: 'ar-bi', service: 'sv-itsmbi' });
  });

  it('cae a la categoría de servicio si la plantilla no está mapeada', () => {
    expect(classifyToV3({ template: 'Plantilla desconocida', serviceCategory: 'AI - Gemini' }))
      .toMatchObject({ area: 'ar-it', service: 'sv-gemini' });
  });

  it('fallback «Sin clasificar» si nada casa', () => {
    const r = classifyToV3({ template: 'Formulario Incidencia DEFAULT NO USAR' });
    expect(r).toMatchObject(SIN_CLASIFICAR);
    expect(isUnclassified(r)).toBe(true);
  });

  it('resuelve el elemento (N3) desde el item', () => {
    expect(classifyToV3({ template: 'Plantilla Incidencia', item: 'Gmail' }).element).toBe('el-gmail');
    // match por inclusión: «SharePoint Diglo» → el-sharepoint
    expect(classifyToV3({ template: 'Plantilla Incidencia', item: 'SharePoint Diglo' }).element).toBe('el-sharepoint');
    expect(classifyToV3({ template: 'Plantilla Incidencia', item: 'Outlook / Correo electrónico' }).element).toBe('el-outlook');
  });

  it('item sin correspondencia → sin elemento', () => {
    expect(classifyToV3({ template: 'Plantilla Incidencia', item: 'AppInexistente' }).element).toBeUndefined();
    expect(classifyToV3({ template: 'Plantilla Incidencia' }).element).toBeUndefined();
  });

  it('no resuelve elemento para «Sin clasificar»', () => {
    expect(classifyToV3({ template: 'NO USAR', item: 'Gmail' }).element).toBeUndefined();
  });
});

describe('resolveElementByName', () => {
  it('servicio sin elementos → undefined', () => {
    expect(resolveElementByName('sv-pet', 'Gmail')).toBeUndefined();
  });
});
