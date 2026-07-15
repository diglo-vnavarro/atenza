// Festivos de España + Comunidad de Madrid + Madrid capital.
// Cálculo LOCAL puro y determinista (sin red), portado de OrganiZate
// (src/lib/holidays.ts) para alimentar los festivos del SLA. Madrid como referencia.
// Alimenta tenant.holidays (fechas ISO) que el motor de SLA usa para no contar
// noches/fines de semana/festivos.

export interface PublicHoliday { date: string; name: string } // date = yyyy-MM-dd

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/** Domingo de Pascua (algoritmo de Meeus/Butcher, calendario gregoriano). */
export function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

/** Festivos locales de Madrid capital (San Isidro, La Almudena). */
export function madridCityHolidays(year: number): PublicHoliday[] {
  return [
    { date: iso(year, 5, 15), name: 'San Isidro (Madrid capital)' },
    { date: iso(year, 11, 9), name: 'La Almudena (Madrid capital)' },
  ];
}

/** Festivos nacionales de España + Comunidad de Madrid + locales de Madrid capital. */
export function computeMadridHolidays(year: number): PublicHoliday[] {
  const easter = easterSunday(year);
  const offset = (days: number) => {
    const d = new Date(easter);
    d.setDate(d.getDate() + days);
    return iso(d.getFullYear(), d.getMonth() + 1, d.getDate());
  };
  return [
    { date: iso(year, 1, 1), name: 'Año Nuevo' },
    { date: iso(year, 1, 6), name: 'Epifanía del Señor (Reyes)' },
    { date: offset(-3), name: 'Jueves Santo' },
    { date: offset(-2), name: 'Viernes Santo' },
    { date: iso(year, 5, 1), name: 'Fiesta del Trabajo' },
    { date: iso(year, 5, 2), name: 'Día de la Comunidad de Madrid' },
    { date: iso(year, 8, 15), name: 'Asunción de la Virgen' },
    { date: iso(year, 10, 12), name: 'Fiesta Nacional de España' },
    { date: iso(year, 11, 1), name: 'Todos los Santos' },
    { date: iso(year, 12, 6), name: 'Día de la Constitución' },
    { date: iso(year, 12, 8), name: 'Inmaculada Concepción' },
    { date: iso(year, 12, 25), name: 'Navidad' },
    ...madridCityHolidays(year),
  ].sort((a, b) => a.date.localeCompare(b.date));
}

/** Solo las fechas ISO de los festivos de Madrid para una lista de años (para tenant.holidays). */
export function madridHolidayDates(years: number[]): string[] {
  return [...new Set(years.flatMap((y) => computeMadridHolidays(y).map((h) => h.date)))].sort();
}
