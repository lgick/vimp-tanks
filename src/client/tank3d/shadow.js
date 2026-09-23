// Тень модели по её силуэту: каждая точка позы падает на опору вдоль
// света, на каждую часть — выпуклая оболочка. Чистые функции — PixiJS не
// нужен. Свет — тот же, что у граней (`tilt.lightDir` в осях экрана,
// `tankLight.lightZ` — его высота): точка на высоте `h` падает на
// `p − h · (Lx, Ly) / Lz` — от света, тем дальше, чем выше точка. Поэтому
// башня и ствол отбрасывают свою тень, наклон и подброс видны по ней.

// выпуклая оболочка (монотонная цепь), обход против часовой в осях u-v
export function convexHull(points) {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  if (sorted.length < 3) {
    return sorted;
  }

  const cross = (o, a, b) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  const upper = [];

  for (const point of sorted) {
    while (
      lower.length >= 2 &&
      cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0
    ) {
      lower.pop();
    }

    lower.push(point);
  }

  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const point = sorted[i];

    while (
      upper.length >= 2 &&
      cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0
    ) {
      upper.pop();
    }

    upper.push(point);
  }

  lower.pop();
  upper.pop();

  return lower.concat(upper);
}

/**
 * Сдвиг тени на единицу высоты в ЛОКАЛЬНЫХ осях контейнера (повёрнутого на
 * курс).
 *
 * @param {number[]} [lightDir]  направление НА свет в осях экрана
 * @param {number} lightZ        высота света относительно длины `lightDir`
 * @param {number} heading       курс, рад
 * @returns {{x: number, y: number}}
 */
export function shadowDrift(lightDir, lightZ, heading) {
  if (!lightDir || !(lightZ > 0)) {
    return { x: 0, y: 0 };
  }

  const len = Math.hypot(lightDir[0], lightDir[1]) || 1;
  // от света: минус направление на свет, на единицу высоты — делённое на
  // высоту света
  const wx = -lightDir[0] / len / lightZ;
  const wy = -lightDir[1] / len / lightZ;
  const cos = Math.cos(heading);
  const sin = Math.sin(heading);

  return { x: wx * cos + wy * sin, y: -wx * sin + wy * cos };
}

/**
 * Полигоны тени — по одному на часть модели.
 *
 * @param {object} p
 * @param {{ faces: object[] }} p.model
 * @param {number[][]} p.points  точки позы (`poseModel`), мировые единицы
 * @param {number} [p.lift]      подъём корпуса над опорой, мировые единицы
 * @param {{x: number, y: number}} p.drift  `shadowDrift`
 * @returns {number[][][]}
 */
export function shadowPolygons({ model, points, lift = 0, drift }) {
  const byPart = new Map();

  for (const face of model.faces) {
    if (!byPart.has(face.part)) {
      byPart.set(face.part, new Set());
    }

    for (const index of face.indices) {
      byPart.get(face.part).add(index);
    }
  }

  const polygons = [];

  for (const indices of byPart.values()) {
    const shadowed = [...indices].map(i => {
      const [u, v, w] = points[i];
      // точка под опорой (корма на крутом наклоне) тени не удлиняет
      const height = Math.max(0, w + lift);

      return [u + drift.x * height, v + drift.y * height];
    });

    polygons.push(convexHull(shadowed));
  }

  return polygons;
}
