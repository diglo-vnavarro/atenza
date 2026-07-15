import { describe, it, expect } from 'vitest';
import { computeMadridHolidays, madridHolidayDates, easterSunday } from '../src/holidays.js';

describe('festivos de Madrid', () => {
  it('calcula la Pascua correctamente (Meeus)', () => {
    // Domingos de Pascua conocidos (componentes LOCALES, sin desfase de zona horaria).
    const local = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    expect(local(easterSunday(2026))).toBe('2026-04-05');
    expect(local(easterSunday(2025))).toBe('2025-04-20');
  });

  it('incluye Jueves y Viernes Santo derivados de la Pascua', () => {
    const dates = computeMadridHolidays(2026).map((h) => h.date);
    expect(dates).toContain('2026-04-02'); // Jueves Santo
    expect(dates).toContain('2026-04-03'); // Viernes Santo
  });

  it('incluye fijos nacionales + Comunidad + capital de Madrid', () => {
    const dates = computeMadridHolidays(2026).map((h) => h.date);
    for (const d of ['2026-01-01', '2026-01-06', '2026-05-01', '2026-05-02', '2026-05-15', '2026-10-12', '2026-11-09', '2026-12-25']) {
      expect(dates).toContain(d);
    }
  });

  it('devuelve fechas únicas y ordenadas para varios años', () => {
    const list = madridHolidayDates([2025, 2026]);
    expect(list.length).toBe(new Set(list).size); // sin duplicados
    expect([...list]).toEqual([...list].sort()); // ordenadas
    expect(list.some((d) => d.startsWith('2025'))).toBe(true);
    expect(list.some((d) => d.startsWith('2026'))).toBe(true);
  });
});
