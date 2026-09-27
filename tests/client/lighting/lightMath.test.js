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
  radialProfile,
  coneProfile,
  lightStrength,
  selectLights,
  buildLightGrid,
  queryLightGrid,
  shadowWedge,
  shaftSway,
  rampWedgePolygon,
  castRay,
  firstHit,
  coneFan,
  coneUv,
  fanUvs,
  fanIndices,
  rampBlocks,
  rampHeight,
  rampLight,
  anyCellIn,
  wallWash,
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
  it('профили яркости: пятно (1 − t)², конус (1 − t)(1 − 0.35t)', () => {
    expect(radialProfile(0)).toBe(1);
    expect(radialProfile(1)).toBe(0);
    expect(radialProfile(0.5)).toBe(0.25);
    expect(coneProfile(0)).toBe(1);
    expect(coneProfile(1)).toBe(0);
    expect(coneProfile(0.5)).toBe(0.5 * (1 - 0.175));
  });

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

describe('lightMath: anyCellIn', () => {
  // сетка 4 × 3, построчно
  const grid = cells => {
    const out = new Uint8Array(12);

    cells.forEach(([col, row]) => {
      out[row * 4 + col] = 1;
    });

    return out;
  };

  it('пустая сетка или её нет — false', () => {
    expect(anyCellIn(grid([]), 4, 3, 0, 0, 3, 2)).toBe(false);
    expect(anyCellIn(undefined, 4, 3, 0, 0, 3, 2)).toBe(false);
  });

  it('клетка внутри и на границе прямоугольника — true', () => {
    expect(anyCellIn(grid([[2, 1]]), 4, 3, 1, 0, 3, 2)).toBe(true);
    expect(anyCellIn(grid([[1, 0]]), 4, 3, 1, 0, 2, 1)).toBe(true);
    expect(anyCellIn(grid([[2, 1]]), 4, 3, 0, 0, 2, 1)).toBe(true);
  });

  it('клетка вне прямоугольника — false', () => {
    expect(anyCellIn(grid([[3, 2]]), 4, 3, 0, 0, 2, 1)).toBe(false);
  });

  it('прямоугольник за краем сетки обрезается', () => {
    expect(anyCellIn(grid([[0, 0]]), 4, 3, -5, -5, 0, 0)).toBe(true);
    expect(anyCellIn(grid([[3, 2]]), 4, 3, 3, 2, 10, 10)).toBe(true);
    // целиком за краем: соседняя строка не должна «просочиться» по индексу
    expect(anyCellIn(grid([[0, 1]]), 4, 3, 4, 0, 8, 0)).toBe(false);
    expect(anyCellIn(grid([[0, 0]]), 4, 3, -3, 3, 0, 9)).toBe(false);
  });

  it('Int32Array полос рамп — ненулевой индекс полосы', () => {
    const cells = new Int32Array(12);

    cells[5] = 3;

    expect(anyCellIn(cells, 4, 3, 1, 1, 1, 1)).toBe(true);
  });
});

