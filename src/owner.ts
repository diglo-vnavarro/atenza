// Reconciliación PURA del histórico de PROPIEDAD (grupo/técnico) de un ticket. Detecta
// el cambio de dueño y cierra/abre segmentos. La usan la sync (reasignaciones de SDP en
// la convivencia) y el store (acciones nativas crear/asignar). Ver Fase 6.
import type { OwnerSegment } from './model.js';

export interface Owner { group?: string | null; tech?: string | null }

const sameOwner = (a: Owner, b: Owner): boolean =>
  (a.group ?? null) === (b.group ?? null) && (a.tech ?? null) === (b.tech ?? null);

/** Histórico actualizado tras observar el dueño actual `owner`:
 *  - sin histórico → siembra el primer segmento (desde `from`);
 *  - el dueño cambió respecto al segmento abierto → lo cierra en `at` y abre uno nuevo;
 *  - sin cambio → devuelve el histórico tal cual (misma referencia). */
export function reconcileOwner(history: OwnerSegment[] | undefined, owner: Owner, at: number, from: number): OwnerSegment[] {
  const hist = history ?? [];
  const o: Owner = { group: owner.group ?? null, tech: owner.tech ?? null };
  if (!hist.length) return [{ ...o, from, to: null }];
  const open = hist.find((h) => h.to == null);
  if (open && sameOwner(open, o)) return hist; // sin cambio de dueño
  return [...hist.map((h) => (h.to == null ? { ...h, to: at } : h)), { ...o, from: at, to: null }];
}
