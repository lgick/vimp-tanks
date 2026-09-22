import { describe, it, expect, vi } from 'vitest';

// Pixi замокан: проверяется геометрия холста и настройка фильтра, не отрисовка
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

const { default: scorchTexture } =
  await import('../../../src/client/bakers/scorchTexture.js');
const { default: blurMargin } =
  await import('../../../src/client/bakers/blurMargin.js');

const params = {
  baseRadius: 20,
  irregularity: 5,
  blur: 4,
  numPoints: 16,
  color: 0x141210,
  coreColor: 0x050505,
  coreRatio: 0.55,
  variants: 3,
};

const bake = overrides => {
  const baked = [];
  const renderer = {
    generateTexture: options => {
      baked.push(options);
      return { width: options.frame.width };
    },
  };

  return {
    result: scorchTexture({ ...params, ...overrides }, renderer),
    baked,
  };
};

describe('scorchTexture', () => {
  it('холст — силуэт плюс запас под размытие с каждой стороны', () => {
    const { result, baked } = bake();
    const size = (20 + 5) * 2 + blurMargin(4) * 2;

    expect(result.contentSize).toBe(50);
    expect(baked).toHaveLength(3);

    for (const options of baked) {
      expect(options.frame).toMatchObject({ x: 0, y: 0, width: size });
      expect(options.frame.height).toBe(size);
    }
  });

  it('область фильтра шире рамки: мусор пула с края не попадает в текстуру', () => {
    const { baked } = bake();

    for (const options of baked) {
      // край области фильтра (сдвиг padding от фигуры) лежит за рамкой
      // frame не меньше чем на радиус ядра размытия (blurMargin)
      expect(options.target.filters[0].padding).toBeGreaterThanOrEqual(
        blurMargin(4) * 2,
      );
    }
  });

  it('хотя бы один вариант даже при variants = 0', () => {
    const { result } = bake({ variants: 0 });

    expect(result.textures).toHaveLength(1);
  });
});
