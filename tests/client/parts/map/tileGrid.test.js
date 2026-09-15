import { describe, it, expect } from 'vitest';
import {
  cellsCoverPoint,
  coversPoint,
  tileGrid,
} from '../../../../src/client/parts/map/tileGrid.js';

// Покрытие нарисованной точки набором тайлов на высотах `ks`: обратная
// проекция `w = (p + cam * k) / (1 + k)` и запас `margin` по кругу.

// тайл 5 в клетке (1, 0): мир x 10..20, y 0..10
const grid = tileGrid(
  [
    [0, 5],
    [0, 0],
  ],
  { x: 1, y: 1 },
  10,
);
const tiles = new Set([5]);
const camera = { x: 0, y: 0 };

describe('tileGrid: coversPoint', () => {
  it('точка над тайлом закрыта, вне тайла — нет', () => {
    expect(coversPoint(grid, tiles, { x: 15, y: 5 }, camera, [0], 0)).toBe(true);
    expect(coversPoint(grid, tiles, { x: 5, y: 5 }, camera, [0], 0)).toBe(false);
  });

  it('у края тайла решает запас margin', () => {
    const point = { x: 9, y: 5 };

    expect(coversPoint(grid, tiles, point, camera, [0], 0)).toBe(false);
    expect(coversPoint(grid, tiles, point, camera, [0], 2)).toBe(true);
  });

  it('точка ищется по проекции высоты k', () => {
    // центр клетки (15, 5) на высоте 0.5 нарисован в (22.5, 7.5)
    const drawn = { x: 22.5, y: 7.5 };

    expect(coversPoint(grid, tiles, drawn, camera, [0.5], 0)).toBe(true);
    expect(coversPoint(grid, tiles, drawn, camera, [0], 0)).toBe(false);
    // любая из высот
    expect(coversPoint(grid, tiles, drawn, camera, [0, 0.5], 0)).toBe(true);
  });

  it('без камеры или грида — не закрыта', () => {
    expect(coversPoint(grid, tiles, { x: 15, y: 5 }, null, [0], 0)).toBe(false);
    expect(
      coversPoint(tileGrid(null, { x: 1, y: 1 }, 10), tiles, { x: 15, y: 5 }, camera, [0], 0),
    ).toBe(false);
  });
});

describe('tileGrid: cellsCoverPoint', () => {
  it('тот же ответ по набору клеток', () => {
    const cells = new Set(['1,0']);
    const scale = { x: 1, y: 1 };

    expect(cellsCoverPoint(cells, 10, scale, { x: 15, y: 5 }, camera, [0], 0)).toBe(true);
    expect(cellsCoverPoint(cells, 10, scale, { x: 9, y: 5 }, camera, [0], 0)).toBe(false);
    expect(cellsCoverPoint(cells, 10, scale, { x: 9, y: 5 }, camera, [0], 2)).toBe(true);
    expect(cellsCoverPoint(new Set(), 10, scale, { x: 15, y: 5 }, camera, [0], 0)).toBe(false);
  });
});
