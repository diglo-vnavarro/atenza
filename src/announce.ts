// Anuncios: avisos globales del tenant a técnicos y/o solicitantes (banner).
// Selección pura y testeable; el CRUD vive en el store.
export type Audience = 'all' | 'staff' | 'requesters';

export interface Announcement {
  id: string;
  title: string;
  body: string;
  audience: Audience;
  authorName: string;
  at: number;
}

/** Anuncios visibles para el espectador (según su audiencia), más recientes primero. */
export function visibleAnnouncements(list: Announcement[] | undefined, isStaff: boolean): Announcement[] {
  return (list ?? [])
    .filter((a) => a.audience === 'all' || (isStaff ? a.audience === 'staff' : a.audience === 'requesters'))
    .sort((x, y) => y.at - x.at);
}
