import { tankModel as tankModelConfig } from '../../config/render.js';

// Низкополигональная модель танка. Оси корпуса: `u` — вперёд (нос, `+x`
// текстуры), `v` — `+y` текстуры, `w` — вверх; те же, что у `tiltCorners` и
// света корпуса. Единицы — пиксели рисунка корпуса при базовом size 10
// (`src/client/bakers/tankTexture.js`): верх модели совпадает с рисунком.
//
// Грань — полигон по индексам вершин, обход против часовой стрелки при
// взгляде СНАРУЖИ (в осях u-v-w — правая тройка): нормаль по правилу
// правой руки смотрит наружу, а видимость в проекции сверху — знак площади.

// восьмигранник башни из рисунка (`tankTexture.js`), доли размера 10
const TURRET = [
  [1.33, -0.42],
  [0.42, -1],
  [-0.42, -1],
  [-1.33, -0.42],
  [-1.33, 0.42],
  [-0.42, 1],
  [0.42, 1],
  [1.33, 0.42],
].map(([u, v]) => [u * 10, v * 10]);

// порядок частей при равной высоте грани: ниже — раньше
export const PART_ORDER = { track: 0, hull: 1, turret: 2, barrel: 3 };

// удвоенная знаковая площадь многоугольника в плоскости u-v
export function signedArea(points) {
  let area = 0;

  for (let i = 0; i < points.length; i += 1) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[(i + 1) % points.length];

    area += x0 * y1 - x1 * y0;
  }

  return area;
}

// нормаль полигона методом Ньюэлла (нормированная)
export function polygonNormal(points) {
  let x = 0;
  let y = 0;
  let z = 0;

  for (let i = 0; i < points.length; i += 1) {
    const [u0, v0, w0] = points[i];
    const [u1, v1, w1] = points[(i + 1) % points.length];

    x += (v0 - v1) * (w0 + w1);
    y += (w0 - w1) * (u0 + u1);
    z += (u0 - u1) * (v0 + v1);
  }

  const length = Math.hypot(x, y, z) || 1;

  return [x / length, y / length, z / length];
}

const rect = (u0, u1, v0, v1) => [
  [u0, v0],
  [u1, v0],
  [u1, v1],
  [u0, v1],
];

const scalePolygon = (points, factor) =>
  points.map(([u, v]) => [u * factor, v * factor]);

/**
 * Модель танка: вершины `[u, v, w]` и грани `{ indices, part, material,
 * kind }`, где `kind` — `top | side | bottom`, `material` — имя области
 * атласа (этап 2 плана).
 *
 * @param {object} [config]  `tankModel` из src/config/render.js
 * @returns {{ vertices: number[][], faces: object[] }}
 */
export function createTankModel(config = tankModelConfig) {
  const vertices = [];
  const faces = [];

  // призма: низ `bottom` на высоте `w0`, верх `top` (столько же точек) на
  // `w1`. Обход приводится к положительной площади — бока смотрят наружу
  const prism = ({ bottom, top, w0, w1, part, topMaterial, sideMaterial }) => {
    let lower = bottom;
    let upper = top;

    if (signedArea(lower) < 0) {
      lower = [...lower].reverse();
      upper = [...upper].reverse();
    }

    const base = vertices.length;
    const count = lower.length;

    for (const [u, v] of lower) {
      vertices.push([u, v, w0]);
    }

    for (const [u, v] of upper) {
      vertices.push([u, v, w1]);
    }

    const low = i => base + i;
    const high = i => base + count + i;

    faces.push({
      indices: upper.map((_, i) => high(i)),
      part,
      material: topMaterial,
      kind: 'top',
    });

    faces.push({
      indices: lower.map((_, i) => low(count - 1 - i)),
      part,
      material: 'bottom',
      kind: 'bottom',
    });

    for (let i = 0; i < count; i += 1) {
      const j = (i + 1) % count;

      faces.push({
        indices: [low(i), low(j), high(j), high(i)],
        part,
        material: sideMaterial,
        kind: 'side',
      });
    }
  };

  // гусеницы по бортам
  for (const [v0, v1] of [
    [-15, -9],
    [9, 15],
  ]) {
    const plan = rect(-20, 20, v0, v1);

    prism({
      bottom: plan,
      top: plan,
      w0: 0,
      w1: config.trackHeight,
      part: 'track',
      topMaterial: 'trackTop',
      sideMaterial: 'trackSide',
    });
  }

  // корпус: скаты от низа к палубе — фаски рисунка, спереди — пологий
  // лобовой лист (палуба кончается на u = 14, низ — на u = 18)
  prism({
    bottom: rect(-18, 18, -9, 9),
    top: rect(-16, 14, -7, 7),
    w0: config.hullBase,
    w1: config.hullTop,
    part: 'hull',
    topMaterial: 'hullTop',
    sideMaterial: 'hullSide',
  });

  // башня: скаты — кольцо фаски рисунка (верх — тот же восьмигранник × 0.6)
  prism({
    bottom: TURRET,
    top: scalePolygon(TURRET, 0.6),
    w0: config.turretBase,
    w1: config.turretTop,
    part: 'turret',
    topMaterial: 'turretTop',
    sideMaterial: 'turretSide',
  });

  // ствол и дульный тормоз — брусы на высоте ствола
  const barrel = rect(2.5, 21, -2.5, 2.5);

  prism({
    bottom: barrel,
    top: barrel,
    w0: config.barrelHeight - config.barrelRadius,
    w1: config.barrelHeight + config.barrelRadius,
    part: 'barrel',
    topMaterial: 'barrel',
    sideMaterial: 'barrel',
  });

  const brake = rect(21, 24.5, -3.6, 3.6);

  prism({
    bottom: brake,
    top: brake,
    w0: config.barrelHeight - config.brakeRadius,
    w1: config.barrelHeight + config.brakeRadius,
    part: 'barrel',
    topMaterial: 'brake',
    sideMaterial: 'brake',
  });

  return { vertices, faces };
}
