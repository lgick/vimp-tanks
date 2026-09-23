import { describe, it, expect, vi } from 'vitest';

// Pixi замокан: проверяется геометрия холста, градиент и настройка фильтра,
// не отрисовка
vi.mock('pixi.js', () => {
  class Graphics {
    constructor() {
      this.filters = null;
      this.rects = [];
      this.fills = [];
    }

    rect(x, y, width, height) {
      this.rects.push({ x, y, width, height });
      return this;
    }

    fill(style) {
      this.fills.push(style);
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

const { default: glintTexture } =
  await import('../../../src/client/bakers/glintTexture.js');
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

  return { result: glintTexture(params, renderer), baked };
};

describe('glintTexture', () => {
  it('рамка — квадрат с запасом под размытие, contentSize — сторона без запаса', () => {
    const { result, baked } = bake({ radius: 32, blur: 2 });

    expect(baked[0].frame.width).toBe((32 + blurMargin(2)) * 2);
    expect(baked[0].frame.height).toBe(baked[0].frame.width);
    expect(result.contentSize).toBe(64);
  });

  it('градиент от центра к краю +x: полосы справа от центра, ярче к краю', () => {
    const { baked } = bake({ radius: 32, strips: 8, blur: 2 });
    const { rects, fills } = baked[0].target;
    const center = baked[0].frame.width / 2;

    expect(rects).toHaveLength(8);
    expect(rects[0].x).toBe(center);
    expect(rects[7].x + rects[7].width).toBe(center + 32);

    for (let i = 1; i < fills.length; i += 1) {
      expect(fills[i].alpha).toBeGreaterThan(fills[i - 1].alpha);
    }
  });

  it('padding фильтра — область шире запаса', () => {
    const { baked } = bake({ radius: 16, blur: 3 });

    expect(baked[0].target.filters[0].padding).toBe(blurPadding(3));
  });
});
