import { describe, it, expect } from 'vitest';
import { businessMsBetween, type BusinessCalendar } from '../src/sla.js';

const H = 3600_000;
const cal: BusinessCalendar = { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00', holidays: [] };
// fechas locales; 2026-01-05 = lunes, 09 = viernes, 12 = lunes siguiente
const at = (d: number, h: number, m = 0) => new Date(2026, 0, d, h, m).getTime();

describe('SLA por horario laboral (businessMsBetween)', () => {
  it('cuenta solo la franja dentro de un día laborable', () => {
    expect(businessMsBetween(at(5, 10), at(5, 12), cal)).toBe(2 * H); // lun 10-12
  });
  it('recorta las horas fuera de la franja', () => {
    expect(businessMsBetween(at(5, 17), at(5, 20), cal)).toBe(1 * H); // 17-18 (no 18-20)
    expect(businessMsBetween(at(5, 6), at(5, 10), cal)).toBe(1 * H);  // 9-10 (no 6-9)
  });
  it('salta fines de semana', () => {
    // viernes 17:00 → lunes 10:00 = 1h (vie 17-18) + 1h (lun 9-10)
    expect(businessMsBetween(at(9, 17), at(12, 10), cal)).toBe(2 * H);
  });
  it('excluye festivos', () => {
    const withHol: BusinessCalendar = { ...cal, holidays: ['2026-01-06'] }; // martes festivo
    // lun 17:00 → mié 10:00: lun 17-18 (1h) + [mar festivo, 0] + mié 9-10 (1h) = 2h
    expect(businessMsBetween(at(5, 17), at(7, 10), withHol)).toBe(2 * H);
  });
  it('un día completo laborable = 9h (09-18)', () => {
    expect(businessMsBetween(at(5, 0), at(5, 23, 59), cal)).toBe(9 * H);
  });
});