// Фары и стены (этап 12): клетка 10 × 10, стена — набор клеток
describe('lightMath: castRay / firstHit', () => {
  const CELL = 10;
  const wall = cells => {
    const set = new Set(cells.map(([col, row]) => `${col},${row}`));

    return (col, row) => set.has(`${col},${row}`);
  };

  it('пустое поле — луч до конца', () => {
    expect(castRay(5, 5, 1, 0, 100, wall([]), CELL, CELL)).toBe(100);
    expect(firstHit(5, 5, 1, 0, 100, wall([]), CELL, CELL)).toBeNull();
  });

  it('стена поперёк — расстояние до её грани', () => {
    const blocked = wall([[3, 0]]);

    expect(castRay(5, 5, 1, 0, 100, blocked, CELL, CELL)).toBeCloseTo(25);
    // влево та же стена не мешает
    expect(castRay(5, 5, -1, 0, 100, blocked, CELL, CELL)).toBe(100);

    const hit = firstHit(5, 5, 1, 0, 100, blocked, CELL, CELL);

    expect(hit.distance).toBeCloseTo(25);
    expect(hit.x).toBeCloseTo(30);
    expect(hit.y).toBeCloseTo(5);
  });

  it('стена дальше maxDist не видна', () => {
    expect(castRay(5, 5, 1, 0, 20, wall([[3, 0]]), CELL, CELL)).toBe(20);
  });

  it('диагональ и вертикаль: вход в клетку по ближней грани', () => {
    const d = Math.SQRT1_2;

    expect(castRay(5, 5, d, d, 100, wall([[2, 2]]), CELL, CELL)).toBeCloseTo(
        15 * Math.SQRT2,
    );
    expect(castRay(5, 5, 0, -1, 100, wall([[0, -2]]), CELL, CELL)).toBeCloseTo(
      15,
    );
  });

  it('начало в стене — 0', () => {
    expect(castRay(5, 5, 1, 0, 100, wall([[0, 0]]), CELL, CELL)).toBe(0);
  });
});

describe('lightMath: coneFan / fanUvs / fanIndices', () => {
  const CELL = 10;
  const wall = cells => {
    const set = new Set(cells.map(([col, row]) => `${col},${row}`));

    return (col, row) => set.has(`${col},${row}`);
  };
  const cone = { x: 5, y: 55, rotation: 0, alongMax: 100, acrossMax: 50, rays: 9 };
  const ends = points => {
    const list = [];

    for (let i = 2; i < points.length; i += 2) {
      list.push([points[i], points[i + 1]]);
    }

    return list;
  };

  it('пустое поле — полный конус, не обрезан', () => {
    const { points, clipped } = coneFan(cone, wall([]), CELL, CELL);

    expect(clipped).toBe(false);
    expect(points.length).toBe(20);
    expect([points[0], points[1]]).toEqual([5, 55]);

    // концы лучей — на краю прямоугольника текстуры перед вершиной
    for (const [x, y] of ends(points)) {
      const onFar = Math.abs(x - 105) < 1e-3;
      const onSide = Math.abs(Math.abs(y - 55) - 50) < 1e-3;

      expect(onFar || onSide).toBe(true);
    }

    // крайние лучи — поперёк оси, у вершины: размытый край не срезан
    expect(points[2]).toBeCloseTo(5);
    expect(points[3]).toBeCloseTo(5);
    expect(points[18]).toBeCloseTo(5);
    expect(points[19]).toBeCloseTo(105);
    // ось — до дальнего края
    expect(points[10]).toBeCloseTo(105);
  });

  it('стена поперёк — все лучи кончаются на её грани', () => {
    const column = Array.from({ length: 20 }, (_, row) => [4, row]);
    const { points, clipped } = coneFan(cone, wall(column), CELL, CELL);

    expect(clipped).toBe(true);

    for (const [x] of ends(points)) {
      expect(x).toBeLessThanOrEqual(40 + 1e-3);
    }

    // ось упёрлась в грань стены
    expect(points[10]).toBeCloseTo(40, 3);
  });

  it('стена сбоку — срезан только край', () => {
    const row = Array.from({ length: 20 }, (_, col) => [col, 3]);
    const { points, clipped } = coneFan(cone, wall(row), CELL, CELL);
    const list = ends(points);

    expect(clipped).toBe(true);
    // крайний луч вверх (−y) упёрся в ряд 3 — его нижняя грань y = 40
    expect(list[0][1]).toBeCloseTo(40, 3);
    // ось и нижняя половина — до края прямоугольника
    expect(list[4][0]).toBeCloseTo(105, 3);
    expect(list[8][1]).toBeCloseTo(105, 3);
  });

  it('вплотную к стене — веер схлопывается в точку', () => {
    const { points, clipped } = coneFan(cone, wall([[0, 5]]), CELL, CELL);

    expect(clipped).toBe(true);

    for (const [x, y] of ends(points)) {
      expect(x).toBe(5);
      expect(y).toBe(55);
    }
  });

  it('fanUvs: вершина — в (margin, середина), ось — вдоль u', () => {
    const uvs = fanUvs(new Float32Array([10, 20, 30, 20, 10, 25]), {
      x: 10,
      y: 20,
      rotation: 0,
      sx: 0.5,
      sy: 0.25,
      margin: 4,
      width: 48,
      height: 40,
    });

    expect(uvs[0]).toBeCloseTo(4 / 48);
    expect(uvs[1]).toBeCloseTo(0.5);
    // 20 вдоль → 40 пикселей
    expect(uvs[2]).toBeCloseTo(44 / 48);
    expect(uvs[3]).toBeCloseTo(0.5);
    // 5 поперёк (+y при rotation 0) → 20 пикселей вниз
    expect(uvs[4]).toBeCloseTo(4 / 48);
    expect(uvs[5]).toBeCloseTo(40 / 40);
  });

  it('fanUvs: поворот учитывается', () => {
    const uvs = fanUvs(new Float32Array([0, 0, 0, 10]), {
      x: 0,
      y: 0,
      rotation: Math.PI / 2,
      sx: 1,
      sy: 1,
      margin: 0,
      width: 20,
      height: 20,
    });

    // точка по оси повёрнутой фары (+y) — вдоль u
    expect(uvs[2]).toBeCloseTo(0.5);
    expect(uvs[3]).toBeCloseTo(0.5);
  });

  it('fanIndices: треугольники от вершины по соседним лучам', () => {
    expect([...fanIndices(3)]).toEqual([0, 1, 2, 0, 2, 3]);
  });

  it('fanIndices: замкнутый веер — последний луч с первым', () => {
    expect([...fanIndices(3, true)]).toEqual([0, 1, 2, 0, 2, 3, 0, 3, 1]);
  });

  it('alongBack: веер замкнут назад до края текстуры за фарой', () => {
    const { points, clipped, closed } = coneFan(
      { ...cone, alongBack: 4 },
      wall([]),
      CELL,
      CELL,
    );
    const list = ends(points);

    expect(closed).toBe(true);
    expect(clipped).toBe(false);
    // 9 лучей вперёд и 3 назад
    expect(list).toHaveLength(12);

    // задние лучи — не дальше 4 за вершиной по оси
    for (const [x] of list.slice(9)) {
      expect(x).toBeCloseTo(1, 3);
    }
  });
});

