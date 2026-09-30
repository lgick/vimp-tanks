import { describe, it, expect } from 'vitest';
import { Texture } from 'pixi.js';
import PuffEffect, {
  puffState,
  rollPuffs,
} from '../../../../src/client/parts/effects/shot/PuffEffect.js';
import { impactSmoke } from '../../../../src/config/render.js';

// Клуб дыма разрыва снаряда: клубы летят из точки попадания к стрелку,
// тормозят, растут и тают.

const fixed = value => () => value;
const assets = { smokeTexture: { texture: Texture.EMPTY, contentSize: 8 } };

describe('rollPuffs', () => {
  it('клубов — count, направление в пределах разброса вокруг dir', () => {
    for (const value of [0, 0.5, 0.99]) {
      const puffs = rollPuffs(impactSmoke, -1, 0, fixed(value));

      expect(puffs).toHaveLength(impactSmoke.count);

      for (const { vx, vy, size, lifetime, color } of puffs) {
        const angle = Math.atan2(vy, vx);
        // отклонение от направления (−1, 0), то есть от угла π
        const off = Math.abs(Math.abs(angle) - Math.PI);
        const speed = Math.hypot(vx, vy);

        expect(off).toBeLessThanOrEqual(impactSmoke.spread + 1e-9);
        expect(speed).toBeGreaterThanOrEqual(impactSmoke.speed.min - 1e-9);
        expect(speed).toBeLessThanOrEqual(impactSmoke.speed.max + 1e-9);
        expect(size).toBeGreaterThanOrEqual(impactSmoke.size.min);
        expect(lifetime).toBeLessThanOrEqual(impactSmoke.lifetime.max);
        expect(impactSmoke.colors).toContain(color);
      }
    }
  });

  it('count 0 — клубов нет', () => {
    expect(rollPuffs({ ...impactSmoke, count: 0 }, 1, 0)).toEqual([]);
  });
});

describe('puffState', () => {
  const puff = { vx: 20, vy: 0, size: 4, lifetime: 800, color: 0 };

  it('в начале — в точке разрыва, стартового размера и полной яркости', () => {
    expect(puffState(puff, 0, impactSmoke)).toEqual({
      x: 0,
      y: 0,
      size: 4,
      alpha: impactSmoke.alpha,
    });
  });

  it('тормозит: путь не длиннее v / drag', () => {
    const early = puffState(puff, 200, impactSmoke);
    const late = puffState(puff, 790, impactSmoke);

    expect(early.x).toBeGreaterThan(0);
    expect(late.x).toBeGreaterThan(early.x);
    expect(late.x).toBeLessThan(puff.vx / impactSmoke.drag);
    // вторая половина пути короче первой — скорость падает
    expect(late.x - early.x).toBeLessThan(early.x * (590 / 200));
  });

  it('растёт к grow размера и тает к нулю, после lifetime — null', () => {
    const end = puffState(puff, 799, impactSmoke);

    expect(end.size).toBeCloseTo(puff.size * impactSmoke.grow, 1);
    expect(end.alpha).toBeLessThan(0.001);
    expect(puffState(puff, 800, impactSmoke)).toBeNull();
  });
});

describe('PuffEffect', () => {
  it('спрайт на клуб, завершается по самому долгому клубу', () => {
    let done = false;
    const effect = new PuffEffect(
      5,
      6,
      1,
      0,
      () => {
        done = true;
      },
      assets,
      impactSmoke,
      fixed(0.5),
    );

    expect(effect.x).toBe(5);
    expect(effect.y).toBe(6);
    expect(effect.sprites).toHaveLength(impactSmoke.count);

    effect._update(100);
    expect(done).toBe(false);
    expect(effect.sprites[0].x).toBeGreaterThan(0);
    expect(effect.sprites[0].alpha).toBeLessThan(impactSmoke.alpha);

    effect._update(impactSmoke.lifetime.max);
    expect(done).toBe(true);
    expect(effect.sprites.every(sprite => !sprite.visible)).toBe(true);
  });

  // поворот клуба — из внедрённого rng, а не из Math.random: эффект
  // детерминирован в тестах
  it('поворот спрайтов берётся из rng', () => {
    const effect = new PuffEffect(
      0,
      0,
      1,
      0,
      () => {},
      assets,
      impactSmoke,
      fixed(0.5),
    );

    effect.sprites.forEach(sprite =>
      expect(sprite.rotation).toBeCloseTo(Math.PI, 10),
    );
  });
});
