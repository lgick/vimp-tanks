import { baseScale } from './parts/map/tileGrid.js';

// Сервис пула зависимостей `volumes`: высоты объёмов карты по клеткам уровней
// (стены зданий, канала, перила). Пишут статические слои `Map` (MapLayer —
// у него `data.volume` и грид), читают эффекты, которым нужно знать, где
// стоит видимая стена и какой она высоты (попадание выстрела в грань).
// По экземпляру на ядро (hooks.services), как levelView.
//
// Сервис освещения держит те же данные в своих `tops` (`setVolumeTops`).
// Дубль осознанный: объединить их (освещение читает `volumes`) — кандидат
// разделения `createLighting.js` на модули
export function createVolumes() {
  // owner -> { level, cells, volume }
  const owners = new Map();
  let cellW = 0;
  let cellH = 0;
  // level -> Map('col,row' -> volume): пересобирается лениво после правок
  let grids = null;

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
      grids = null;
    },

    release(owner) {
      if (owners.delete(owner)) {
        grids = null;
      }
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