// Засветка грани стены: лучи веера, упёршиеся в одну грань, — квады от
// подножия вверх; UV верха — конец того же луча, яркость гаснет вверх
describe('lightMath: coneFan (reaches/forward) / wallWash', () => {
  const CELL = 10;
  const cone = { x: 5, y: 55, rotation: 0, alongMax: 100, acrossMax: 50, rays: 9 };
  const column = new Set(Array.from({ length: 20 }, (_, row) => `4,${row}`));
  const isBlocked = (col, row) => column.has(`${col},${row}`);
  // UV — сама мировая точка: так видно, какую точку взяла вершина
  const uvOf = (x, y) => [x, y];
  const washOf = (fan, wallAt = () => 1, height = 0.6) =>
    wallWash({
      x: cone.x,
      y: cone.y,
      points: fan.points,
      reaches: fan.reaches,
      forward: fan.forward,
      uvOf,
      wallAt,
      cellW: CELL,
      cellH: CELL,
      height,
    });

  it('coneFan отдаёт предел каждого луча и число лучей вперёд', () => {
    const fan = coneFan({ ...cone, alongBack: 4 }, () => false, CELL, CELL);

    expect(fan.forward).toBe(9);
    // 9 вперёд и 3 назад
    expect(fan.reaches).toHaveLength(12);
    // ось — до дальнего края, луч поперёк — до бокового
    expect(fan.reaches[4]).toBeCloseTo(100, 3);
    expect(fan.reaches[0]).toBeCloseTo(50, 3);
    // в пустом поле луч кончается на своём пределе
    expect(fan.points[10]).toBeCloseTo(cone.x + fan.reaches[4], 3);
  });

  it('coneUv — та же формула, что у fanUvs', () => {
    const frame = {
      x: 5,
      y: 55,
      rotation: 0.3,
      sx: 0.7,
      sy: 0.4,
      margin: 4,
      width: 136,
      height: 136,
    };
    const uvs = fanUvs(new Float32Array([30, 60]), frame);
    const [u, v] = coneUv(30, 60, frame);

    expect(u).toBeCloseTo(uvs[0], 6);
    expect(v).toBeCloseTo(uvs[1], 6);
  });

  it('стена поперёк конуса — квады между соседними упёршимися лучами', () => {
    const fan = coneFan(cone, isBlocked, CELL, CELL);
    const wash = washOf(fan);

    // в грань x = 40 упёрлись лучи −45°…+45° (5 штук) → 4 квада
    expect(wash.indices).toHaveLength(4 * 6);
    expect(wash.heights).toHaveLength(4 * 4);

    for (let q = 0; q < 4; q += 1) {
      // все вершины — на подножии грани
      for (let j = 0; j < 4; j += 1) {
        expect(wash.base[(q * 4 + j) * 2]).toBeCloseTo(40, 3);
      }

      // верх a, верх b — на высоте засветки; низ — на полу
      expect([...wash.heights.slice(q * 4, q * 4 + 4)]).toEqual([
        expect.closeTo(0.6, 6),
        expect.closeTo(0.6, 6),
        0,
        0,
      ]);
      // нормаль — навстречу лучу
      expect(wash.normals[q * 2]).toBe(-1);
      expect(wash.normals[q * 2 + 1]).toBe(0);
    }
  });

  it('UV низа — точка упора, UV верха — конец того же луча', () => {
    const fan = coneFan(cone, isBlocked, CELL, CELL);
    const wash = washOf(fan);

    for (let q = 0; q < 4; q += 1) {
      for (const [top, bottom] of [
        [q * 4, q * 4 + 2],
        [q * 4 + 1, q * 4 + 3],
      ]) {
        const bx = wash.base[bottom * 2];
        const by = wash.base[bottom * 2 + 1];

        expect(wash.uvs[bottom * 2]).toBeCloseTo(bx, 3);
        expect(wash.uvs[bottom * 2 + 1]).toBeCloseTo(by, 3);

        // верх — на продолжении луча из вершины, дальше подножия
        const ux = wash.uvs[top * 2];
        const uy = wash.uvs[top * 2 + 1];
        const cross = (bx - cone.x) * (uy - cone.y) - (by - cone.y) * (ux - cone.x);

        expect(cross).toBeCloseTo(0, 2);
        expect(ux).toBeGreaterThan(bx);
      }
    }

    // ось: конец луча — край прямоугольника текстуры
    const axis = [...Array(wash.heights.length).keys()].find(
      v =>
        wash.heights[v] > 0 &&
        Math.abs(wash.base[v * 2 + 1] - cone.y) < 1e-3,
    );

    expect(wash.uvs[axis * 2]).toBeCloseTo(cone.x + cone.alongMax, 3);
  });

  it('засветка не выше самой стены', () => {
    const fan = coneFan(cone, isBlocked, CELL, CELL);
    const wash = washOf(fan, () => 0.25);

    for (let v = 0; v < wash.heights.length; v += 1) {
      expect(wash.heights[v] === 0 || Math.abs(wash.heights[v] - 0.25) < 1e-6).toBe(true);
    }
  });

  it('упор в рампу (за кромкой не стена) — засветки нет', () => {
    const fan = coneFan(cone, isBlocked, CELL, CELL);

    expect(washOf(fan, () => 0)).toBeNull();
  });

  it('в пустом поле — засветки нет', () => {
    const fan = coneFan(cone, () => false, CELL, CELL);

    expect(washOf(fan)).toBeNull();
  });

  it('лучи в две разные грани (угол) — квад через угол не строится', () => {
    // вершина (0, 0): лучи 1 и 2 — в грань x = 10, луч 3 — в грань y = 10
    const wash = wallWash({
      x: 0,
      y: 0,
      points: new Float32Array([0, 0, 10, -5, 10, 5, 5, 10]),
      reaches: new Float32Array([100, 100, 100]),
      forward: 3,
      uvOf,
      wallAt: () => 1,
      cellW: CELL,
      cellH: CELL,
      height: 0.6,
    });

    expect(wash.indices).toHaveLength(6);
    expect(wash.base[0]).toBeCloseTo(10);
    expect(wash.base[2]).toBeCloseTo(10);
  });
});

