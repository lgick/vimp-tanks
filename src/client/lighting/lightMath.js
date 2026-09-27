import { offsetPoint } from '../parallax.js';
import { renderLevel } from '../levelZ.js';
import { baseScale } from '../parts/map/tileGrid.js';
import { edgeFace } from '../wallFace.js';

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

// Профили яркости источников по доле `t ∈ [0, 1]` радиуса или длины. Одна
// формула на текстуру (баркеры) и на засвет (`lightStrength`): засвет
// обязан гаснуть ровно там, где гаснет картинка

// пятно фонаря: `(1 − t)²` — центр не пересвечен плато
export function radialProfile(t) {
  return (1 - t) * (1 - t);
}

// конус фары вдоль оси: яркий у фары, к концу сходит на нет
const CONE_TAIL = 0.35;

export function coneProfile(t) {
  return (1 - t) * (1 - t * CONE_TAIL);
}

// спад пятна фонаря по расстоянию: тот же `(1 − t)²`, что у текстуры
// `lightRadialTexture`, — засвет гаснет там же, где пятно
export function radialFalloff(distance, radius) {
  if (!(radius > 0) || distance >= radius) {
    return 0;
  }

  return radialProfile(Math.max(0, distance) / radius);
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

  return intensity * coneProfile(t) * (1 - across / halfWidth);
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

// --- фары и стены (этап 12) ---

// Расстояние от точки `(ox, oy)` по единичному направлению `(dx, dy)` до
// входа в первую занятую клетку (клетка `cellW × cellH` в мировых
// единицах) — обход сетки по граням клеток (DDA, Amanatides–Woo). Нет
// стены ближе `maxDist` — `maxDist`; начало в занятой клетке — 0.
// `isBlocked(col, row, prevCol, prevRow, x, y)` — занята ли клетка при
// входе в неё из соседней `(prevCol, prevRow)` в точке `(x, y)` (рампе
// важно, через какой край и на какой высоте в неё вошли); для клетки
// начала соседней нет
export function castRay(ox, oy, dx, dy, maxDist, isBlocked, cellW, cellH) {
  let col = Math.floor(ox / cellW);
  let row = Math.floor(oy / cellH);

  if (isBlocked(col, row, null, null, ox, oy)) {
    return 0;
  }

  const stepCol = dx > 0 ? 1 : -1;
  const stepRow = dy > 0 ? 1 : -1;
  const deltaX = dx !== 0 ? Math.abs(cellW / dx) : Infinity;
  const deltaY = dy !== 0 ? Math.abs(cellH / dy) : Infinity;
  let nextX = Infinity;
  let nextY = Infinity;

  if (dx !== 0) {
    nextX = ((dx > 0 ? col + 1 : col) * cellW - ox) / dx;
  }

  if (dy !== 0) {
    nextY = ((dy > 0 ? row + 1 : row) * cellH - oy) / dy;
  }

  for (;;) {
    const prevCol = col;
    const prevRow = row;
    let t;

    if (nextX < nextY) {
      t = nextX;
      col += stepCol;
      nextX += deltaX;
    } else {
      t = nextY;
      row += stepRow;
      nextY += deltaY;
    }

    if (!(t < maxDist)) {
      return maxDist;
    }

    if (isBlocked(col, row, prevCol, prevRow, ox + dx * t, oy + dy * t)) {
      return Math.max(0, t);
    }
  }
}

// на сколько уровней клин рампы может быть выше фары в точке, где луч
// входит в него через борт или верхний торец, и всё ещё её пропускать:
// низкий край у подножия ловит свет и сбоку
export const RAMP_CLEARANCE = 0.2;

// Высота клина полосы `lane` (`buildRampLanes`) в мировой точке `(x, y)`, в
// уровнях: `lerp(from, to, progress)`, прогресс — доля пути вдоль оси от
// подножия, обрезанная по полосе. Та же высота, что у вершин меша клина
export function rampHeight(lane, x, y, cellW, cellH) {
  const alongX = lane.axis === 0;
  const a0 = alongX ? lane.col0 * cellW : lane.row0 * cellH;
  const a1 = alongX ? lane.col1 * cellW : lane.row1 * cellH;
  const along = alongX ? x : y;
  const span = a1 - a0 || 1;
  const t = Math.min(1, Math.max(0, (along - a0) / span));
  const progress = lane.sign > 0 ? t : 1 - t;

  return lane.from + (lane.to - lane.from) * progress;
}

// Рампа как препятствие свету уровня её подножия. `lane` — полоса клетки,
// в которую входит луч, `prevLane` — полоса клетки, из которой он вышел
// (null — не рампа); полосы — `buildRampLanes` (клетки, `axis`, `sign`,
// `from`, `to`). `(x, y)` — точка входа, `z` — высота фары в уровнях.
// Правила (источник вне рампы):
//   - вошёл через подножие (шаг вдоль оси в сторону подъёма) — склон
//     освещён, луч идёт по полосе;
//   - вошёл через борт или верхний торец — стоп, если клин в точке входа
//     выше фары больше чем на `clearance`;
//   - вышел из полосы вбок (шаг поперёк оси) на пол — луч идёт дальше:
//     мягкий край конуса ложится на пол у бортов;
//   - вышел из полосы иначе (через верхний торец, в другую полосу) —
//     стоп: пол под торцом свет не получает
export function rampBlocks({
  lane,
  prevLane,
  col,
  row,
  prevCol,
  prevRow,
  x,
  y,
  z,
  cellW,
  cellH,
  clearance = RAMP_CLEARANCE,
}) {
  if (prevLane && prevLane !== lane) {
    const across = prevLane.axis === 0 ? row !== prevRow : col !== prevCol;

    return Boolean(lane) || !across;
  }

  if (!lane || prevLane === lane || prevCol === null || prevCol === undefined) {
    return false;
  }

  const alongX = lane.axis === 0;
  const step = alongX ? col - prevCol : row - prevRow;

  if (step === lane.sign) {
    return false;
  }

  return rampHeight(lane, x, y, cellW, cellH) - (z || 0) > clearance;
}

// Есть ли ненулевая клетка сетки `cells` (`cols × rows`, построчно) в
// прямоугольнике клеток [col0..col1] × [row0..row1] (включительно,
// обрезается по сетке). Дешёвая проверка «рядом с конусом нет
// препятствий» до обхода лучами
export function anyCellIn(cells, cols, rows, col0, row0, col1, row1) {
  if (!cells) {
    return false;
  }

  const c0 = Math.max(0, col0);
  const c1 = Math.min(cols - 1, col1);
  const r0 = Math.max(0, row0);
  const r1 = Math.min(rows - 1, row1);

  for (let row = r0; row <= r1; row += 1) {
    const offset = row * cols;

    for (let col = c0; col <= c1; col += 1) {
      if (cells[offset + col] !== 0) {
        return true;
      }
    }
  }

  return false;
}

// Точка упора оси: первая стена на луче не дальше `length` —
// `{ distance, x, y }`, иначе null
export function firstHit(ox, oy, dx, dy, length, isBlocked, cellW, cellH) {
  const distance = castRay(ox, oy, dx, dy, length, isBlocked, cellW, cellH);

  if (distance >= length) {
    return null;
  }

  return { distance, x: ox + dx * distance, y: oy + dy * distance };
}

// Полигон видимости конуса фары — веер из вершины `(x, y)` до ближней стены
// или до края прямоугольника текстуры: `alongMax` вперёд по оси `rotation`,
// `alongBack` назад (размытие за фарой), `acrossMax` поперёк. Вперёд —
// `rays` лучей поровну на ±90° от оси: размытый край текстуры у самой фары
// шире клина на постоянный отступ, и веер на угол клина срезал бы его —
// конус у стены становился резким. Назад — несколько лучей, замыкающих
// веер: без них на линии через вершину поперёк оси обрывалось размытие за
// фарой. Результат — `{ points, clipped, closed, reaches, forward }`:
// `points` — `[x, y, x0, y0, …]` (вершина, затем концы лучей по кругу) в
// мировых единицах, `clipped` — хоть один луч упёрся в стену (иначе конус
// целый и рисуется прежним спрайтом), `closed` — веер замкнут
// (`fanIndices`), `reaches` — предел каждого луча до края прямоугольника
// текстуры, `forward` — число лучей вперёд (первые в `points`): засветке
// грани (`wallWash`) нужна полная длина луча
export function coneFan(
  { x, y, rotation, alongMax, alongBack = 0, acrossMax, rays },
  isBlocked,
  cellW,
  cellH,
) {
  const count = Math.max(2, Math.round(rays) || 2);
  const closed = alongBack > 0;
  const back = closed ? Math.max(3, Math.round(count / 8)) : 0;
  const offsets = [];

  for (let i = 0; i < count; i += 1) {
    offsets.push(-Math.PI / 2 + (Math.PI * i) / (count - 1));
  }

  for (let j = 0; j < back; j += 1) {
    offsets.push(Math.PI / 2 + (Math.PI * (j + 1)) / (back + 1));
  }

  const points = new Float32Array((offsets.length + 1) * 2);
  const reaches = new Float32Array(offsets.length);
  let clipped = false;

  points[0] = x;
  points[1] = y;

  offsets.forEach((offset, i) => {
    const angle = rotation + offset;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    const along = Math.cos(offset);
    const across = Math.abs(Math.sin(offset));
    let reach = across > 1e-9 ? acrossMax / across : Infinity;

    if (along > 1e-9) {
      reach = Math.min(reach, alongMax / along);
    } else if (along < -1e-9) {
      reach = Math.min(reach, alongBack / -along);
    }

    const distance = castRay(x, y, dx, dy, reach, isBlocked, cellW, cellH);

    reaches[i] = reach;

    if (distance < reach - 1e-6) {
      clipped = true;
    }

    points[(i + 1) * 2] = x + dx * distance;
    points[(i + 1) * 2 + 1] = y + dy * distance;
  });

  return { points, clipped, closed, reaches, forward: count };
}

// UV мировой точки `(px, py)` в текстуре конуса — та же раскладка, что у
// спрайта (`itemOf`): вершина — в `(margin, height / 2)` текстуры, ось — по
// `+x`, `sx`/`sy` — мировых единиц на пиксель текстуры вдоль и поперёк оси.
// `cos`/`sin` поворота можно передать готовыми — веер зовёт это на каждую
// точку. Возвращает `[u, v]`
export function coneUv(
  px,
  py,
  { x, y, rotation, sx, sy, margin, width, height },
  cos = Math.cos(rotation),
  sin = Math.sin(rotation),
) {
  const rx = px - x;
  const ry = py - y;
  const along = rx * cos + ry * sin;
  const across = ry * cos - rx * sin;

  return [(margin + along / sx) / width, (height / 2 + across / sy) / height];
}

// UV точек веера в текстуре конуса (`coneUv` на каждую точку)
export function fanUvs(points, frame) {
  const cos = Math.cos(frame.rotation);
  const sin = Math.sin(frame.rotation);
  const uvs = new Float32Array(points.length);

  for (let i = 0; i < points.length; i += 2) {
    const [u, v] = coneUv(points[i], points[i + 1], frame, cos, sin);

    uvs[i] = u;
    uvs[i + 1] = v;
  }

  return uvs;
}

// квад засветки от его первой вершины: верхняя пара, затем нижняя — тот же
// порядок, что у рядов граней `extrusion.js`
const WASH_QUAD = [0, 1, 3, 0, 3, 2];

// Засветка грани стены конусом фары. Для соседних лучей веера вперёд,
// упёршихся в одну грань (`edgeFace`, клетка за кромкой — стена), — квад:
// низ на подножии, верх на высоте `min(height, объём стены)`. UV низа —
// точка упора, верха — конец того же луча: яркость гаснет вверх.
// Возвращает { base, heights, uvs, indices, normals, mids } или null:
// base — мировые точки (4 на квад: верх a, верх b, низ a, низ b, как у
// граней `extrusion.js`), heights — высота вершины в уровнях над полом
// стены, normals/mids — нормаль и середина подножия квада (видимость).
// `uvOf(x, y)` — `[u, v]` точки в текстуре конуса (`coneUv`), `wallAt(x,
// y)` — объём стены уровня фары в мировой точке (0 — не стена: упор в
// рампу засветки не даёт)
export function wallWash({
  x,
  y,
  points,
  reaches,
  forward,
  uvOf,
  wallAt,
  cellW,
  cellH,
  height,
}) {
  const probe = 0.01 * Math.min(cellW, cellH);
  // упор луча `i` (номер точки в `points`, 1..forward): грань, точка,
  // конец луча и высота засветки; null — луч в стену не упёрся
  const hitOf = i => {
    const px = points[i * 2];
    const py = points[i * 2 + 1];
    const distance = Math.hypot(px - x, py - y);
    const reach = reaches[i - 1];

    if (!(distance > 1e-9) || !(distance < reach - 1e-6)) {
      return null;
    }

    const dx = (px - x) / distance;
    const dy = (py - y) / distance;
    const face = edgeFace(px, py, dx, dy, cellW, cellH, 1e-3);

    if (!face) {
      return null;
    }

    const volume = wallAt(px + dx * probe, py + dy * probe);

    if (!(volume > 0)) {
      return null;
    }

    return {
      face,
      x: px,
      y: py,
      endX: px + dx * (reach - distance),
      endY: py + dy * (reach - distance),
      height: Math.min(height, volume),
    };
  };

  const hits = [];

  for (let i = 1; i <= forward; i += 1) {
    hits.push(hitOf(i));
  }

  const quads = [];

  for (let i = 0; i + 1 < hits.length; i += 1) {
    const a = hits[i];
    const b = hits[i + 1];

    if (
      a &&
      b &&
      a.face.axis === b.face.axis &&
      Math.abs(a.face.coord - b.face.coord) < 1e-6
    ) {
      quads.push([a, b]);
    }
  }

  if (!quads.length) {
    return null;
  }

  const base = new Float32Array(quads.length * 8);
  const heights = new Float32Array(quads.length * 4);
  const uvs = new Float32Array(quads.length * 8);
  const indices = new Uint32Array(quads.length * 6);
  const normals = new Float32Array(quads.length * 2);
  const mids = new Float32Array(quads.length * 2);

  quads.forEach(([a, b], q) => {
    // верх a, верх b, низ a, низ b
    const vertices = [
      [a.x, a.y, a.height, a.endX, a.endY],
      [b.x, b.y, b.height, b.endX, b.endY],
      [a.x, a.y, 0, a.x, a.y],
      [b.x, b.y, 0, b.x, b.y],
    ];

    vertices.forEach(([vx, vy, h, ux, uy], j) => {
      const v = q * 4 + j;
      const [u, w] = uvOf(ux, uy);

      base[v * 2] = vx;
      base[v * 2 + 1] = vy;
      heights[v] = h;
      uvs[v * 2] = u;
      uvs[v * 2 + 1] = w;
    });

    for (let j = 0; j < 6; j += 1) {
      indices[q * 6 + j] = q * 4 + WASH_QUAD[j];
    }

    normals[q * 2] = a.face.nx;
    normals[q * 2 + 1] = a.face.ny;
    mids[q * 2] = (a.x + b.x) / 2;
    mids[q * 2 + 1] = (a.y + b.y) / 2;
  });

  return { base, heights, uvs, indices, normals, mids };
}

// индексы веера из `count` лучей: треугольники (вершина, луч i, луч i + 1);
// `closed` — ещё и последний луч с первым
export function fanIndices(count, closed = false) {
  const open = Math.max(0, count - 1);
  const indices = new Uint32Array((open + (closed && count > 2 ? 1 : 0)) * 3);

  for (let i = 0; i < open; i += 1) {
    indices[i * 3] = 0;
    indices[i * 3 + 1] = i + 1;
    indices[i * 3 + 2] = i + 2;
  }

  if (closed && count > 2) {
    indices[open * 3] = 0;
    indices[open * 3 + 1] = count;
    indices[open * 3 + 2] = 1;
  }

  return indices;
}

// Выпуклый многоугольник `[[a, b], …]`, обрезанный полуплоскостью по
// координате `index` (0 — `a`, 1 — `b`): `above` — остаётся `>= bound`,
// иначе `<= bound` (Сазерленд — Ходжмен)
function clipPolygon(polygon, index, bound, above) {
  const out = [];

  for (let i = 0; i < polygon.length; i += 1) {
    const p = polygon[i];
    const q = polygon[(i + 1) % polygon.length];
    const pIn = above ? p[index] >= bound : p[index] <= bound;
    const qIn = above ? q[index] >= bound : q[index] <= bound;

    if (pIn) {
      out.push(p);
    }

    if (pIn !== qIn) {
      const t = (bound - p[index]) / (q[index] - p[index]);

      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  }

  return out;
}

// Свет источника на склоне рампы — в проекции клина (этап 14.5). Карта
// освещённости лежит в проекции пола, а клин нарисован с повершинной
// высотой (трапеция, шире к верху): пиксель клина брал бы свет не своей
// мировой точки. Здесь веер источника (`points` — вершина и концы лучей в
// мировых единицах, `closed` — как у `fanIndices`) режется прямоугольником
// полосы `lane` (`buildRampLanes`) и вдоль оси на `segmentsPerCell` отрезков
// на клетку — как меш клина (`rampWedgePolygon`): высота линейна вдоль
// оси, а сдвиг проекции от неё — нет. UV — `coneUv` мировой точки в
// раскладке текстуры `frame`: яркость та же, что у пола под ней.
// Возвращает { base, heights, uvs, indices } или null (веер полосу не
// задел): base — мировые точки, heights — высота клина в точке в уровнях
// (`rampHeight`, абсолютная)
export function rampLight({
  points,
  closed,
  lane,
  frame,
  cellW,
  cellH,
  segmentsPerCell,
}) {
  const alongX = lane.axis === 0;
  const a0 = alongX ? lane.col0 * cellW : lane.row0 * cellH;
  const a1 = alongX ? lane.col1 * cellW : lane.row1 * cellH;
  const b0 = alongX ? lane.row0 * cellH : lane.col0 * cellW;
  const b1 = alongX ? lane.row1 * cellH : lane.col1 * cellW;
  // точка веера в осях полосы: `a` — вдоль, `b` — поперёк
  const local = i =>
    alongX
      ? [points[i * 2], points[i * 2 + 1]]
      : [points[i * 2 + 1], points[i * 2]];
  const count = points.length / 2;
  let minA = Infinity;
  let maxA = -Infinity;
  let minB = Infinity;
  let maxB = -Infinity;

  for (let i = 0; i < count; i += 1) {
    const [a, b] = local(i);

    minA = Math.min(minA, a);
    maxA = Math.max(maxA, a);
    minB = Math.min(minB, b);
    maxB = Math.max(maxB, b);
  }

  if (!(maxA > a0 && minA < a1 && maxB > b0 && minB < b1)) {
    return null;
  }

  const cells = alongX ? lane.col1 - lane.col0 : lane.row1 - lane.row0;
  const segments = Math.max(
    1,
    cells * Math.max(1, Math.round(segmentsPerCell) || 1),
  );
  const slab = (a1 - a0) / segments;
  const cos = Math.cos(frame.rotation);
  const sin = Math.sin(frame.rotation);
  const base = [];
  const heights = [];
  const uvs = [];
  const indices = [];

  const emit = polygon => {
    const first = heights.length;

    for (const [a, b] of polygon) {
      const x = alongX ? a : b;
      const y = alongX ? b : a;
      const [u, v] = coneUv(x, y, frame, cos, sin);

      base.push(x, y);
      heights.push(rampHeight(lane, x, y, cellW, cellH));
      uvs.push(u, v);
    }

    for (let k = 1; k + 1 < polygon.length; k += 1) {
      indices.push(first, first + k, first + k + 1);
    }
  };

  const triangles = fanIndices(count - 1, closed);

  for (let t = 0; t < triangles.length; t += 3) {
    let polygon = [
      local(triangles[t]),
      local(triangles[t + 1]),
      local(triangles[t + 2]),
    ];

    polygon = clipPolygon(polygon, 1, b0, true);
    polygon = clipPolygon(polygon, 1, b1, false);
    polygon = clipPolygon(polygon, 0, a0, true);
    polygon = clipPolygon(polygon, 0, a1, false);

    if (polygon.length < 3) {
      continue;
    }

    const low = Math.min(...polygon.map(([a]) => a));
    const high = Math.max(...polygon.map(([a]) => a));
    const j0 = Math.max(0, Math.floor((low - a0) / slab));
    const j1 = Math.min(segments - 1, Math.ceil((high - a0) / slab) - 1);

    for (let j = j0; j <= j1; j += 1) {
      const piece = clipPolygon(
        clipPolygon(polygon, 0, a0 + j * slab, true),
        0,
        a0 + (j + 1) * slab,
        false,
      );

      if (piece.length >= 3) {
        emit(piece);
      }
    }
  }

  if (!indices.length) {
    return null;
  }

  return {
    base: new Float32Array(base),
    heights: new Float32Array(heights),
    uvs: new Float32Array(uvs),
    indices: new Uint32Array(indices),
  };
}
