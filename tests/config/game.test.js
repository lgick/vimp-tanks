import { describe, it, expect } from 'vitest';
import { rules } from 'vimp-engine/devtools/contract/rules/index.js';
import { FAIL } from 'vimp-engine/devtools/contract/result.js';
import gameConfig from '../../src/config/game.js';

// Страховка от рассинхрона имён между GameManifest.roomForm и roomDefaults
// (build-game-manifest.js собирает roomDefaults из этих же 5 ключей).
describe('gameConfig.roomForm (src/config/game.js)', () => {
  const roomDefaultsKeys = ['maxPlayers', 'roundTime', 'mapTime', 'friendlyFire', 'map'];

  it('содержит ровно 5 полей', () => {
    expect(gameConfig.roomForm).toHaveLength(5);
  });

  it('name каждого поля совпадает с ключом roomDefaults манифеста (без учёта порядка)', () => {
    const names = gameConfig.roomForm.map(field => field.name);

    expect(new Set(names)).toEqual(new Set(roomDefaultsKeys));
  });

  it('каждое поле задаёт control', () => {
    for (const field of gameConfig.roomForm) {
      expect(typeof field.control).toBe('string');
    }
  });
});

// coreParams едет в игровую половину init-JSON ядра как есть
// (vimp-engine/lib/coreConfig.js) — ядро читает из него правила уровней.
describe('gameConfig.coreParams.levels (2.5D)', () => {
  const { levels } = gameConfig.coreParams;

  it('задаёт правила падения', () => {
    expect(typeof levels.fallTime).toBe('number');
    expect(levels.fallTime).toBeGreaterThan(0);
    expect(typeof levels.fallDamage).toBe('number');
    expect(levels.fallDamage).toBeGreaterThanOrEqual(0);
  });

  it('не перекрывает известные движку ключи игровой половины', () => {
    const reserved = ['friendlyFire', 'models', 'weapons', 'playerKeys', 'panel'];

    for (const key of Object.keys(gameConfig.coreParams)) {
      expect(reserved).not.toContain(key);
    }
  });
});

// Правила карт живут в движке (контрактный чекер, `npx vimp-contract`), и
// ровно они же — в ядре (`MapConfig::validate`). Гонять их здесь, а не
// повторять руками: ручная копия проверяет меньше и расходится молча.
describe('карты проходят правила движка (E4/E5)', () => {
  const run = id => rules.find(rule => rule.id === id).check({ gameConfig });

  it.each(['E4', 'E5'])('%s', id => {
    const result = run(id);

    expect(result.violations).toEqual([]);
    expect(result.status).not.toBe(FAIL);
  });

  it('правила действительно смотрят на карты, а не пропускаются', () => {
    expect(run('E4').status).not.toBe('skip');
    expect(run('E5').status).not.toBe('skip');
  });
});

// Демо-карта 2.5D: единственная в наборе, у которой есть `levels`/`ramps`.
// Здесь остаётся то, чего правила движка не знают: тайл-лист карты и
// раскладка респаунов по командам.
describe('карта overpass (src/data/maps/overpass.js)', () => {
  const overpass = gameConfig.maps.overpass;

  it('зарегистрирована в maps', () => {
    expect(overpass).toBeDefined();
    expect(overpass.levels).toBeDefined();
    expect(overpass.ramps.length).toBeGreaterThan(0);
  });

  it('каждый тайл есть в spriteSheet.frames', () => {
    const frames = overpass.spriteSheet.frames.length;
    const used = new Set();

    for (const row of overpass.map) {
      for (const tile of row) {
        used.add(tile);
      }
    }

    // на уровнях выше нулевого 0 — не тайл, а пустота (уровня здесь нет)
    for (const level of Object.values(overpass.levels)) {
      for (const row of level.map) {
        for (const tile of row) {
          if (tile !== 0) {
            used.add(tile);
          }
        }
      }
    }

    for (const tile of used) {
      expect(tile).toBeLessThan(frames);
    }
  });

  it('каждая команда имеет одинаковое число респаунов', () => {
    const counts = Object.values(overpass.respawns).map(list => list.length);

    expect(new Set(counts).size).toBe(1);
  });

  it('наземные точки респауна не стоят под плитой', () => {
    const level1 = overpass.levels[1];
    const floor = level1.floor;
    const size = overpass.step;

    for (const list of Object.values(overpass.respawns)) {
      for (const [x, y, , level] of list) {
        if (level !== undefined) {
          continue;
        }

        const tile = level1.map[Math.floor(y / size)][Math.floor(x / size)];

        expect(floor).not.toContain(tile);
      }
    }
  });
});

