import { offsetPoint } from '../parallax.js';
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
