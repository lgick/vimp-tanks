import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import gameConfig from '../../src/config/game.js';

// Rust-тест core/tests/sim.rs грузит демо-карты через GameCore::load_map из
// сериализованной фикстуры: include_str! не умеет звать JS, поэтому карты
// лежат рядом копиями. Расхождение копии с модулем ловится здесь —
// обновляется она тем же сериализатором, что и dist/maps/*.json
// (scripts/export-maps.js).
describe('tests/core/fixtures/*.json', () => {
  it.each(['overpass', 'terraces', 'downtown'])('%s.json совпадает с модулем карты', name => {
    const fixture = JSON.parse(
      readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'),
    );

    expect(fixture).toEqual(JSON.parse(JSON.stringify(gameConfig.maps[name])));
  });

  // пресеты ботов продублированы в core/src/config.rs (default_bot_presets):
  // Rust-тест bot_rules_default_matches_game_js сверяет их с этой фикстурой
  it('bots.json совпадает с coreParams.bots', () => {
    const fixture = JSON.parse(
      readFileSync(new URL('./fixtures/bots.json', import.meta.url), 'utf8'),
    );

    expect(fixture).toEqual(JSON.parse(JSON.stringify(gameConfig.coreParams.bots)));
  });
});
