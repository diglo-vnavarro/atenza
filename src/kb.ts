// Base de conocimiento (Soluciones, como SDP): artículos con categoría, estado
// borrador/publicado y búsqueda. Búsqueda pura y testeable; el CRUD vive en el store.
export type KbStatus = 'draft' | 'published';

export interface KbArticle {
  id: string;
  title: string;
  body: string;
  category?: string;
  tags?: string[];
  status: KbStatus;
  authorName: string;
  createdAt: number;
  updatedAt: number;
  views?: number;
}

/**
 * Filtra por texto (título/cuerpo/tags/categoría) y opcionalmente por estado.
 * `staff=false` (solicitante) → solo publicados. Ordena publicados antes que
 * borradores y, dentro, por relevancia simple (coincidencia en título pesa más).
 */
export function searchKb(articles: KbArticle[] | undefined, query: string, staff = false): KbArticle[] {
  const q = query.trim().toLowerCase();
  const pool = (articles ?? []).filter((a) => staff || a.status === 'published');
  const scored = pool
    .map((a) => ({ a, score: q ? matchScore(a, q) : 1 }))
    .filter((x) => x.score > 0);
  scored.sort((x, y) => {
    const pub = Number(y.a.status === 'published') - Number(x.a.status === 'published');
    if (pub) return pub;
    if (y.score !== x.score) return y.score - x.score;
    return y.a.updatedAt - x.a.updatedAt;
  });
  return scored.map((x) => x.a);
}

function matchScore(a: KbArticle, q: string): number {
  let s = 0;
  if (a.title.toLowerCase().includes(q)) s += 3;
  if ((a.category ?? '').toLowerCase().includes(q)) s += 2;
  if ((a.tags ?? []).some((t) => t.toLowerCase().includes(q))) s += 2;
  if (a.body.toLowerCase().includes(q)) s += 1;
  return s;
}
