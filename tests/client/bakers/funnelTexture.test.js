import { describe, it, expect, vi } from 'vitest';

// Pixi замокан: проверяется геометрия холста и настройка фильтра, не отрисовка
vi.mock('pixi.js', () => {
  class Graphics {
    constructor() {
      this.filters = null;
    }

    poly() {
      return this;
    }

    fill() {
      return this;
    }

    stroke() {
      return this;
    }

    destroy() {}
  }

  class BlurFilter {
    constructor(options) {
      this.strength = options.strength;
      this.quality = options.quality;
      // Pixi сам выставляет padding в конструкторе
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

const { default: funnelTexture } =
  await import('../../../src/client/bakers/funnelTexture.js');
const { default: blurMargin } =
  await import('../../../src/client/bakers/blurMargin.js');

const params = {
  baseRadius: 25,
  irregularity: 4,
  blur: 3,
  numPoints: 20,
  colorFill: 0x1c1c1c,
  colorRim: 0xb0b0b0,
  rimWidth: 4,
  variants: 3,
};

const bake = () => {
  const baked = [];
  const renderer = {
    generateTexture: options => {
      baked.push(options);
      return { width: options.frame.width };
    },
  };

  return { result: funnelTexture(params, renderer), baked };
};

describe('funnelTexture', () => {
  it('холст — силуэт с бортиком плюс запас под размытие', () => {
    const { result, baked } = bake();
    const size = (25 + 4 + 4) * 2 + blurMargin(3) * 2;

    expect(result.contentSize).toBe(66);
    expect(baked).toHaveLength(3);

    for (const options of baked) {
      expect(options.frame).toMatchObject({ x: 0, y: 0, width: size });
    }
  });

  it('область фильтра шире рамки: мусор пула с края не попадает в текстуру', () => {
    const { baked } = bake();

    for (const options of baked) {
      expect(options.target.filters[0].padding).toBeGreaterThanOrEqual(
        blurMargin(3) * 2,
      );
    }
  });
});
