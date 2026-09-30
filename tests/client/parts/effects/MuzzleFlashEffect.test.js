import { describe, it, expect } from 'vitest';
import MuzzleFlashEffect, {
  muzzleFlashLife,
  muzzleFlashShape,
  muzzleRingShape,
  rollMuzzleFlash,
} from '../../../../src/client/parts/effects/shot/MuzzleFlashEffect.js';
import { muzzleFlash, impactFlash } from '../../../../src/config/render.js';

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

  it('без sideLength боковых выбросов нет (вспышка разрыва)', () => {
    expect(impactFlash.sideLength).toBe(0);
    expect(rollMuzzleFlash(impactFlash, fixed(0.5)).sides).toEqual([]);
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

  it('огненный шар: круг в дуле на каждый слой, после языков всех слоёв', () => {
    const polygons = shape();
    const balls = polygons.slice(perLayer * muzzleFlash.layers.length);

    expect(balls).toHaveLength(muzzleFlash.layers.length);

    balls.forEach(({ points, alpha }, i) => {
      const layer = muzzleFlash.layers[i];
      const radius = Math.hypot(points[0], points[1]);

      expect(radius).toBeCloseTo(muzzleFlash.ball.radius * layer.scale, 6);
      expect(alpha).toBeCloseTo(layer.alpha, 6);

      // центр — дуло
      const xs = points.filter((_, k) => k % 2 === 0);

      expect(xs.reduce((sum, x) => sum + x, 0) / xs.length).toBeCloseTo(0, 6);
    });
  });

  it('без ball шара нет', () => {
    const polygons = shape({ config: { ...muzzleFlash, ball: null } });

    expect(polygons).toHaveLength(perLayer * muzzleFlash.layers.length);
  });
});

describe('muzzleRingShape', () => {
  const { ring } = muzzleFlash;

  it('растёт быстро в начале и гаснет по квадрату', () => {
    const start = muzzleRingShape(0, muzzleFlash);
    const half = muzzleRingShape(ring.duration / 2, muzzleFlash);

    expect(start.radius).toBe(0);
    expect(start.alpha).toBeCloseTo(ring.alpha, 6);
    // ease-out: к половине времени — три четверти радиуса
    expect(half.radius).toBeCloseTo(ring.radius * 0.75, 6);
    expect(half.alpha).toBeCloseTo(ring.alpha * 0.25, 6);
    expect(half.color).toBe(ring.color);
  });

  it('после duration и без ring — null', () => {
    expect(muzzleRingShape(ring.duration, muzzleFlash)).toBeNull();
    expect(muzzleRingShape(0, { ...muzzleFlash, ring: null })).toBeNull();
  });

  it('muzzleFlashLife — по более долгой из частей', () => {
    expect(muzzleFlashLife(muzzleFlash)).toBe(
      Math.max(muzzleFlash.duration, ring.duration),
    );
    expect(muzzleFlashLife({ duration: 50, ring: null })).toBe(50);
  });
});

describe('MuzzleFlashEffect', () => {
  it('языки гаснут через duration, кольцо — через ring.duration', () => {
    const flash = new MuzzleFlashEffect(
      0,
      0,
      1,
      0,
      () => {},
      muzzleFlash,
      fixed(0.5),
    );

    flash._update(muzzleFlash.duration);

    // языков уже нет, кольцо ещё рисуется
    expect(flash.isComplete).toBe(false);
    expect(flash.graphics.bounds.width).toBeGreaterThan(0);

    flash._update(muzzleFlash.ring.duration);
    expect(flash.isComplete).toBe(true);
  });

  it('стоит в дуле и завершается через muzzleFlashLife', () => {
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

    flash._update(muzzleFlashLife(muzzleFlash));
    expect(done).toBe(true);
  });
});
