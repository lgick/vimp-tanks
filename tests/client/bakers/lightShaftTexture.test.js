import { describe, it, expect, vi } from 'vitest';

// Pixi замокан: проверяется рамка, число лучей и детерминизм рисунка
vi.mock('pixi.js', () => {
  class Graphics {
    constructor() {
      this.filters = null;
      this.polys = [];
    }

    poly(points) {
      this.polys.push(points);
      return this;
    }

    fill() {
      return this;
    }

    destroy() {}
  }

  class BlurFilter {
    constructor(options) {
      this.strength = options.strength;
      this.quality = options.quality;
      this.padding = options.strength * 2;
    }
  }

  class Rectangle {
    constructor(x, y, width, height) {
      this.x = x;
      this.y = y;
      this.width = width;
      this.height = height;
    }
  }

  return { Graphics, BlurFilter, Rectangle };
});

const { default: lightShaftTexture, seededRandom } =
  await import('../../../src/client/bakers/lightShaftTexture.js');
const { default: blurMargin, blurPadding } =
  await import('../../../src/client/bakers/blurMargin.js');

const bake = params => {
  const baked = [];
  const renderer = {
    generateTexture: options => {
      baked.push(options);
      return { width: options.frame.width };
    },
  };

  return { result: lightShaftTexture(params, renderer), baked };
};

describe('lightShaftTexture', () => {
  it('рамка — диаметр лучей с запасом под размытие', () => {
    const { result, baked } = bake({ radius: 128, blur: 3 });

    expect(baked[0].frame.width).toBe((128 + blurMargin(3)) * 2);
    expect(result.contentSize).toBe(256);
    expect(baked[0].target.filters[0].padding).toBe(blurPadding(3));
  });

  it('по `strips` трапеций на каждый из `rays` лучей, все внутри радиуса', () => {
    const { baked } = bake({ radius: 100, rays: 6, strips: 4, blur: 2 });
    const { polys } = baked[0].target;
    const center = baked[0].frame.width / 2;

    expect(polys).toHaveLength(24);

    for (const points of polys) {
      for (let i = 0; i < points.length; i += 2) {
        expect(
          Math.hypot(points[i] - center, points[i + 1] - center),
        ).toBeLessThanOrEqual(100 + 1e-9);
      }
    }
  });

  it('рисунок задан `seed`: одинаков при одном, разный при другом', () => {
    const a = bake({ radius: 64, rays: 5, seed: 7 }).baked[0].target.polys;
    const b = bake({ radius: 64, rays: 5, seed: 7 }).baked[0].target.polys;
    const c = bake({ radius: 64, rays: 5, seed: 8 }).baked[0].target.polys;

    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('ГПСЧ даёт числа в [0, 1)', () => {
    const random = seededRandom(42);

    for (let i = 0; i < 100; i += 1) {
      const value = random();

      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});
