import { offsetPoint } from '../parallax.js';
import { renderLevel } from '../levelZ.js';
import { baseScale } from '../parts/map/tileGrid.js';

// Чистые функции освещения: ключ карты, клетки → мир, проекция источника,
// отсечение по экрану, мерцание и затухание вспышки. Здесь нет ни одного
// объекта PixiJS — всё проверяется без рендерера.

// базовые zIndex внутри уровня (`levelZ`): карта освещённости выше всей
// динамики своего уровня (`Tank` 3, дым 4, окклюдер объёмов 5), эмиссив —
// над ней. Слои карты с базой >= LIGHT_OVERLAY_BASE_Z на ночной карте
// запрещены: их бы затемнило не по уровню
export const LIGHT_OVERLAY_BASE_Z = 40;
export const EMISSIVE_BASE_Z = 45;
// головы фонарей — светильники в асфальте: над дорогой и следами (1), под
// эффектами (2) и танком (3), поэтому наехавший танк их закрывает. Они под
// картой освещённости и светятся за счёт пятна своего же фонаря
export const LAMP_HEAD_BASE_Z = 1.5;

// FNV-1a (32 бита) по строке: короткий стабильный отпечаток конфига
export function fnv1a(text) {
  let hash = 0x811c9dc5;

  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash >>> 0;
}

// Ключ карты для сервиса освещения. Собирается ТОЛЬКО из того, что есть у
// каждой статической части: размеры сетки (у всех уровней одинаковы —
// движок отклоняет несовпадение) и `game.lighting`. Номера уровня и `setId`
// в ключе нет — у частей разных уровней одной карты ключ обязан совпасть
export function mapKeyOf(data) {
  const rows = data?.map?.length || 0;
  const cols = data?.map?.[0]?.length || 0;
  const hash = fnv1a(JSON.stringify(data?.game?.lighting ?? null));

  return `${cols}x${rows}:${hash.toString(16)}`;
}

// центр клетки `[col, row]` в мировых единицах: обратная к `cellOfPoint`
// (`tileGrid.js`) — шаг сетки не масштабирован, масштаб карты отдельно
export function cellCenter(col, row, step, scale) {
  const { x, y } = baseScale(scale);

  return { x: (col + 0.5) * step * x, y: (row + 0.5) * step * y };
}

// клетки грида, чей тайл входит в набор `tiles`: `[[col, row], ...]`
export function cellsOfTiles(map, tiles) {
  const set = new Set(tiles || []);
  const cells = [];

  if (!map || set.size === 0) {
    return cells;
  }

  for (let row = 0; row < map.length; row += 1) {
    const line = map[row] || [];

    for (let col = 0; col < line.length; col += 1) {
      if (set.has(line[col])) {
        cells.push([col, row]);
      }
    }
  }

  return cells;
}

// клетки маски → горизонтальные прогоны `{ col, row, length }`: маска
// этажа рисуется прямоугольниками прогонов, а не клеток
export function cellRuns(cells) {
  const rows = new Map();

  for (const [col, row] of cells) {
    if (!rows.has(row)) {
      rows.set(row, new Set());
    }

    rows.get(row).add(col);
  }

  const runs = [];

  for (const row of [...rows.keys()].sort((a, b) => a - b)) {
    const cols = [...rows.get(row)].sort((a, b) => a - b);
    let start = cols[0];
    let prev = cols[0];

    for (let i = 1; i <= cols.length; i += 1) {
      const col = cols[i];

      if (col === prev + 1) {
        prev = col;
      } else {
        runs.push({ col: start, row, length: prev - start + 1 });
        start = col;
        prev = col;
      }
    }
  }

  return runs;
}

// Нарисованная точка источника на высоте `z` (уровни) и её экранная
// позиция: проекция 2.5D (`offsetPoint`), затем трансформ сцены — как у
// центра дыры в `holeOverlay.js`. `scale` — масштаб проекции `1 + k`
export function projectLight(x, y, z, camera, stage, shear) {
  const k = z * shear;
  const point = offsetPoint(x, y, camera, k);

  return {
    x: point.x,
    y: point.y,
    scale: 1 + k,
    screenX: point.x * stage.scale.x + stage.position.x,
    screenY: point.y * stage.scale.y + stage.position.y,
  };
}

