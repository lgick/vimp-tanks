import { describe, it, expect } from 'vitest';
import {
  cellCenter,
  cellRuns,
  cellsOfTiles,
  flashFactor,
  flicker,
  fnv1a,
  isOnScreen,
  mapKeyOf,
  projectLight,
} from '../../../src/client/lighting/lightMath.js';
import { cellOfPoint } from '../../../src/client/parts/map/tileGrid.js';

// Чистые функции освещения: без PixiJS и без рендерера.

const stage = { position: { x: 400, y: 300 }, scale: { x: 1, y: 1 } };

describe('lightMath: проекция источника по уровню', () => {
  const camera = { x: 0, y: 0 };
  const shear = 0.2;

  it('на уровне 0 точка не смещается, масштаб 1', () => {
    const view = projectLight(100, 50, 0, camera, stage, shear);

    expect(view).toMatchObject({ x: 100, y: 50, scale: 1 });
    expect(view.screenX).toBe(500);
    expect(view.screenY).toBe(350);
  });

  it('на уровне 1 точка уходит от центра камеры на k = shear', () => {
    const view = projectLight(100, 50, 1, camera, stage, shear);

    expect(view.x).toBeCloseTo(120);
    expect(view.y).toBeCloseTo(60);
    expect(view.scale).toBeCloseTo(1.2);
  });

  it('без камеры источник остаётся в мировой точке', () => {
    const view = projectLight(100, 50, 2, null, stage, shear);

    expect(view.x).toBe(100);
    expect(view.y).toBe(50);
  });
});

describe('lightMath: отсечение по экрану', () => {
  it('круг охвата, задевающий экран, видим', () => {
    expect(isOnScreen(-10, 100, 20, 800, 600)).toBe(true);
    expect(isOnScreen(810, 100, 20, 800, 600)).toBe(true);
  });

  it('круг целиком за экраном отсекается', () => {
    expect(isOnScreen(-30, 100, 20, 800, 600)).toBe(false);
    expect(isOnScreen(400, 700, 50, 800, 600)).toBe(false);
  });
});

describe('lightMath: мерцание детерминировано', () => {
  it('одинаковые входы дают одинаковый множитель', () => {
    expect(flicker(3, 1234, 0.5)).toBe(flicker(3, 1234, 0.5));
  });

  it('без силы мерцания множитель ровно 1', () => {
    expect(flicker(3, 1234, 0)).toBe(1);
  });

  it('множитель лежит в [1 - strength, 1]', () => {
    for (let t = 0; t < 5000; t += 37) {
      const value = flicker(2, t, 0.4);

      expect(value).toBeGreaterThanOrEqual(0.6 - 1e-9);
      expect(value).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it('соседние фонари мерцают не синхронно', () => {
    expect(flicker(1, 500, 0.5)).not.toBe(flicker(2, 500, 0.5));
  });
});

describe('lightMath: затухание вспышки', () => {
  it('1 в начале, 0 к концу и после', () => {
    expect(flashFactor(0, 100)).toBe(1);
    expect(flashFactor(100, 100)).toBe(0);
    expect(flashFactor(150, 100)).toBe(0);
    expect(flashFactor(50, 100)).toBeCloseTo(0.25);
  });
});

describe('lightMath: mapKeyOf', () => {
  const lighting = { night: true, ambient: 1, lamps: [{ cell: [1, 2] }] };
  const grid = [
    [0, 0, 0],
    [0, 0, 0],
  ];

  it('одинаков для частей разных уровней одной карты', () => {
    const ground = { map: grid, level: 0, layer: 1, tiles: [1], game: { lighting } };
    const bridge = { map: grid, level: 1, layer: 4, tiles: [5], floor: [5], game: { lighting } };

    expect(mapKeyOf(ground)).toBe(mapKeyOf(bridge));
  });

  it('зависит от размеров сетки', () => {
    const wide = [[0, 0, 0, 0]];

    expect(mapKeyOf({ map: grid, game: { lighting } })).not.toBe(
      mapKeyOf({ map: wide, game: { lighting } }),
    );
  });

  it('зависит от game.lighting и только от него в game', () => {
    const base = mapKeyOf({ map: grid, game: { lighting } });

    expect(
      mapKeyOf({ map: grid, game: { lighting: { ...lighting, ambient: 2 } } }),
    ).not.toBe(base);
    expect(
      mapKeyOf({ map: grid, game: { lighting, surfaces: { 0: {} } } }),
    ).toBe(base);
  });

  it('без game.lighting ключ всё равно строится', () => {
    expect(mapKeyOf({ map: grid })).toBe(`3x2:${fnv1a('null').toString(16)}`);
  });
});

describe('lightMath: клетки', () => {
  it('центр клетки обратен cellOfPoint', () => {
    const point = cellCenter(3, 5, 32, 2);

    expect(cellOfPoint(point.x, 2, 32)).toBe(3);
    expect(cellOfPoint(point.y, 2, 32)).toBe(5);
    expect(point).toEqual({ x: 224, y: 352 });
  });

  it('cellsOfTiles отбирает клетки набора', () => {
    const map = [
      [0, 5, 6],
      [5, 0, 0],
    ];

    expect(cellsOfTiles(map, [5, 6])).toEqual([
      [1, 0],
      [2, 0],
      [0, 1],
    ]);
    expect(cellsOfTiles(map, [])).toEqual([]);
  });

  it('cellRuns сливает соседние клетки ряда в прогоны', () => {
    const runs = cellRuns([
      [3, 0],
      [1, 0],
      [2, 0],
      [5, 0],
      [0, 2],
    ]);

    expect(runs).toEqual([
      { col: 1, row: 0, length: 3 },
      { col: 5, row: 0, length: 1 },
      { col: 0, row: 2, length: 1 },
    ]);
  });
});
