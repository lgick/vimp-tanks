// Сетка тайлов слоя карты: базовый масштаб, два перевода мир → клетка и
// выборка тайла. Общий модуль, потому что величины нужны и слою
// (`MapLayer`), и телу карты (`MapObject`): копия разбора `data.scale` уже
// жила в обоих.

// Базовый масштаб карты числами. Контейнеру его каждый кадр пересчитывает
// параллакс, поэтому в мировые единицы переводит именно БАЗОВЫЙ масштаб, а
// не текущий. `data.scale` приходит и числом, и парой.
export function baseScale(scale) {
  const x = typeof scale === 'number' ? scale : scale.x;
  const y = typeof scale === 'number' ? scale : scale.y;

  return { x, y };
}

// Клетка, ВНУТРИ которой лежит мировая точка: тайл под игроком, под срезом
// объёма. Полклетки влево — соседний тайл, поэтому пол, а не округление.
export function cellOfPoint(world, scale, step) {
  return Math.floor(world / scale / step);
}

// Клетка, на ГРАНИЦЕ которой стоит мировая координата: границы прогона
// рампы приходят из ядра по кромкам тайлов, и `col0..col1` — полуинтервал
// в клетках. Округление, а не пол: кромка `2 * step` — это клетка 2, а не
// 1 с точностью до float.
export function cellOfEdge(world, scale, step) {
  return Math.round(world / scale / step);
}

// Грид слоя как значение: двумерная карта тайлов, базовый масштаб и шаг.
// Им одним отвечают на вопрос «что нарисовано в этой мировой точке», и
// поэтому он ходит параметром, а не читается из полей парта.
export function tileGrid(map, scale, step) {
  return { map, scale, step };
}

// Есть ли в мировой точке тайл из набора `tiles`: набор тайлов слоя
// отвечает на вопрос «нарисован ли там объём», набор пола — «есть ли там
// плита». Позиция приходит в мировых единицах, а грид слоя не
// масштабирован, поэтому масштаб живёт ЗДЕСЬ.
export function tileAt(grid, worldX, worldY, tiles) {
  const col = cellOfPoint(worldX, grid.scale.x, grid.step);
  const row = cellOfPoint(worldY, grid.scale.y, grid.step);
  const tile = grid.map?.[row]?.[col];

  return tile !== undefined && tiles.has(tile);
}