// уровни, в карты освещённости которых светит источник на высоте z:
// на рампе — оба соседних, иначе — один уровень отрисовки. Клин рампы
// нарисован в уровне `from` и затемняется его оверлеем, а плита, на которую
// выезжает луч, — оверлеем верхнего уровня: свет нужен обоим
export function lightLevels(level, z, airborne) {
  if (!airborne && Math.abs(z - Math.round(z)) > 1e-3) {
    return [Math.floor(z), Math.ceil(z)];
  }

  return [renderLevel(level, z)];
}

// попадает ли круг охвата `reach` (экранные пиксели) в прямоугольник экрана
export function isOnScreen(screenX, screenY, reach, width, height) {
  return (
    screenX + reach >= 0 &&
    screenX - reach <= width &&
    screenY + reach >= 0 &&
    screenY - reach <= height
  );
}

// Детерминированное мерцание: множитель яркости в `[1 - strength, 1]`.
// Сумма синусов с разными частотами и фазой от `seed` — у соседних фонарей
// мерцание не синхронно, а у одного фонаря одинаково на всех клиентах
export function flicker(seed, timeMs, strength) {
  if (!strength) {
    return 1;
  }

  const t = timeMs / 1000;
  const noise =
    Math.sin(t * 7.3 + seed * 12.9898) * 0.5 +
    Math.sin(t * 13.1 + seed * 78.233) * 0.3 +
    Math.sin(t * 23.7 + seed * 3.7) * 0.2;

  return 1 - strength * ((noise + 1) / 2);
}

// затухание вспышки: 1 в момент старта, 0 к концу, быстрый спад сначала
export function flashFactor(elapsedMs, durationMs) {
  if (!(durationMs > 0) || elapsedMs >= durationMs) {
    return 0;
  }

  const t = 1 - Math.max(0, elapsedMs) / durationMs;

  return t * t;
}

// --- засветы и лучи (этап 10) ---

// спад пятна фонаря по расстоянию: тот же `(1 − t)²`, что у текстуры
// `lightRadialTexture`, — засвет гаснет там же, где пятно
export function radialFalloff(distance, radius) {
  if (!(radius > 0) || distance >= radius) {
    return 0;
  }

  const t = 1 - Math.max(0, distance) / radius;

  return t * t;
}

// Сила источника в мировой точке `(x, y)` без мерцания. Конус — как его
// текстура (`headlightConeTexture`): клин от вершины по `rotation`,
// полуширина `along · spread`, яркость спадает по длине и к краям клина
export function lightStrength(light, x, y) {
  const dx = x - light.x;
  const dy = y - light.y;
  const intensity = light.intensity ?? 1;

  if (light.kind !== 'cone') {
    return intensity * radialFalloff(Math.hypot(dx, dy), light.radius);
  }

  const cos = Math.cos(light.rotation || 0);
  const sin = Math.sin(light.rotation || 0);
  const along = dx * cos + dy * sin;
  const across = Math.abs(dy * cos - dx * sin);

  if (!(light.radius > 0) || along <= 0 || along >= light.radius) {
    return 0;
  }

  const halfWidth = along * (light.spread ?? 0.5);

  if (across >= halfWidth) {
    return 0;
  }

  const t = along / light.radius;

  return intensity * (1 - t) * (1 - t * 0.35) * (1 - across / halfWidth);
}

// Отбор источников для точки: `candidates` — `[{ light, factor }]`, где
// `factor` — мерцание или затухание вспышки. Возвращает до `limit`
// сильнейших `{ light, strength, angle, color }`; `angle` — направление ОТ
// точки НА источник (рад)
export function selectLights(candidates, x, y, limit) {
  const hits = [];

  for (const { light, factor } of candidates) {
    const strength = lightStrength(light, x, y) * factor;

    if (strength > 0) {
      hits.push({
        light,
        strength,
        angle: Math.atan2(light.y - y, light.x - x),
        color: light.color ?? 0xffffff,
      });
    }
  }

  hits.sort((a, b) => b.strength - a.strength);

  return hits.slice(0, Math.max(0, limit));
}

const gridKey = (col, row) => `${col},${row}`;

