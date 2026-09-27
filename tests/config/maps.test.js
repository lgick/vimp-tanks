import { describe, it, expect, vi, afterEach } from 'vitest';
import maps from '../../src/data/maps/index.js';
import { isRoofLayer } from '../../src/client/parts/map/MapLayer.js';

// Поле карты `game.roofs` не знает ни ядро (map_game.rs), ни валидатор: ошибка
// в нём видна только по console.warn в рантайме или по поведению в браузере.
// Правило «слой-крыша» не дублируется здесь, а берётся из MapLayer
const withRoofs = Object.entries(maps).filter(([, map]) => map.game?.roofs);

afterEach(() => {
  vi.restoreAllMocks();
});

describe.each(withRoofs)('крыши карты %s (game.roofs)', (name, map) => {
  const entries = Object.entries(map.game.roofs);

  it.each(entries)('уровень %s существует и не нулевой', level => {
    expect(Number(level)).toBeGreaterThanOrEqual(1);
    expect(map.levels?.[level]).toBeDefined();
  });

  it.each(entries)(
    'тайлы крыш уровня %s входят в его floor',
    (level, roofs) => {
      const floor = map.levels[level].floor;

      for (const tile of roofs) {
        expect(floor).toContain(tile);
      }
    },
  );

  it.each(entries)(
    'рендер-слой уровня %s с тайлом крыши — крыша целиком',
    (level, roofs) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const layers = Object.values(map.levels[level].layers);
      const withRoof = layers.filter(tiles =>
        tiles.some(tile => roofs.includes(tile)),
      );

      expect(withRoof.length).toBeGreaterThan(0);

      for (const tiles of withRoof) {
        expect(isRoofLayer(map.game, Number(level), tiles)).toBe(true);
      }

      expect(warn).not.toHaveBeenCalled();
    },
  );

  it('каждая вывеска и декаль на уровне с крышами стоит на слое крыши, если её клетка — крыша', () => {
    const items = [...(map.game.signs ?? []), ...(map.game.decals ?? [])];

    for (const item of items) {
      const roofs = map.game.roofs[item.level];

      if (!roofs || !item.cell) {
        continue;
      }

      const level = map.levels[item.level];
      const [col, row] = item.cell;
      const tile = level.map[row]?.[col];

      if (!roofs.includes(tile)) {
        continue;
      }

      const roofLayers = Object.entries(level.layers)
        .filter(([, tiles]) => tiles.includes(tile))
        .map(([layer]) => Number(layer));

      expect(roofLayers).toContain(Number(item.layer));
    }
  });
});
