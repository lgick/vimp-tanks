import { baseScale } from './parts/map/tileGrid.js';

// Сервис пула зависимостей `volumes`: высоты объёмов карты по клеткам уровней
// (стены зданий, канала, перила). Пишут статические слои `Map` (MapLayer —
// у него `data.volume` и грид), читают эффекты, которым нужно знать, где
// стоит видимая стена и какой она высоты (попадание выстрела в грань), и
// освещение. По экземпляру на ядро (hooks.services), как levelView.
//
// Тот же реестр читает сервис освещения (`levels()`, `version`): по нему
// строятся сетка препятствий фар и вершины объёмов в картах освещённости.
// Один реестр на оба потребителя — свет и выстрел видят одни и те же стены.
export function createVolumes() {
  // owner -> { level, cells, volume }
  const owners = new Map();
  let cellW = 0;
  let cellH = 0;
  // level -> Map('col,row' -> volume): пересобирается лениво после правок
  let grids = null;
  // level -> [{ cells, volume }] — вклады слоёв по уровням (освещение);
  // пересобирается лениво, как `grids`
  let byLevel = null;
  // номер правки реестра: по нему освещение видит, что вклады сменились
  let version = 0;

  const changed = () => {
    grids = null;
    byLevel = null;
    version += 1;
  };

  const build = () => {
    grids = new Map();

    for (const { level, cells, volume } of owners.values()) {
      if (!grids.has(level)) {
        grids.set(level, new Map());
      }

      const grid = grids.get(level);

      // несколько слоёв на клетке — выигрывает самый высокий объём
      for (const [col, row] of cells) {
        const key = `${col},${row}`;

        grid.set(key, Math.max(grid.get(key) || 0, volume));
      }
    }

    return grids;
  };

  return {
    // вклад слоя: клетки его тайлов и высота объёма в уровнях
    setLayerVolume(level, cells, volume, owner, { step, scale }) {
      const { x, y } = baseScale(scale ?? 1);

      cellW = step * x;
      cellH = step * y;
      owners.set(owner, { level: level || 0, cells, volume });
      changed();
    },

    release(owner) {
      if (owners.delete(owner)) {
        changed();
      }
    },

    // номер правки: растёт на каждом вкладе и снятии слоя
    get version() {
      return version;
    },

    // вклады по уровням: level -> [{ cells, volume }]. Сетка препятствий
    // фар и вершины объёмов карты освещённости (createLighting.js)
    levels() {
      if (!byLevel) {
        byLevel = new Map();

        for (const { level, cells, volume } of owners.values()) {
          if (!byLevel.has(level)) {
            byLevel.set(level, []);
          }

          byLevel.get(level).push({ cells, volume });
        }
      }

      return byLevel;
    },

    // высота объёма в мировой точке уровня; 0 — объёма нет
    heightAt(level, x, y) {
      if (!(cellW > 0 && cellH > 0)) {
        return 0;
      }

      const grid = (grids || build()).get(level || 0);

      if (!grid) {
        return 0;
      }

      return grid.get(`${Math.floor(x / cellW)},${Math.floor(y / cellH)}`) || 0;
    },

    cellSize() {
      return { cellW, cellH };
    },
  };
}