// Сетка источников для запроса по точке: каждый источник лежит во всех
// клетках, которые задевает квадрат его радиуса. Запрос читает одну клетку
// и не обходит все фонари карты
export function buildLightGrid(lights, cellSize) {
  const size = cellSize > 0 ? cellSize : 1;
  const cells = new Map();

  for (const light of lights) {
    const radius = light.radius || 0;
    const col0 = Math.floor((light.x - radius) / size);
    const col1 = Math.floor((light.x + radius) / size);
    const row0 = Math.floor((light.y - radius) / size);
    const row1 = Math.floor((light.y + radius) / size);

    for (let row = row0; row <= row1; row += 1) {
      for (let col = col0; col <= col1; col += 1) {
        const key = gridKey(col, row);

        if (!cells.has(key)) {
          cells.set(key, []);
        }

        cells.get(key).push(light);
      }
    }
  }

  return { cellSize: size, cells };
}

// источники клетки сетки, в которую попала точка
export function queryLightGrid(grid, x, y) {
  if (!grid) {
    return [];
  }

  const col = Math.floor(x / grid.cellSize);
  const row = Math.floor(y / grid.cellSize);

  return grid.cells.get(gridKey(col, row)) || [];
}

// Клин тени предмета в лучах: предмет — круг `(cx, cy, radius)`, источник —
// точка `(lx, ly)`. Четырёхугольник от точек касания до дальности `reach`
// от источника: `[x0, y0, …, x3, y3]`. null — источник внутри предмета или
// предмет дальше `reach`
export function shadowWedge(lx, ly, cx, cy, radius, reach) {
  const distance = Math.hypot(cx - lx, cy - ly);

  if (!(radius > 0) || distance <= radius) {
    return null;
  }

  const tangent = Math.sqrt(distance * distance - radius * radius);

  if (tangent >= reach) {
    return null;
  }

  const angle = Math.atan2(cy - ly, cx - lx);
  const half = Math.asin(radius / distance);
  const a0 = angle - half;
  const a1 = angle + half;

  return [
    lx + Math.cos(a0) * tangent,
    ly + Math.sin(a0) * tangent,
    lx + Math.cos(a0) * reach,
    ly + Math.sin(a0) * reach,
    lx + Math.cos(a1) * reach,
    ly + Math.sin(a1) * reach,
    lx + Math.cos(a1) * tangent,
    ly + Math.sin(a1) * tangent,
  ];
}

// медленное покачивание лучей фонаря (рад): две медленные синусоиды с
// фазой от `seed` — у соседних фонарей не синхронно, у одного одинаково
// на всех клиентах
export function shaftSway(seed, timeMs, amount) {
  const t = timeMs / 1000;

  return (
    amount *
    (Math.sin(t * 0.37 + seed * 1.7) * 0.6 +
      Math.sin(t * 0.61 + seed * 4.1) * 0.4)
  );
}

// --- свет верхнего уровня на рампах (этап 11) ---

// Контур клина рампы в НАРИСОВАННЫХ координатах — та же проекция, что у меша
// клина (`buildRampMeshes` + `updateHeightMesh`, extrusion.js): высота
// вершины `lerp(from, to, progress)`, сдвиг `p + (p − cam) · k`. Высота
// линейна вдоль прогона, а сдвиг от неё — нет, поэтому кромка режется на
// `segmentsPerCell` отрезков на клетку, как меш. `lane` — полоса в клетках
// (`buildRampLanes`). Возвращает `[x0, y0, …]`: одна кромка туда, другая
// обратно
export function rampWedgePolygon(lane, step, scale, camera, shear, segmentsPerCell) {
  const alongX = lane.axis === 0;
  const cells = alongX ? lane.col1 - lane.col0 : lane.row1 - lane.row0;
  const segments = Math.max(1, cells * Math.max(1, Math.round(segmentsPerCell) || 1));
  const x0 = lane.col0 * step * scale.x;
  const x1 = lane.col1 * step * scale.x;
  const y0 = lane.row0 * step * scale.y;
  const y1 = lane.row1 * step * scale.y;
  const project = (x, y, k) => [x + (x - camera.x) * k, y + (y - camera.y) * k];
  const sideA = [];
  const sideB = [];

  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    const progress = lane.sign > 0 ? t : 1 - t;
    const k = (lane.from + (lane.to - lane.from) * progress) * shear;

    if (alongX) {
      const x = x0 + (x1 - x0) * t;

      sideA.push(project(x, y0, k));
      sideB.push(project(x, y1, k));
    } else {
      const y = y0 + (y1 - y0) * t;

      sideA.push(project(x0, y, k));
      sideB.push(project(x1, y, k));
    }
  }

  return [...sideA, ...sideB.reverse()].flat();
}