// Демо-карта на три уровня. Правила движка (E4/E5) знают о ней структуру;
// здесь — то, чего они не знают: тайл-лист, раскладка респаунов по уровням и
// разная крутизна прогонов, ради которой карта и заведена.
describe('карта terraces (src/data/maps/terraces.js)', () => {
  const terraces = gameConfig.maps.terraces;

  const levelGrid = level =>
    level === 0 ? terraces.map : terraces.levels[level].map;

  // клетки прогона рампы в гриде её нижнего уровня
  const rampCells = ramp => {
    const cells = [];

    levelGrid(ramp.from).forEach((row, y) => {
      row.forEach((tile, x) => {
        if (tile === ramp.tile) {
          cells.push([x, y]);
        }
      });
    });

    return cells;
  };

  it('зарегистрирована в maps и объявляет три уровня', () => {
    expect(terraces).toBeDefined();
    expect(Object.keys(terraces.levels)).toEqual(['1', '2']);
  });

  it('каждый тайл есть в spriteSheet.frames', () => {
    const frames = terraces.spriteSheet.frames.length;
    const used = new Set();

    for (const row of terraces.map) {
      for (const tile of row) {
        used.add(tile);
      }
    }

    // на уровнях выше нулевого 0 — не тайл, а пустота (уровня здесь нет)
    for (const level of Object.values(terraces.levels)) {
      for (const row of level.map) {
        for (const tile of row) {
          if (tile !== 0) {
            used.add(tile);
          }
        }
      }
    }

    for (const tile of used) {
      expect(tile).toBeLessThan(frames);
    }
  });

  it('есть прогон 0 → 2 и ступенчатый путь 0 → 1 → 2', () => {
    const pairs = terraces.ramps.map(ramp => `${ramp.from}->${ramp.to}`);

    expect(pairs).toContain('0->2');
    expect(pairs).toContain('0->1');
    expect(pairs).toContain('1->2');
  });

  it('прогоны разной крутизны: перепад на клетку отличается втрое', () => {
    const grades = terraces.ramps.map(
      ramp => Math.abs(ramp.to - ramp.from) / rampCells(ramp).length,
    );

    expect(Math.max(...grades)).toBeGreaterThan(Math.min(...grades) * 3);
  });

  it('каждая команда имеет одинаковое число респаунов', () => {
    const counts = Object.values(terraces.respawns).map(list => list.length);

    expect(new Set(counts).size).toBe(1);
  });

  it('у каждой команды есть точки на всех трёх уровнях', () => {
    const size = terraces.step;

    for (const list of Object.values(terraces.respawns)) {
      const levels = new Set();

      for (const [x, y, , level] of list) {
        if (level !== undefined) {
          levels.add(level);
          continue;
        }

        // без явного уровня его даёт геометрия: наземная точка не имеет
        // права стоять под плитой — иначе танк уедет наверх
        for (const [key, config] of Object.entries(terraces.levels)) {
          const tile = config.map[Math.floor(y / size)][Math.floor(x / size)];

          expect(config.floor, `точка под плитой уровня ${key}`).not.toContain(
            tile,
          );
        }

        levels.add(0);
      }

      expect(levels).toEqual(new Set([0, 1, 2]));
    }
  });
});
