import { describe, it, expect } from 'vitest';
import {
  wallHeightsOf,
  withWallHeights,
} from '../../src/data/maps/wallHeights.js';
import maps from '../../src/data/maps/index.js';

describe('wallHeightsOf', () => {
  it('собирает высоты стен по уровням, тайл в нескольких слоях — максимум', () => {
    const map = {
      layers: { 2: [5, 6], 4: [6] },
      volumes: { 2: 1, 4: 0.25 },
      levels: { 1: { layers: { 4: [9] }, volumes: { 4: 0.35 } } },
    };

    expect(wallHeightsOf(map)).toEqual({
      0: { 5: 1, 6: 1 },
      1: { 9: 0.35 },
    });
  });
});

describe('withWallHeights', () => {
  it('сохраняет прежние поля game', () => {
    const map = {
      layers: { 2: [5] },
      volumes: { 2: 1 },
      game: { surfaces: { 0: { 41: 'sand' } } },
    };

    expect(withWallHeights(map).game).toEqual({
      surfaces: { 0: { 41: 'sand' } },
      wallHeights: { 0: { 5: 1 } },
    });
  });

  it('карта без volumes возвращается тем же объектом', () => {
    const map = { layers: { 2: [5] } };

    expect(withWallHeights(map)).toBe(map);
  });
});

describe('карты игры', () => {
  it.each(['downtown', 'overpass', 'terraces'])(
    '%s несёт game.wallHeights',
    name => {
      expect(maps[name].game.wallHeights).toBeDefined();
    },
  );

  it('downtown: стена 1 и стена канала 0.25 на земле, перила 0.35 на мосту', () => {
    const { wallHeights } = maps.downtown.game;

    expect(Object.values(wallHeights['0'])).toEqual(
      expect.arrayContaining([1, 0.25]),
    );
    expect(Object.values(wallHeights['1'])).toContain(0.35);
  });
});
