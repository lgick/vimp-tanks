// Развёртка граней модели на атлас (`src/client/bakers/tankModelTexture.js`).
// Чистая функция — PixiJS не нужен. UV считаются по НЕпозированной модели:
// текстура приклеена к части и едет вместе с ней.
//
// - верхи и скаты (видимые сверху) — планарно по (u, v): гусеницы и корпус
//   на рисунок корпуса, башня и ствол — на рисунок башни;
// - отвесные бока гусениц, ствола и тормоза — на свои полосы: вдоль ребра —
//   его длина в пикселях, по высоте — вся полоса;
// - низ — одна тёмная точка.

const PLANAR_BY_PART = {
  track: 'body',
  hull: 'body',
  turret: 'gun',
  barrel: 'gun',
};

const STRIP_BY_MATERIAL = {
  trackSide: 'trackSide',
  barrel: 'barrelSide',
  brake: 'brakeSide',
};

// отвесный ли бок: у квада бока `[low i, low j, high j, high i]` верхние
// точки стоят над нижними
function isVertical(model, face) {
  const [a, b, c, d] = face.indices.map(i => model.vertices[i]);

  return (
    face.indices.length === 4 &&
    a[0] === d[0] &&
    a[1] === d[1] &&
    b[0] === c[0] &&
    b[1] === c[1]
  );
}

/**
 * @param {{ vertices: number[][], faces: object[] }} model
 * @param {{ width: number, height: number, regions: object }} atlas
 * @returns {number[][][]} на каждую грань — `[x, y]` (0..1) для каждой её
 *   вершины, в порядке `face.indices`
 */
export function faceUVs(model, atlas) {
  const { width, height, regions } = atlas;
  const norm = ([x, y]) => [x / width, y / height];

  return model.faces.map(face => {
    if (face.kind === 'bottom') {
      const { x, y, w, h } = regions.bottom;

      return face.indices.map(() => norm([x + w / 2, y + h / 2]));
    }

    const strip = STRIP_BY_MATERIAL[face.material];

    if (face.kind === 'side' && strip && isVertical(model, face)) {
      const region = regions[strip];
      const [a, b] = face.indices.map(i => model.vertices[i]);
      const length = Math.min(Math.hypot(b[0] - a[0], b[1] - a[1]), region.w);
      const top = region.y;
      const low = region.y + region.h;

      // [low i, low j, high j, high i]
      return [
        norm([region.x, low]),
        norm([region.x + length, low]),
        norm([region.x + length, top]),
        norm([region.x, top]),
      ];
    }

    const region = regions[PLANAR_BY_PART[face.part]];

    return face.indices.map(i => {
      const [u, v] = model.vertices[i];

      return norm([region.originX + u, region.originY + v]);
    });
  });
}
