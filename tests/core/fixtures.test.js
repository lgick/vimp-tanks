import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import gameConfig from '../../src/config/game.js';

// Rust-тест core/tests/sim.rs грузит overpass через GameCore::load_map из
// сериализованной фикстуры: include_str! не умеет звать JS, поэтому карта
// лежит рядом копией. Расхождение копии с модулем ловится здесь —
// обновляется она тем же сериализатором, что и dist/maps/*.json
// (scripts/export-maps.js).
describe('tests/core/fixtures/overpass.json', () => {
  it('совпадает с src/data/maps/overpass.js', () => {
    const fixture = JSON.parse(
      readFileSync(new URL('./fixtures/overpass.json', import.meta.url), 'utf8'),
    );

    expect(fixture).toEqual(JSON.parse(JSON.stringify(gameConfig.maps.overpass)));
  });
});
