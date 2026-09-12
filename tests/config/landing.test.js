import { describe, it, expect } from 'vitest';
import gameConfig from '../../src/config/game.js';
import { landing } from '../../src/config/render.js';

// Приземление считается в ДВУХ местах: тряску камеры считает ядро по
// coreParams.levels.landingShake (WASM), просадку/пыль/звук — клиентский
// рендер по `landing`. Общего источника у них нет (движок конфига партам
// не отдаёт), поэтому пороги обязаны совпадать численно — иначе камера
// тряхнётся без пыли или наоборот. До этого теста связь держалась на
// перекрёстных комментариях в обоих файлах.
describe('пороги приземления: game.js ↔ render.js', () => {
  const shake = gameConfig.coreParams.levels.landingShake;

  it('minImpact совпадает', () => {
    expect(shake.minImpact).toBe(landing.minImpact);
  });

  it('fullImpact совпадает', () => {
    expect(shake.fullImpact).toBe(landing.fullImpact);
  });

  it('шкала не вырождена', () => {
    expect(shake.fullImpact).toBeGreaterThan(shake.minImpact);
  });
});
