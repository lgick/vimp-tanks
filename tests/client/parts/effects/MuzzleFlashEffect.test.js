import { describe, it, expect } from 'vitest';
import MuzzleFlashEffect, {
  muzzleFlashShape,
  rollMuzzleFlash,
} from '../../../../src/client/parts/effects/shot/MuzzleFlashEffect.js';
import { muzzleFlash } from '../../../../src/config/render.js';

// детерминированный «случай»: одно и то же число
const fixed = value => () => value;

const tipOf = points => ({ x: points[2], y: points[3] });

describe('rollMuzzleFlash', () => {
  it('языков — spikes, все в пределах разброса и разброса длины', () => {
    for (const value of [0, 0.3, 0.99]) {
      const { forward, sides } = rollMuzzleFlash(muzzleFlash, fixed(value));

      expect(forward).toHaveLength(muzzleFlash.spikes);

      for (const { angle, length } of forward) {
        expect(Math.abs(angle)).toBeLessThanOrEqual(muzzleFlash.spread + 1e-9);
        expect(length).toBeGreaterThanOrEqual(1 - muzzleFlash.jitter - 1e-9);
        expect(length).toBeLessThanOrEqual(1);
      }

      expect(sides).toHaveLength(2);
    }
  });

  it('разные выстрелы — разный рисунок', () => {
    let seed = 0.1;
    const rng = () => {
      seed = (seed * 9301 + 0.49297) % 1;

      return seed;
    };

    const a = rollMuzzleFlash(muzzleFlash, rng);
    const b = rollMuzzleFlash(muzzleFlash, rng);

    expect(a.forward[0].length).not.toBe(b.forward[0].length);
  });
});

describe('muzzleFlashShape', () => {
  const roll = rollMuzzleFlash(muzzleFlash, fixed(0.5));
  const shape = overrides =>
    muzzleFlashShape({
      dirX: 1,
      dirY: 0,
      t: 0,
      roll,
      config: muzzleFlash,
      ...overrides,
    });
  // языки одного слоя: сначала forward, потом два боковых
  const perLayer = muzzleFlash.spikes + 2;

  it('языки смотрят вперёд по выстрелу', () => {
    const forward = shape().slice(0, muzzleFlash.spikes);

    for (const { points } of forward) {
      expect(tipOf(points).x).toBeGreaterThan(0);
    }

    const down = shape({ dirX: 0, dirY: 1 }).slice(0, muzzleFlash.spikes);

    for (const { points } of down) {
      expect(tipOf(points).y).toBeGreaterThan(0);
    }
  });

  it('боковые выбросы — поперёк выстрела, в обе стороны', () => {
    const polygons = shape();
    const left = tipOf(polygons[muzzleFlash.spikes].points);
    const right = tipOf(polygons[muzzleFlash.spikes + 1].points);

    expect(left.x).toBeCloseTo(0, 6);
    expect(left.y).toBeGreaterThan(0);
    expect(right.y).toBeLessThan(0);
  });

  it('мягкий край: наружный слой шире и тусклее ядра', () => {
    const polygons = shape();
    const outer = polygons[0];
    const core = polygons[perLayer * (muzzleFlash.layers.length - 1)];

    expect(tipOf(outer.points).x).toBeGreaterThan(tipOf(core.points).x);
    expect(outer.alpha).toBeLessThan(core.alpha);
    expect(core.color).toBe(muzzleFlash.coreColor);
  });

  it('к концу гаснет: яркость по квадрату, к t = 1 — ничего', () => {
    const start = shape({ t: 0 })[0];
    const middle = shape({ t: 0.5 })[0];

    expect(middle.alpha).toBeCloseTo(start.alpha * 0.25, 6);
    expect(tipOf(middle.points).x).toBeLessThan(tipOf(start.points).x);
    expect(shape({ t: 1 })).toEqual([]);
  });
});

describe('MuzzleFlashEffect', () => {
  it('стоит в дуле и завершается через duration', () => {
    let done = false;
    const flash = new MuzzleFlashEffect(
      10,
      20,
      1,
      0,
      () => {
        done = true;
      },
      muzzleFlash,
      fixed(0.5),
    );

    expect(flash.x).toBe(10);
    expect(flash.y).toBe(20);

    flash._update(muzzleFlash.duration / 2);
    expect(done).toBe(false);

    flash._update(muzzleFlash.duration);
    expect(done).toBe(true);
  });
});
