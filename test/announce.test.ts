import { describe, it, expect } from 'vitest';
import { visibleAnnouncements, type Announcement } from '../src/announce.js';

const A = (over: Partial<Announcement>): Announcement => ({ id: 'a', title: 't', body: 'b', audience: 'all', authorName: 'x', at: 1, ...over });

const list: Announcement[] = [
  A({ id: 'all', audience: 'all', at: 10 }),
  A({ id: 'staff', audience: 'staff', at: 30 }),
  A({ id: 'req', audience: 'requesters', at: 20 }),
];

describe('visibleAnnouncements', () => {
  it('staff ve all + staff, más recientes primero', () => {
    expect(visibleAnnouncements(list, true).map((a) => a.id)).toEqual(['staff', 'all']);
  });
  it('solicitante ve all + requesters', () => {
    expect(visibleAnnouncements(list, false).map((a) => a.id)).toEqual(['req', 'all']);
  });
  it('lista vacía / undefined', () => {
    expect(visibleAnnouncements(undefined, true)).toEqual([]);
    expect(visibleAnnouncements([], false)).toEqual([]);
  });
});