// Рампа как препятствие свету подножия: полоса x 20..60, y 0..30, подъём на
// восток с уровня 0 на 1; клетка 10 × 10
describe('lightMath: rampBlocks', () => {
  const CELL = 10;
  const lane = { axis: 0, sign: 1, from: 0, to: 1, col0: 2, col1: 6, row0: 0, row1: 3 };
  const laneAt = (col, row) =>
    col >= 2 && col < 6 && row >= 0 && row < 3 ? lane : null;
  const enter = (col, row, prevCol, prevRow, x, y, z = 0) =>
    rampBlocks({
      lane: laneAt(col, row),
      prevLane: laneAt(prevCol, prevRow),
      col,
      row,
      prevCol,
      prevRow,
      x,
      y,
      z,
      cellW: CELL,
      cellH: CELL,
    });

  it('вход через подножие и ход по полосе — свет проходит', () => {
    expect(enter(2, 1, 1, 1, 20, 15)).toBe(false);
    expect(enter(3, 1, 2, 1, 30, 15)).toBe(false);
  });

  it('вход через борт у верха — стоп, у подножия — проходит', () => {
    expect(enter(4, 0, 4, -1, 45, 0)).toBe(true);
    expect(enter(2, 0, 2, -1, 21, 0)).toBe(false);
  });

  it('вход через верхний торец — стоп', () => {
    expect(enter(5, 1, 6, 1, 60, 15)).toBe(true);
  });

  it('фара выше клина проходит через борт', () => {
    expect(enter(4, 0, 4, -1, 45, 0, 1)).toBe(false);
  });

  it('выход через верхний торец — стоп: пол под торцом тёмный', () => {
    expect(enter(6, 1, 5, 1, 60, 15)).toBe(true);
  });

  it('выход вбок — не стоп: край конуса ложится на пол у борта', () => {
    expect(enter(3, 3, 3, 2, 35, 30)).toBe(false);
    expect(enter(3, -1, 3, 0, 35, 0)).toBe(false);
  });

  it('выход в соседнюю полосу — стоп', () => {
    const other = { ...lane, row0: 3, row1: 6 };

    expect(
      rampBlocks({
        lane: other,
        prevLane: lane,
        col: 3,
        row: 3,
        prevCol: 3,
        prevRow: 2,
        x: 35,
        y: 30,
        z: 0,
        cellW: CELL,
        cellH: CELL,
      }),
    ).toBe(true);
  });

  it('castRay: снизу по склону до торца, сбоку — до борта', () => {
    const isBlocked = (col, row, prevCol, prevRow, x, y) =>
      prevCol !== null && enter(col, row, prevCol, prevRow, x, y);

    expect(castRay(5, 15, 1, 0, 200, isBlocked, CELL, CELL)).toBeCloseTo(55);
    expect(castRay(45, -15, 0, 1, 200, isBlocked, CELL, CELL)).toBeCloseTo(15);
    // мимо горки — до конца
    expect(castRay(5, 45, 1, 0, 200, isBlocked, CELL, CELL)).toBe(200);
    // от подножия наискосок: вышел через борт — дальше по полу
    const diagonal = Math.SQRT1_2;

    expect(
      castRay(5, 15, diagonal, diagonal, 200, isBlocked, CELL, CELL),
    ).toBe(200);
  });
});

