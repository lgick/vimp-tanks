import { describe, it, expect } from 'vitest';
import {
  rampWedgePolygon,
  laneBounds,
  laneHeightAt,
  castRay,
  firstHit,
  coneFan,
  coneUv,
  fanUvs,
  fanIndices,
  frameOf,
  rampBlocks,
  rampHeight,
  rampLight,
  anyCellIn,
  wallWash,
} from '../../../src/client/lighting/lightGeometry.js';

// Геометрия света фар и рамп: чистые функции, без PixiJS и без рендерера.

describe('lightGeometry: контур клина рампы', () => {
  // полоса вдоль x: клетки 2..5 × 1..2, подъём 0 → 1 к +x
  const lane = {
    axis: 0,
    sign: 1,
    from: 0,
    to: 1,
    col0: 2,
    col1: 5,
    row0: 1,
    row1: 2,
  };
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
    const points = rampWedgePolygon(
      { ...lane, sign: -1 },
      10,
      scale,
      { x: 0, y: 0 },
      0.2,
      1,
    );

    expect(points[0]).toBeCloseTo(20 * 1.2);
    expect(points[6]).toBeCloseTo(50);
  });
});

describe('lightGeometry: геометрия полосы рампы', () => {
  it('laneBounds: оси полосы в мировых единицах', () => {
    const lane = { axis: 0, col0: 2, col1: 5, row0: 1, row1: 2 };

    expect(laneBounds(lane, 10, 20)).toEqual({
      alongX: true,
      a0: 20,
      a1: 50,
      b0: 20,
      b1: 40,
    });
    expect(laneBounds({ ...lane, axis: 1 }, 10, 20)).toEqual({
      alongX: false,
      a0: 20,
      a1: 40,
      b0: 20,
      b1: 50,
    });
  });

  it('laneHeightAt: прогресс считается от подножия', () => {
    expect(laneHeightAt({ sign: 1, from: 0, to: 1 }, 0.25)).toBe(0.25);
    expect(laneHeightAt({ sign: -1, from: 0, to: 1 }, 0.25)).toBe(0.75);
  });
});

