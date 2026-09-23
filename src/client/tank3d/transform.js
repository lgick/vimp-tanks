import { polygonNormal } from './model.js';

// Поза модели: поворот башни, откат ствола, тангаж и крен всего танка,
// встряска. Чистая функция — PixiJS не нужен. Курс сюда не входит: его даёт
// поворот контейнера `Tank`, а модель живёт в осях корпуса.

const TURRET_PARTS = new Set(['turret', 'barrel']);

/**
 * @param {object} p
 * @param {{ vertices: number[][], faces: object[] }} p.model
 * @param {number} p.size          размер модели танка (как `size` в кадре)
 * @param {number} [p.gunRotation] поворот башни относительно корпуса, рад
 * @param {number} [p.pitch]       тангаж, рад (> 0 — нос `+u` вверх)
 * @param {number} [p.roll]        крен, рад (> 0 — борт `+v` вверх)
 * @param {{x: number, y: number}} [p.gunKick]  откат ствола в осях корпуса,
 *   мировые единицы
 * @param {{x: number, y: number}} [p.shift]    сдвиг всего танка (отдача
 *   корпуса, встряска), мировые единицы
 * @param {number} [p.squash]      просадка: доля сжатия по высоте
 * @returns {{ points: number[][], normals: number[][] }} точки в мировых
 *   единицах и нормали граней — в осях корпуса после позы
 */
export function poseModel({
  model,
  size,
  gunRotation = 0,
  pitch = 0,
  roll = 0,
  gunKick = { x: 0, y: 0 },
  shift = { x: 0, y: 0 },
  squash = 0,
}) {
  const scale = size / 10;
  const cosG = Math.cos(gunRotation);
  const sinG = Math.sin(gunRotation);
  const cosP = Math.cos(pitch);
  const sinP = Math.sin(pitch);
  const cosR = Math.cos(roll);
  const sinR = Math.sin(roll);
  const heightScale = 1 - squash;

  // часть каждой вершины: у башни и ствола свой поворот
  const partOf = new Array(model.vertices.length);

  for (const face of model.faces) {
    for (const index of face.indices) {
      partOf[index] = face.part;
    }
  }

  // крен вокруг `u`, затем тангаж вокруг `v` — вокруг центра опоры
  const tilt = ([u, v, w]) => {
    const v1 = v * cosR - w * sinR;
    const w1 = v * sinR + w * cosR;

    return [u * cosP - w1 * sinP, v1, u * sinP + w1 * cosP];
  };

  const turn = ([u, v, w]) => [u * cosG - v * sinG, u * sinG + v * cosG, w];

  const points = model.vertices.map(([u, v, w], index) => {
    let point = [u * scale, v * scale, w * scale * heightScale];
    const part = partOf[index];

    if (TURRET_PARTS.has(part)) {
      point = turn(point);
    }

    // откатывается только ствол, башня стоит
    if (part === 'barrel') {
      point = [point[0] + gunKick.x, point[1] + gunKick.y, point[2]];
    }

    point = tilt(point);

    return [point[0] + shift.x, point[1] + shift.y, point[2]];
  });

  const normals = model.faces.map(face => {
    let normal = faceNormal(model, face, heightScale);

    if (TURRET_PARTS.has(face.part)) {
      normal = turn(normal);
    }

    return tilt(normal);
  });

  return { points, normals };
}

// нормаль грани модели в её осях (с учётом сжатия по высоте)
function faceNormal(model, face, heightScale) {
  return polygonNormal(
    face.indices.map(i => {
      const [u, v, w] = model.vertices[i];

      return [u, v, w * heightScale];
    }),
  );
}
