// Проекция 2.5D: объект на высоте h (в УРОВНЯХ) рисуется смещённым ОТ
// центра камеры — чем выше и чем дальше от центра экрана, тем сильнее.
// Ровно так читается высота в GTA 2. Формула одна на всех потребителей:
//
//   точка:     p' = p + (p - cam) * k
//   контейнер: тот же результат даёт масштаб (1 + k) вокруг центра камеры,
//              то есть p' = p * (1 + k) - cam * k
//
// k = высота в уровнях * shear (`src/config/render.js`, блок `parallax`).
//
// Разные знаки у разных потребителей — самая частая ошибка этой проекции:
// смещается ОБЪЕКТ, а его тень остаётся в мировой точке (см.
// Tank._updateShadow). Поэтому формулы больше нигде нет: её потребители —
// слой уровня N и его объём (`Map`), клин рампы, корпус танка, следы
// (`Tracks`) — зовут `offsetPoint`/`applyParallax`, а перенос ребёнка
// внутри контейнера в проекцию другой высоты (вспышка у дула выстрела с
// моста, осколки на склоне рампы) делает `reproject`.

// смещённая мировая точка. `camera` — центр камеры в мировых единицах
// (src/client/camera.js); null (парт ещё не на сцене) и k === 0 дают
// исходную точку
export function offsetPoint(x, y, camera, k) {
  if (!camera || !k) {
    return { x, y };
  }

  return {
    x: x + (x - camera.x) * k,
    y: y + (y - camera.y) * k,
  };
}

// тот же сдвиг трансформом контейнера: содержимое `target` авторится в
// единицах, которые `baseScale` переводит в мировые (у слоя карты это
// `data.scale`, у сущностей в мировых координатах — 1), а его родитель —
// сцена. Даёт для каждой точки содержимого ровно `offsetPoint`, без
// пересчёта единой вершины.
export function applyParallax(target, camera, k, baseScale = 1) {
  const scaleX = typeof baseScale === 'number' ? baseScale : baseScale.x;
  const scaleY = typeof baseScale === 'number' ? baseScale : baseScale.y;

  if (!camera || !k) {
    target.scale.set(scaleX, scaleY);
    target.position.set(0, 0);

    return;
  }

  target.scale.set(scaleX * (1 + k), scaleY * (1 + k));
  target.position.set(-camera.x * k, -camera.y * k);
}

// Перенос точки внутри контейнера, который уже стоит в проекции `kHost`
// (`applyParallax`): куда поставить ребёнка из мировой точки `(x, y)`,
// чтобы после трансформа контейнера он лёг в проекцию СВОЕЙ высоты `k`.
// Из cam + (q − cam)·(1 + kHost) = cam + (p − cam)·(1 + k):
//   q = cam + (p − cam)·(1 + k)/(1 + kHost),
// масштаб ребёнка — то же отношение. Без камеры (кадр без трансформа
// сцены: `applyParallax` сбросил контейнер в единичный) — исходная точка
// и масштаб 1
export function reproject(x, y, camera, kHost, k) {
  if (!camera) {
    return { x, y, scale: 1 };
  }

  const scale = (1 + (k || 0)) / (1 + (kHost || 0));

  return {
    x: camera.x + (x - camera.x) * scale,
    y: camera.y + (y - camera.y) * scale,
    scale,
  };
}
