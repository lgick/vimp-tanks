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

// Закрывает ли набор клеток, нарисованный на высотах `ks`, нарисованную
// точку `point` с запасом `margin` (мировые единицы). Срез на высоте k
// рисует мировую точку w в `w + (w - cam) * k`, поэтому исходная точка
// считается обратной формулой `w = (p + cam * k) / (1 + k)`. Проверяются
// центр и при `margin > 0` ещё 4 точки по кругу: крыша начинает уступать
// до того, как край корпуса въедет под неё. `test(worldX, worldY)` —
// «есть ли в мировой точке клетка набора»
function covers(test, point, camera, ks, margin) {
  if (!camera || !point) {
    return false;
  }

  const offsets = margin > 0
    ? [[0, 0], [margin, 0], [-margin, 0], [0, margin], [0, -margin]]
    : [[0, 0]];

  for (const k of ks) {
    const scale = 1 + k;

    for (const [dx, dy] of offsets) {
      if (
        test(
          (point.x + dx + camera.x * k) / scale,
          (point.y + dy + camera.y * k) / scale,
        )
      ) {
        return true;
      }
    }
  }

  return false;
}

// вариант по гриду слоя и набору его тайлов (см. `tileAt`)
export function coversPoint(grid, tileSet, point, camera, ks, margin) {
  if (!grid?.map) {
    return false;
  }

  return covers(
    (x, y) => tileAt(grid, x, y, tileSet),
    point,
    camera,
    ks,
    margin,
  );
}

// вариант по набору клеток `Set('col,row')`: у сервиса освещения нет грида
// слоя, только объединённые клетки масок
export function cellsCoverPoint(cellSet, step, scale, point, camera, ks, margin) {
  if (!cellSet || cellSet.size === 0) {
    return false;
  }

  return covers(
    (x, y) =>
      cellSet.has(
        `${cellOfPoint(x, scale.x, step)},${cellOfPoint(y, scale.y, step)}`,
      ),
    point,
    camera,
    ks,
    margin,
  );
}
