import { describe, it, expect } from 'vitest';
import MapRadar from '../../../src/client/parts/MapRadar.js';

// Радар получает по экземпляру на КАЖДЫЙ рендер-слой карты, а стены у слоёв
// одного уровня одни и те же: рисует их только тот слой, чьи тайлы в них и
// входят — иначе одна и та же графика дублируется N раз.
const layer = extra => ({
  map: [
    [1, 2],
    [2, 1],
  ],
  step: 10,
  scale: 1,
  ...extra,
});

describe('MapRadar: кто рисует стены', () => {
  it('слой со стенами рисует, слой без них — нет', () => {
    const walls = new MapRadar(layer({ tiles: [1], physicsStatic: [1] }));
    const decor = new MapRadar(layer({ tiles: [2], physicsStatic: [1] }));

    expect(walls._draws).toBe(true);
    expect(decor._draws).toBe(false);
  });

  it('слой уровня 1 берёт свои перила из solid и получает шаг zIndex', () => {
    const ground = new MapRadar(layer({ tiles: [1], physicsStatic: [1] }));
    const bridge = new MapRadar(
      layer({ tiles: [1], physicsStatic: [], solid: [1], level: 1 }),
    );

    expect(ground.zIndex).toBe(2);
    expect(bridge.zIndex).toBe(102);
    expect(bridge._draws).toBe(true);
  });
});