describe('lightGeometry: anyCellIn', () => {
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

// Фары и стены: клетка 10 × 10, стена — набор клеток
describe('lightGeometry: castRay / firstHit', () => {
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

describe('lightGeometry: coneFan / fanUvs / fanIndices', () => {
  const CELL = 10;
  const wall = cells => {
    const set = new Set(cells.map(([col, row]) => `${col},${row}`));

    return (col, row) => set.has(`${col},${row}`);
  };
  const cone = {
    x: 5,
    y: 55,
    rotation: 0,
    alongMax: 100,
    acrossMax: 50,
    rays: 9,
  };
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

describe('lightGeometry: frameOf', () => {
  it('конус: вершина — фара, масштабы по длине и полуширине', () => {
    const asset = {
      texture: { width: 140, height: 60 },
      length: 100,
      halfWidth: 25,
      margin: 20,
    };
    const light = {
      kind: 'cone',
      x: 40,
      y: 48,
      radius: 100,
      spread: 0.5,
      rotation: 0.3,
    };

    expect(frameOf(light, asset)).toEqual({
      x: 40,
      y: 48,
      rotation: 0.3,
      sx: 1,
      sy: 2,
      margin: 20,
      width: 140,
      height: 60,
    });
  });

  it('пятно: без поворота, масштаб по contentSize, вершина в центре', () => {
    const asset = { texture: { width: 68, height: 68 }, contentSize: 64 };
    const light = { kind: 'radial', x: 1, y: 2, radius: 32, rotation: 1 };

    expect(frameOf(light, asset)).toEqual({
      x: 1,
      y: 2,
      rotation: 0,
      sx: 1,
      sy: 1,
      margin: 34,
      width: 68,
      height: 68,
    });
  });
});

// Засветка грани стены: лучи веера, упёршиеся в одну грань, — квады от
// подножия вверх; UV верха — конец того же луча, яркость гаснет вверх
describe('lightGeometry: coneFan (reaches/forward) / wallWash', () => {
  const CELL = 10;
  const cone = {
    x: 5,
    y: 55,
    rotation: 0,
    alongMax: 100,
    acrossMax: 50,
    rays: 9,
  };
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
        const cross =
          (bx - cone.x) * (uy - cone.y) - (by - cone.y) * (ux - cone.x);

        expect(cross).toBeCloseTo(0, 2);
        expect(ux).toBeGreaterThan(bx);
      }
    }

    // ось: конец луча — край прямоугольника текстуры
    const axis = [...Array(wash.heights.length).keys()].find(
      v =>
        wash.heights[v] > 0 && Math.abs(wash.base[v * 2 + 1] - cone.y) < 1e-3,
    );

    expect(wash.uvs[axis * 2]).toBeCloseTo(cone.x + cone.alongMax, 3);
  });

  it('засветка не выше самой стены', () => {
    const fan = coneFan(cone, isBlocked, CELL, CELL);
    const wash = washOf(fan, () => 0.25);

    for (let v = 0; v < wash.heights.length; v += 1) {
      expect(
        wash.heights[v] === 0 || Math.abs(wash.heights[v] - 0.25) < 1e-6,
      ).toBe(true);
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

  it('wallWash: `level` прибавляется к высотам вершин', () => {
    const args = {
      x: 0,
      y: 0,
      points: new Float32Array([0, 0, 10, -5, 10, 5, 5, 10]),
      reaches: new Float32Array([100, 100, 100]),
      forward: 3,
      uvOf,
      cellW: CELL,
      cellH: CELL,
      height: 0.6,
    };

    // объём 1 — верх засветки на `height`, объём 0.35 (перила) — на объёме
    for (const wallAt of [() => 1, () => 0.35]) {
      const plain = wallWash({ ...args, wallAt });
      const withLevel = wallWash({ ...args, wallAt, level: 1 });

      for (let v = 0; v < plain.heights.length; v += 1) {
        // высоты во Float32Array: `level + h` округляется целиком и с
        // `plain.heights[v] + 1` совпадает не при всех `h` (0.35 — нет)
        expect(withLevel.heights[v]).toBeCloseTo(plain.heights[v] + 1, 6);
      }

      expect([...withLevel.base]).toEqual([...plain.base]);
      expect([...withLevel.uvs]).toEqual([...plain.uvs]);
      expect([...withLevel.indices]).toEqual([...plain.indices]);
    }
  });
});

// Рампа как препятствие свету подножия: полоса x 20..60, y 0..30, подъём на
// восток с уровня 0 на 1; клетка 10 × 10
describe('lightGeometry: rampBlocks', () => {
  const CELL = 10;
  const lane = {
    axis: 0,
    sign: 1,
    from: 0,
    to: 1,
    col0: 2,
    col1: 6,
    row0: 0,
    row1: 3,
  };
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

    expect(castRay(5, 15, diagonal, diagonal, 200, isBlocked, CELL, CELL)).toBe(
      200,
    );
  });
});

describe('lightGeometry: rampHeight', () => {
  it('высота по прогрессу от подножия, обрезана по полосе', () => {
    const lane = {
      axis: 0,
      sign: 1,
      from: 0,
      to: 1,
      col0: 2,
      col1: 6,
      row0: 0,
      row1: 3,
    };

    expect(rampHeight(lane, 20, 5, 10, 10)).toBeCloseTo(0);
    expect(rampHeight(lane, 40, 5, 10, 10)).toBeCloseTo(0.5);
    expect(rampHeight(lane, 90, 5, 10, 10)).toBeCloseTo(1);
    // подъём к меньшим y
    const down = {
      axis: 1,
      sign: -1,
      from: 1,
      to: 2,
      col0: 0,
      col1: 1,
      row0: 0,
      row1: 4,
    };

    expect(rampHeight(down, 5, 40, 10, 10)).toBeCloseTo(1);
    expect(rampHeight(down, 5, 10, 10, 10)).toBeCloseTo(1.75);
  });
});

describe('lightGeometry: rampLight', () => {
  const CELL = 10;
  // полоса x 20..60, y 0..30, подъём по +x
  const lane = {
    axis: 0,
    sign: 1,
    from: 0,
    to: 1,
    col0: 2,
    col1: 6,
    row0: 0,
    row1: 3,
  };
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
  const points = new Float32Array([
    0, 15, 100, -85, 100, -5, 100, 35, 100, 115,
  ]);
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

      area +=
        Math.abs(
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
