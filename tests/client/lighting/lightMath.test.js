import { describe, it, expect } from 'vitest';
import {
  cellCenter,
  cellRuns,
  cellsOfTiles,
  flashFactor,
  flicker,
  fnv1a,
  isOnScreen,
  lightLevels,
  mapKeyOf,
  projectLight,
  radialFalloff,
  lightStrength,
  selectLights,
  buildLightGrid,
  queryLightGrid,
  shadowWedge,
  shaftSway,
  rampWedgePolygon,
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

describe('lightMath: уровни источника на рампе', () => {
  it('на рампе — оба соседних уровня', () => {
    expect(lightLevels(0, 0.3, false)).toEqual([0, 1]);
    expect(lightLevels(1, 0.7, false)).toEqual([0, 1]);
  });

  it('на целой высоте — один уровень', () => {
    expect(lightLevels(1, 1, false)).toEqual([1]);
    expect(lightLevels(0, 0, false)).toEqual([0]);
  });

  it('в полёте — уровень отрисовки', () => {
    expect(lightLevels(1, 0.4, true)).toEqual([0]);
  });
});

describe('lightMath: сила источника в точке (засвет)', () => {
  it('спад пятна — (1 − t)², ноль на краю и за ним', () => {
    expect(radialFalloff(0, 100)).toBe(1);
    expect(radialFalloff(50, 100)).toBeCloseTo(0.25);
    expect(radialFalloff(100, 100)).toBe(0);
    expect(radialFalloff(150, 100)).toBe(0);
    expect(radialFalloff(10, 0)).toBe(0);
  });

  it('радиальный источник: сила · спад по расстоянию', () => {
    const lamp = { kind: 'radial', x: 0, y: 0, radius: 100, intensity: 0.8 };

    expect(lightStrength(lamp, 50, 0)).toBeCloseTo(0.2);
    expect(lightStrength(lamp, 0, 120)).toBe(0);
  });

  it('конус светит только вперёд и внутри клина', () => {
    const cone = {
      kind: 'cone',
      x: 0,
      y: 0,
      radius: 100,
      spread: 0.5,
      rotation: 0,
      intensity: 1,
    };

    expect(lightStrength(cone, 50, 0)).toBeGreaterThan(0);
    // позади фары
    expect(lightStrength(cone, -10, 0)).toBe(0);
    // вне клина: полуширина на 50 — 25
    expect(lightStrength(cone, 50, 30)).toBe(0);
    // дальше луча
    expect(lightStrength(cone, 120, 0)).toBe(0);
    // к краю клина слабее, чем на оси
    expect(lightStrength(cone, 50, 20)).toBeLessThan(lightStrength(cone, 50, 0));
  });

  it('поворот конуса поворачивает клин', () => {
    const cone = {
      kind: 'cone',
      x: 0,
      y: 0,
      radius: 100,
      rotation: Math.PI / 2,
      intensity: 1,
    };

    expect(lightStrength(cone, 0, 50)).toBeGreaterThan(0);
    expect(lightStrength(cone, 50, 0)).toBe(0);
  });

  it('отбор: сильнейшие первыми, с множителем и направлением на источник', () => {
    const near = { kind: 'radial', x: 10, y: 0, radius: 100, color: 0xff0000 };
    const far = { kind: 'radial', x: 0, y: -60, radius: 100 };
    const dark = { kind: 'radial', x: 500, y: 0, radius: 100 };
    const hits = selectLights(
      [
        { light: far, factor: 1 },
        { light: near, factor: 1 },
        { light: dark, factor: 1 },
      ],
      0,
      0,
      5,
    );

    expect(hits.map(hit => hit.light)).toEqual([near, far]);
    expect(hits[0].angle).toBeCloseTo(0);
    expect(hits[1].angle).toBeCloseTo(-Math.PI / 2);
    expect(hits[0].color).toBe(0xff0000);
    expect(hits[1].color).toBe(0xffffff);

    // мерцание гасит источник целиком, лимит режет список
    expect(selectLights([{ light: near, factor: 0 }], 0, 0, 1)).toEqual([]);
    expect(
      selectLights(
        [
          { light: near, factor: 1 },
          { light: far, factor: 1 },
        ],
        0,
        0,
        1,
      ),
    ).toHaveLength(1);
  });
});

describe('lightMath: сетка фонарей', () => {
  it('фонарь лежит во всех клетках квадрата своего радиуса', () => {
    const lamp = { x: 150, y: 150, radius: 100 };
    const grid = buildLightGrid([lamp], 100);

    expect(queryLightGrid(grid, 60, 60)).toEqual([lamp]);
    expect(queryLightGrid(grid, 240, 240)).toEqual([lamp]);
    expect(queryLightGrid(grid, 350, 150)).toEqual([]);
  });

  it('пустая сетка и её отсутствие — пустой ответ', () => {
    expect(queryLightGrid(buildLightGrid([], 50), 0, 0)).toEqual([]);
    expect(queryLightGrid(undefined, 0, 0)).toEqual([]);
  });
});

describe('lightMath: клин тени в лучах', () => {
  it('клин начинается у касательных и уходит до дальности лучей', () => {
    const wedge = shadowWedge(0, 0, 50, 0, 10, 200);

    expect(wedge).toHaveLength(8);

    const tangent = Math.sqrt(50 * 50 - 10 * 10);

    expect(Math.hypot(wedge[0], wedge[1])).toBeCloseTo(tangent);
    expect(Math.hypot(wedge[2], wedge[3])).toBeCloseTo(200);
    expect(Math.hypot(wedge[4], wedge[5])).toBeCloseTo(200);
    // клин симметричен оси «источник → предмет» и лежит за предметом
    expect(wedge[3]).toBeCloseTo(-wedge[5]);
    expect(wedge[2]).toBeGreaterThan(50);
    // полуугол — asin(r / d)
    expect(Math.atan2(wedge[5], wedge[4])).toBeCloseTo(Math.asin(10 / 50));
  });

  it('источник внутри предмета или предмет дальше лучей — клина нет', () => {
    expect(shadowWedge(0, 0, 5, 0, 10, 200)).toBeNull();
    expect(shadowWedge(0, 0, 300, 0, 10, 200)).toBeNull();
    expect(shadowWedge(0, 0, 50, 0, 0, 200)).toBeNull();
  });

  it('покачивание лучей мало, детерминировано и разное у соседей', () => {
    expect(Math.abs(shaftSway(1, 12345, 0.08))).toBeLessThanOrEqual(0.08);
    expect(shaftSway(1, 12345, 0.08)).toBe(shaftSway(1, 12345, 0.08));
    expect(shaftSway(1, 12345, 0.08)).not.toBe(shaftSway(2, 12345, 0.08));
    expect(shaftSway(3, 500, 0)).toBeCloseTo(0);
  });
});

describe('lightMath: контур клина рампы', () => {
  // полоса вдоль x: клетки 2..5 × 1..2, подъём 0 → 1 к +x
  const lane = { axis: 0, sign: 1, from: 0, to: 1, col0: 2, col1: 5, row0: 1, row1: 2 };
  const scale = { x: 1, y: 1 };

  it('камера в нуле: подножие на месте, вершина сдвинута на уровень', () => {
    const camera = { x: 0, y: 0 };
    const points = rampWedgePolygon(lane, 10, scale, camera, 0.2, 1);

    // 3 клетки × 1 отрезок: по 4 точки на кромку
    expect(points).toHaveLength(16);
    // первая точка — подножие (k = 0), мировая
    expect(points.slice(0, 2)).toEqual([20, 10]);
    // последняя точка первой кромки — вершина: k = shear, p · (1 + k)
    expect(points[6]).toBeCloseTo(50 * 1.2);
    expect(points[7]).toBeCloseTo(10 * 1.2);
    // вторая кромка идёт обратно: начинается у вершины
    expect(points[8]).toBeCloseTo(50 * 1.2);
    expect(points[9]).toBeCloseTo(20 * 1.2);
    expect(points.slice(14)).toEqual([20, 20]);
  });

  it('та же проекция, что у меша клина: точка вершины — offsetPoint с k уровня', () => {
    const camera = { x: 100, y: -40 };
    const points = rampWedgePolygon(lane, 10, scale, camera, 0.22, 4);
    const top = points.slice(12 * 2, 12 * 2 + 2);

    expect(top[0]).toBeCloseTo(50 + (50 - 100) * 0.22);
    expect(top[1]).toBeCloseTo(10 + (10 + 40) * 0.22);
  });

  it('обратный знак — вершина у начала полосы', () => {
    const points = rampWedgePolygon({ ...lane, sign: -1 }, 10, scale, { x: 0, y: 0 }, 0.2, 1);

    expect(points[0]).toBeCloseTo(20 * 1.2);
    expect(points[6]).toBeCloseTo(50);
  });
});
