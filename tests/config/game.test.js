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
