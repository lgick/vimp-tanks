import { describe, it, expect } from 'vitest';
import gameConfig from '../../src/config/game.js';
import { surfaceFx } from '../../src/config/render.js';

// Поверхности считаются в ДВУХ местах: скольжение по маслу и импульс бустера
// считает ядро по coreParams.surfaces (WASM), шлейф масляных следов и
// вспышку бустера — клиентский рендер по `surfaceFx`. Общего источника у них
// нет (движок конфига партам не отдаёт), поэтому числа обязаны совпадать —
// иначе следы кончатся раньше скольжения или вспышка сработает без импульса.
// До этого теста связь держалась на перекрёстных комментариях.
describe('поверхности: game.js ↔ render.js', () => {
  const types = gameConfig.coreParams.surfaces.types;

  it('шлейф масляных следов длится столько же, сколько остаток масла в ядре', () => {
    expect(surfaceFx.tracks.oil.trail).toBe(types.oil.slickTime);
  });

  it('порог вспышки бустера совпадает с порогом ядра', () => {
    expect(surfaceFx.boost.boostMinSpeed).toBe(types.boost.minEntrySpeed);
  });
});
