import { describe, it, expect } from 'vitest';
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

// Демо-карта 2.5D: единственная в наборе, у которой есть `levels`/`ramps`.
// Проверяется то, что молчит в рантайме — карта с промахом по тайлу или с
// перекошенными респаунами грузится без единой строки в консоли.
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

  it('перила входят в floor уровня (иначе ядро отвергнет карту)', () => {
    for (const level of Object.values(overpass.levels)) {
      for (const wall of level.walls) {
        expect(level.floor).toContain(wall);
      }
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
