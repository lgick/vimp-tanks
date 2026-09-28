// Высоты стен карты для ядра: уровень → тайл → высота объёма в уровнях.
// Выводятся из тех же рендер-слоёв (`layers`: слой → тайлы) и их объёмов
// (`volumes`: слой → высота), по которым клиент рисует объёмы
// (src/client/volumes.js), — у уровня 0 и у каждого `levels[N]`. Движок
// `layers`/`volumes` хосту не передаёт (`GameMap` их не хранит), поэтому
// высоты едут в игровом поле карты `game.wallHeights`
// (core/src/map_game.rs). Тайл в нескольких слоях — самый высокий объём,
// как у `volumes.js`
export function wallHeightsOf(map) {
  const out = {};
  const add = (level, layers = {}, volumes = {}) => {
    for (const [layer, height] of Object.entries(volumes)) {
      for (const tile of layers[layer] || []) {
        const heights = (out[level] ??= {});

        heights[tile] = Math.max(heights[tile] ?? 0, height);
      }
    }
  };

  add('0', map.layers, map.volumes);

  for (const [level, config] of Object.entries(map.levels || {})) {
    add(String(level), config.layers, config.volumes);
  }

  return out;
}

// Карта с `game.wallHeights`; прочие поля `game` сохраняются. Карта без
// объёмов остаётся как есть: стена без высоты для пули бесконечно
// высокая (`MapGame::wall_height`)
export function withWallHeights(map) {
  const wallHeights = wallHeightsOf(map);

  if (Object.keys(wallHeights).length === 0) {
    return map;
  }

  return { ...map, game: { ...map.game, wallHeights } };
}
