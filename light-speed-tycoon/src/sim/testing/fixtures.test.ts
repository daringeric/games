import { describe, expect, it } from 'vitest';
import { makeGridCity } from './fixtures';

describe('makeGridCity', () => {
  it('builds a 3x2 grid with index-aligned ids', () => {
    const city = makeGridCity();
    expect(city.nodes).toHaveLength(12);
    expect(city.segments).toHaveLength(9 + 8);
    expect(city.parcels).toHaveLength(3 * 2 * 4 * 2);
    city.nodes.forEach((n, i) => expect(n.id).toBe(i));
    city.segments.forEach((s, i) => expect(s.id).toBe(i));
    city.parcels.forEach((p, i) => expect(p.id).toBe(i));
  });

  it('puts every parcel adjacent to its frontage segment', () => {
    const city = makeGridCity({ cols: 2, rows: 2, blockW: 3, blockH: 2 });
    for (const p of city.parcels) {
      const seg = city.segments[p.segment]!;
      const a = city.nodes[seg.a]!;
      const b = city.nodes[seg.b]!;
      expect(a.y).toBe(b.y); // fixture parcels front horizontal streets
      const touchesTop = p.y === a.y;
      const touchesBottom = p.y + p.h === a.y;
      expect(touchesTop || touchesBottom).toBe(true);
      expect(p.x).toBeGreaterThanOrEqual(Math.min(a.x, b.x));
      expect(p.x + p.w).toBeLessThanOrEqual(Math.max(a.x, b.x));
    }
  });
});