describe('lightMath: rampHeight', () => {
  it('высота по прогрессу от подножия, обрезана по полосе', () => {
    const lane = { axis: 0, sign: 1, from: 0, to: 1, col0: 2, col1: 6, row0: 0, row1: 3 };

    expect(rampHeight(lane, 20, 5, 10, 10)).toBeCloseTo(0);
    expect(rampHeight(lane, 40, 5, 10, 10)).toBeCloseTo(0.5);
    expect(rampHeight(lane, 90, 5, 10, 10)).toBeCloseTo(1);
    // подъём к меньшим y
    const down = { axis: 1, sign: -1, from: 1, to: 2, col0: 0, col1: 1, row0: 0, row1: 4 };

    expect(rampHeight(down, 5, 40, 10, 10)).toBeCloseTo(1);
    expect(rampHeight(down, 5, 10, 10, 10)).toBeCloseTo(1.75);
  });
});

describe('lightMath: rampLight', () => {
  const CELL = 10;
  // полоса x 20..60, y 0..30, подъём по +x
  const lane = { axis: 0, sign: 1, from: 0, to: 1, col0: 2, col1: 6, row0: 0, row1: 3 };
  const frame = {
    x: 0,
    y: 15,
    rotation: 0,
    sx: 1,
    sy: 1,
    margin: 4,
    width: 136,
    height: 136,
  };
  // веер из (0, 15) вдоль +x: четыре луча до x = 100, крайние накрывают
  // углы полосы у подножия
  const points = new Float32Array([0, 15, 100, -85, 100, -5, 100, 35, 100, 115]);
  const build = extra =>
    rampLight({
      points,
      closed: false,
      lane,
      frame,
      cellW: CELL,
      cellH: CELL,
      segmentsPerCell: 2,
      ...extra,
    });

  it('полигон — внутри полосы, высоты по прогрессу вдоль оси', () => {
    const result = build();

    expect(result).not.toBeNull();

    const { base, heights } = result;

    for (let v = 0; v < heights.length; v += 1) {
      const x = base[v * 2];
      const y = base[v * 2 + 1];

      expect(x).toBeGreaterThanOrEqual(20 - 1e-4);
      expect(x).toBeLessThanOrEqual(60 + 1e-4);
      expect(y).toBeGreaterThanOrEqual(-1e-4);
      expect(y).toBeLessThanOrEqual(30 + 1e-4);
      expect(heights[v]).toBeCloseTo((x - 20) / 40, 5);
    }

    // склон порезан на отрезки: вершины есть и внутри полосы по оси
    expect([...heights].some(h => h > 0.1 && h < 0.9)).toBe(true);
  });

  it('UV — coneUv мировой точки, индексы в пределах вершин', () => {
    const { base, uvs, indices, heights } = build();

    for (let v = 0; v < heights.length; v += 1) {
      const [u, w] = coneUv(base[v * 2], base[v * 2 + 1], frame);

      expect(uvs[v * 2]).toBeCloseTo(u, 5);
      expect(uvs[v * 2 + 1]).toBeCloseTo(w, 5);
    }

    expect(indices.length % 3).toBe(0);
    expect(Math.max(...indices)).toBeLessThan(heights.length);
  });

  it('площадь меша — пересечение веера с полосой', () => {
    const { base, indices } = build();
    let area = 0;

    for (let i = 0; i < indices.length; i += 3) {
      const [a, b, c] = [indices[i], indices[i + 1], indices[i + 2]];

      area += Math.abs(
        (base[b * 2] - base[a * 2]) * (base[c * 2 + 1] - base[a * 2 + 1]) -
          (base[c * 2] - base[a * 2]) * (base[b * 2 + 1] - base[a * 2 + 1]),
      ) / 2;
    }

    // веер накрывает полосу целиком: 40 × 30
    expect(area).toBeCloseTo(1200, 1);
  });

  it('веер вне полосы → null', () => {
    const away = new Float32Array([0, 100, 100, 90, 100, 110]);

    expect(build({ points: away })).toBeNull();
  });
});
