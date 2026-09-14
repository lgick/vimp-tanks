import { describe, it, expect } from 'vitest';
import { rules } from 'vimp-engine/devtools/contract/rules/index.js';
import { FAIL } from 'vimp-engine/devtools/contract/result.js';
import gameConfig from '../../src/config/game.js';
import { LIGHT_OVERLAY_BASE_Z } from '../../src/client/lighting/lightMath.js';

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

  it('штатный прыжок не долетает до jumpClearance', () => {
    // инвариант настройки, а не комментария: максимальная дуга
    // `maxLaunchVz² / (2g)` при `g = 2 / fallTime²` обязана быть ниже
    // порога, на котором танк перестаёт видеть стены, — иначе прыжок с
    // рампы перелетает заборы и периметр карты
    const g = 2 / (levels.fallTime * levels.fallTime);
    const peak = (levels.maxLaunchVz * levels.maxLaunchVz) / (2 * g);

    expect(levels.maxLaunchVz).toBeGreaterThan(0);
    expect(peak).toBeLessThan(levels.jumpClearance);
  });

  it('мёртвая зона урона падения покрывает максимальную дугу прыжка', () => {
    // подскок с рампы возвращает танк на ту же плиту и стоить HP не обязан
    const g = 2 / (levels.fallTime * levels.fallTime);
    const peak = (levels.maxLaunchVz * levels.maxLaunchVz) / (2 * g);

    expect(peak).toBeLessThanOrEqual(levels.fallDamageFreeHeight);
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

// Поверхности (`game.surfaces`): тайл, размеченный на уровне, обязан стоять в
// сетке этого уровня — иначе разметка молча ничего не делает (ядро проверяет
// только, что тайл не стена и не рампа).
function surfaceViolations(map) {
  const violations = [];

  for (const [level, surfaces] of Object.entries(map.game?.surfaces || {})) {
    const grid = Number(level) === 0 ? map.map : map.levels?.[level]?.map;
    const present = new Set((grid || []).flat());

    for (const tile of Object.keys(surfaces)) {
      if (!present.has(Number(tile))) {
        violations.push(`поверхность ${tile} уровня ${level} не стоит в его сетке`);
      }
    }
  }

  return violations;
}

describe('поверхности карт (game.surfaces)', () => {
  const surfacedMaps = Object.entries(gameConfig.maps).filter(
    ([, map]) => map.game?.surfaces,
  );

  it('в наборе есть карта с поверхностями', () => {
    expect(surfacedMaps.length).toBeGreaterThan(0);
  });

  it.each(surfacedMaps)('%s: каждый тайл поверхности стоит в сетке своего уровня', (name, map) => {
    expect(surfaceViolations(map)).toEqual([]);
  });

  it('правило ловит тайл, которого нет в сетке уровня', () => {
    const map = {
      map: [[1, 4]],
      levels: { 1: { map: [[0, 5]] } },
      game: { surfaces: { 0: { 4: 'sand', 7: 'oil' }, 1: { 7: 'oil' } } },
    };

    expect(surfaceViolations(map)).toEqual([
      'поверхность 7 уровня 0 не стоит в его сетке',
      'поверхность 7 уровня 1 не стоит в его сетке',
    ]);
  });
});

// Ночной город — эталон `game`-полей. Правила движка (E4/E5) и общие правила
// ниже знают его структуру; здесь — тайл-лист, респауны, пропы и фонари.
describe('карта downtown (src/data/maps/downtown.js)', () => {
  const downtown = gameConfig.maps.downtown;
  const level1 = downtown?.levels?.[1];

  it('зарегистрирована в maps: два уровня, сетка 96 × 72', () => {
    expect(downtown).toBeDefined();
    expect(Object.keys(downtown.levels)).toEqual(['1']);
    expect(downtown.map).toHaveLength(72);
    expect(downtown.map[0]).toHaveLength(96);
  });

  it('каждый тайл есть в spriteSheet.frames, тайл 0 не стоит нигде', () => {
    const frames = downtown.spriteSheet.frames.length;
    const ground = new Set(downtown.map.flat());
    const upper = new Set(level1.map.flat());

    expect(ground.has(0)).toBe(false);

    upper.delete(0);

    for (const tile of [...ground, ...upper]) {
      expect(tile).toBeGreaterThan(0);
      expect(tile).toBeLessThan(frames);
    }
  });

  it('периметр замкнут стенами', () => {
    const { map } = downtown;
    const wall = tile => downtown.physicsStatic.includes(tile);
    const last = map.length - 1;

    expect(map[0].every(wall)).toBe(true);
    expect(map[last].every(wall)).toBe(true);
    expect(map.every(row => wall(row[0]) && wall(row[row.length - 1]))).toBe(true);
  });

  it('по 8 наземных респаунов на команду с явным уровнем 0, не под плитой', () => {
    const size = downtown.step;

    expect(Object.keys(downtown.respawns)).toEqual(['team1', 'team2']);

    for (const list of Object.values(downtown.respawns)) {
      expect(list.length).toBeGreaterThanOrEqual(gameConfig.roomDefaults.maxPlayers / 2);
      expect(list).toHaveLength(8);

      for (const [x, y, , level] of list) {
        const col = Math.floor(x / size);
        const row = Math.floor(y / size);

        expect(level).toBe(0);
        expect(level1.floor).not.toContain(level1.map[row][col]);
        expect(downtown.physicsStatic).not.toContain(downtown.map[row][col]);
      }
    }
  });

  it('пропы: не больше 60 тел, у каждого известный тип и картинка', () => {
    const { props } = gameConfig.coreParams;

    expect(downtown.physicsDynamic.length).toBeLessThanOrEqual(60);

    for (const body of downtown.physicsDynamic) {
      expect(Object.keys(props)).toContain(body.game.prop);
      expect(typeof body.img).toBe('string');
    }

    for (const prop of ['fence', 'crate', 'barrel']) {
      expect(downtown.physicsDynamic.some(body => body.game.prop === prop)).toBe(true);
    }
  });

  it('тело на плите объявляет level 1, тело на земле — не под плитой', () => {
    const size = downtown.step;

    for (const body of downtown.physicsDynamic) {
      const col = Math.floor((body.position[0] + body.width / 2) / size);
      const row = Math.floor((body.position[1] + body.height / 2) / size);
      const onSlab = level1.floor.includes(level1.map[row][col]);

      expect(body.level ?? 0).toBe(onSlab ? 1 : 0);
    }
  });

  it('фонарь уровня 0 не стоит под плитой, фонарь уровня 1 — на плите', () => {
    for (const { cell, level } of downtown.game.lighting.lamps) {
      const tile = level1.map[cell[1]][cell[0]];

      if (level === 1) {
        expect(level1.floor).toContain(tile);
      } else {
        expect(level1.floor).not.toContain(tile);
      }
    }
  });

  it('все механики на месте: поверхности, ночь, анимации, вывески, декали', () => {
    const { game } = downtown;
    const types = new Set(
      Object.values(game.surfaces[0]).map(entry =>
        typeof entry === 'string' ? entry : entry.type,
      ),
    );

    expect(types).toEqual(new Set(['sand', 'mud', 'water', 'oil', 'conveyor', 'boost']));
    expect(game.surfaces[1]).toBeDefined();
    expect(game.lighting.night).toBe(true);
    expect(Object.keys(game.animatedTiles).length).toBeGreaterThan(0);
    expect(game.signs.length).toBeGreaterThanOrEqual(3);
    expect(game.decals.length).toBeGreaterThan(0);
  });
});

// Ночные карты (`game.lighting.night`): карта освещённости уровня лежит на
// базе zIndex LIGHT_OVERLAY_BASE_Z, и слой карты на этой базе или выше
// затемнился бы не по уровню. Фонарь обязан стоять в пределах сетки и на
// существующем уровне.
function nightMapViolations(map) {
  const violations = [];
  const rows = map.map.length;
  const cols = map.map[0].length;
  const layerSets = [['0', map.layers || {}]];

  for (const [key, level] of Object.entries(map.levels || {})) {
    layerSets.push([key, level.layers || {}]);
  }

  for (const [level, layers] of layerSets) {
    for (const layer of Object.keys(layers)) {
      if (Number(layer) >= LIGHT_OVERLAY_BASE_Z) {
        violations.push(`слой ${layer} уровня ${level} >= ${LIGHT_OVERLAY_BASE_Z}`);
      }
    }
  }

  const levels = new Set([0, ...Object.keys(map.levels || {}).map(Number)]);

  (map.game.lighting.lamps || []).forEach((lamp, index) => {
    const [col, row] = lamp.cell || [];

    if (!(col >= 0 && col < cols && row >= 0 && row < rows)) {
      violations.push(`фонарь ${index} вне сетки`);
    }

    if (!levels.has(lamp.level || 0)) {
      violations.push(`фонарь ${index} на несуществующем уровне ${lamp.level}`);
    }
  });

  return violations;
}

describe('ночные карты (game.lighting)', () => {
  // фикстура: правила проверяются, даже пока в наборе нет ночной карты
  const fixture = {
    map: [
      [1, 1, 1],
      [1, 1, 1],
    ],
    layers: { 1: [1], 2: [2] },
    levels: { 1: { map: [[0, 5, 0], [0, 0, 0]], floor: [5], layers: { 4: [5] } } },
    game: {
      lighting: {
        night: true,
        lamps: [
          { cell: [2, 1], level: 0 },
          { cell: [1, 0], level: 1 },
        ],
      },
    },
  };

  const nightMaps = Object.entries(gameConfig.maps).filter(
    ([, map]) => map.game?.lighting?.night,
  );

  it.each([...nightMaps, ['фикстура', fixture]])('%s: слои < 40, фонари на сетке', (name, map) => {
    expect(nightMapViolations(map)).toEqual([]);
  });

  it('правило ловит слой с базой >= 40 и фонарь вне сетки', () => {
    const bad = {
      ...fixture,
      layers: { 1: [1], 40: [2] },
      game: { lighting: { night: true, lamps: [{ cell: [3, 0] }, { cell: [0, 0], level: 2 }] } },
    };

    expect(nightMapViolations(bad)).toEqual([
      'слой 40 уровня 0 >= 40',
      'фонарь 0 вне сетки',
      'фонарь 1 на несуществующем уровне 2',
    ]);
  });
});

// Анимированные элементы карты (`game.animatedTiles`, `signs`, `decals`):
// у описания ровно одно из fps/speed, кадры есть в тайл-листе, лента
// конвейера и его шевроны идут с одной скоростью, а вывески и декали стоят
// на существующих (level, layer).
function animationViolations(map, types) {
  const violations = [];
  const game = map.game || {};
  const frames = map.spriteSheet?.frames?.length || 0;
  const defs = game.animatedTiles || {};

  const layersOf = level =>
    level === 0 ? map.layers || {} : map.levels?.[level]?.layers || {};

  for (const [id, def] of Object.entries(defs)) {
    if ((def.fps === undefined) === (def.speed === undefined)) {
      violations.push(`тайл ${id}: нужно ровно одно из fps и speed`);
    }

    for (const frame of def.frames || []) {
      if (!(frame >= 0 && frame < frames)) {
        violations.push(`тайл ${id}: кадра ${frame} нет в spriteSheet.frames`);
      }
    }
  }

  const beltTiles = new Set();

  for (const surfaces of Object.values(game.surfaces || {})) {
    for (const [id, entry] of Object.entries(surfaces)) {
      const type = typeof entry === 'string' ? entry : entry.type;
      const belt = types[type]?.belt;

      if (belt === undefined) {
        continue;
      }

      beltTiles.add(id);

      if (defs[id]?.speed !== belt) {
        violations.push(`конвейер ${id}: animatedTiles.speed обязан быть ${belt}`);
      }
    }
  }

  for (const [id, def] of Object.entries(defs)) {
    if (def.speed !== undefined && !beltTiles.has(id)) {
      violations.push(`тайл ${id}: speed без конвейерной поверхности`);
    }
  }

  for (const [kind, items] of [
    ['вывеска', game.signs || []],
    ['декаль', game.decals || []],
  ]) {
    items.forEach((item, index) => {
      const level = item.level || 0;

      if (!(String(item.layer) in layersOf(level))) {
        violations.push(`${kind} ${index}: слоя ${item.layer} уровня ${level} нет`);
      }
    });
  }

  return violations;
}

describe('анимированные элементы карт (game.animatedTiles/signs/decals)', () => {
  const { types } = gameConfig.coreParams.surfaces;

  const fixture = {
    map: [[1, 45, 43]],
    spriteSheet: { frames: Array.from({ length: 80 }, () => [0, 0, 32, 32]) },
    layers: { 1: [1, 43, 45] },
    levels: { 1: { map: [[0, 5, 0]], floor: [5], layers: { 2: [5] } } },
    game: {
      surfaces: { 0: { 45: { type: 'conveyor', dir: 'east' } } },
      animatedTiles: {
        45: { kind: 'frames', frames: [45, 60, 61, 62], speed: types.conveyor.belt },
        43: { kind: 'frames', frames: [43, 63, 64, 65], fps: 4 },
      },
      signs: [{ cell: [1, 0], level: 1, layer: 2, text: 'HOTEL', size: 18 }],
      decals: [{ cell: [0, 0], level: 0, layer: 1, frame: 70, kind: 'rotate', rps: 1.5 }],
    },
  };

  const animatedMaps = Object.entries(gameConfig.maps).filter(
    ([, map]) => map.game?.animatedTiles || map.game?.signs || map.game?.decals,
  );

  it.each([...animatedMaps, ['фикстура', fixture]])('%s: правила анимаций', (name, map) => {
    expect(animationViolations(map, types)).toEqual([]);
  });

  it('у каждого конвейерного тайла — описание с его belt (в том числе без описания)', () => {
    const bare = { ...fixture, game: { ...fixture.game, animatedTiles: {} } };

    expect(animationViolations(bare, types)).toEqual([
      `конвейер 45: animatedTiles.speed обязан быть ${types.conveyor.belt}`,
    ]);
  });

  it('правило ловит fps вместе со speed, чужую скорость, пропавший кадр и слой', () => {
    const bad = {
      ...fixture,
      game: {
        ...fixture.game,
        animatedTiles: {
          45: { kind: 'frames', frames: [45, 99], speed: 1, fps: 4 },
          43: { kind: 'frames', frames: [43], speed: 10 },
        },
        signs: [{ cell: [1, 0], level: 1, layer: 1, text: 'X', size: 10 }],
        decals: [{ cell: [0, 0], level: 2, layer: 1, frame: 70, kind: 'rotate' }],
      },
    };

    expect(animationViolations(bad, types)).toEqual([
      'тайл 45: нужно ровно одно из fps и speed',
      'тайл 45: кадра 99 нет в spriteSheet.frames',
      `конвейер 45: animatedTiles.speed обязан быть ${types.conveyor.belt}`,
      'тайл 43: speed без конвейерной поверхности',
      'вывеска 0: слоя 1 уровня 1 нет',
      'декаль 0: слоя 1 уровня 2 нет',
    ]);
  });
});
