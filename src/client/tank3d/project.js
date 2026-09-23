import { signedArea, PART_ORDER } from './model.js';

// Проекция модели в оси контейнера `Tank` (он повёрнут на курс и стоит в
// проекции своей высоты): почти сверху, с одним на весь танк ограниченным
// наклоном от центра экрана. Чистые функции — PixiJS не нужен.

/**
 * Наклон на единицу высоты модели в ЛОКАЛЬНЫХ осях контейнера. Та же
 * проекция, что у карты (`(p − camera) · shear` на уровень), ослабленная в
 * `gain` раз и общая для всего танка — модель не «разъезжается», — а
 * верхняя точка плавно упирается в `maxLean` мировых единиц.
 *
 * @param {object} p
 * @param {number} p.x              мировая точка танка
 * @param {number} p.y
 * @param {{x: number, y: number}} p.camera
 * @param {number} p.heading         курс, рад (поворот контейнера)
 * @param {number} p.shear           parallax.shear
 * @param {number} p.levelHeight     мировых единиц на уровень
 * @param {number} p.maxLean         предел смещения верхней точки
 * @param {number} p.topHeight       высота верхней точки модели, мир. ед.
 * @param {number} [p.gain]          доля наклона карты: 1 — как у зданий
 * @returns {{x: number, y: number}}
 */
export function modelLean({
  x,
  y,
  camera,
  heading,
  shear,
  levelHeight,
  maxLean,
  topHeight,
  gain = 1,
}) {
  let lx = ((x - camera.x) * shear * gain) / levelHeight;
  let ly = ((y - camera.y) * shear * gain) / levelHeight;
  const top = Math.hypot(lx, ly) * topHeight;

  // плавное насыщение к `maxLean`, а не срез: на жёстком пределе наклон
  // переставал меняться рывком, и при забегающей вперёд камере башня
  // «съезжала» и замирала
  if (top > 0 && maxLean > 0) {
    const scale = (maxLean * Math.tanh(top / maxLean)) / top;

    lx *= scale;
    ly *= scale;
  }

  // в оси контейнера: поворот на −heading
  const cos = Math.cos(heading);
  const sin = Math.sin(heading);

  return { x: lx * cos + ly * sin, y: -lx * sin + ly * cos };
}

/**
 * 2D-точки модели в осях контейнера: `(u, v) + lean · w`, всё умножено на
 * `zScale` (масштаб высоты уровня, как у корпуса).
 *
 * @param {object} p
 * @param {number[][]} p.points  точки позы (`poseModel`)
 * @param {{x: number, y: number}} p.lean
 * @param {number} [p.zScale]
 * @returns {number[][]}
 */
export function projectModel({ points, lean, zScale = 1 }) {
  return points.map(([u, v, w]) => [
    (u + lean.x * w) * zScale,
    (v + lean.y * w) * zScale,
  ]);
}

/**
 * Видимые грани в порядке отрисовки. Видимость — знак площади проекции
 * (грань обращена к наблюдателю), порядок — по части (гусеницы → корпус →
 * башня → ствол), внутри части — по средней высоте грани после позы.
 *
 * @param {object} p
 * @param {{ faces: object[] }} p.model
 * @param {number[][]} p.points     точки позы (для высоты)
 * @param {number[][]} p.projected  2D-точки (`projectModel`)
 * @returns {number[]} индексы граней
 */
export function visibleFaces({ model, points, projected }) {
  const visible = [];

  model.faces.forEach((face, index) => {
    const polygon = face.indices.map(i => projected[i]);

    if (signedArea(polygon) > 1e-9) {
      let height = 0;

      for (const i of face.indices) {
        height += points[i][2];
      }

      visible.push({ index, height: height / face.indices.length, face });
    }
  });

  // Сначала по части: башня стоит на корпусе, ствол растёт из башни — и
  // так при любом наклоне. Средняя высота грани для этого не годится: у
  // большой палубы на горке она выше, чем у опущенных задних скатов башни,
  // и палуба закрывала корму башни. Внутри выпуклой части порядок почти не
  // важен (невидимые грани отброшены) — там решает высота
  visible.sort(
    (a, b) =>
      PART_ORDER[a.face.part] - PART_ORDER[b.face.part] ||
      a.height - b.height ||
      a.index - b.index,
  );

  return visible.map(item => item.index);
}

/**
 * Яркость грани по её нормали — та же формула, что у света корпуса
 * (`tankLightFactor`, src/client/tankLight.js): нормаль из осей корпуса
 * поворачивается на курс в оси экрана. Ровный плоский верх даёт 1.
 *
 * @param {number[]} normal  нормаль грани после позы, оси корпуса
 * @param {number} heading   курс, рад
 * @param {object} light     `tankLightUniforms` с нулевыми углами
 * @returns {number}
 */
export function faceShade(normal, heading, light) {
  const cos = Math.cos(heading);
  const sin = Math.sin(heading);
  const x = normal[0] * cos - normal[1] * sin;
  const y = normal[0] * sin + normal[1] * cos;
  const dot =
    x * light.uLight[0] + y * light.uLight[1] + normal[2] * light.uLight[2];

  return (light.uAmbient + light.uDiffuse * Math.max(dot, 0)) * light.uNorm;
}
