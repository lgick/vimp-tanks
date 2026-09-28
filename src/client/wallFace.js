// Геометрия видимой грани стены для эффектов у стены: свет фар и попадание
// выстрела. Стена в физике и в лучах — след клеток на полу, а видимая стена —
// грань объёма от подножия до верха (`extrusion.js`). Здесь — какую грань
// задел луч, видна ли она из центра проекции; точку на грани на высоте даёт
// `reproject` (`src/client/parallax.js`).

// ближайшая к координате кромка клеток размера `size`
const edgeOf = (value, size) => Math.round(value / size) * size;

// Грань, на подножии которой лежит конец луча `(x, y)` с направлением
// `(dx, dy)`: конец на кромке клетки (допуск `tolerance`, мировые единицы).
// `{ axis: 'x' | 'y', coord, nx, ny }`: axis 'x' — кромка x = coord, нормаль
// (nx, ny) смотрит навстречу лучу. null — конец не на кромке.
// На углу берётся ось, по которой луч идёт круче (с неё он и вошёл)
export function edgeFace(x, y, dx, dy, cellW, cellH, tolerance) {
  const edgeX = edgeOf(x, cellW);
  const edgeY = edgeOf(y, cellH);
  const onX = Math.abs(dx) > 1e-9 && Math.abs(x - edgeX) <= tolerance;
  const onY = Math.abs(dy) > 1e-9 && Math.abs(y - edgeY) <= tolerance;

  if (onX && (!onY || Math.abs(dx) >= Math.abs(dy))) {
    return { axis: 'x', coord: edgeX, nx: dx > 0 ? -1 : 1, ny: 0 };
  }

  if (onY) {
    return { axis: 'y', coord: edgeY, nx: 0, ny: dy > 0 ? -1 : 1 };
  }

  return null;
}

// Видна ли грань из центра проекции: смотрит на камеру
export function faceIsFront(face, x, y, camera) {
  return face.nx * (camera.x - x) + face.ny * (camera.y - y) > 0;
}

// Расстояние вдоль луча (x0, y0) + (dx, dy)·t, на котором его рисунок в
// проекции `kBase` пересекает линию грани, нарисованную на высоте `kLine`
// (силуэт верха стены). null — луч параллелен грани
export function crossingDistance({ x0, y0, dx, dy, face, camera, kBase, kLine }) {
  const alongX = face.axis === 'x';
  const origin = alongX ? x0 : y0;
  const direction = alongX ? dx : dy;
  const cam = alongX ? camera.x : camera.y;

  if (Math.abs(direction) < 1e-9) {
    return null;
  }

  // линия грани в проекции `kLine`: X = coord + (coord − cam)·kLine
  const line = face.coord + (face.coord - cam) * kLine;

  return (line + cam * kBase - origin * (1 + kBase)) / (direction * (1 + kBase));
}
