import { describe, it, expect, vi } from 'vitest';

// Pixi замокан: проверяется геометрия холста и настройка фильтра, не отрисовка
vi.mock('pixi.js', () => {
  class Graphics {
    constructor() {
      this.filters = null;
      this.circles = [];
    }

    circle(x, y, radius) {
      this.circles.push({ x, y, radius });
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

const { default: blurredCircleTexture } = await import(
  '../../../src/client/bakers/blurredCircleTexture.js'
);
const { default: blurMargin } = await import(
  '../../../src/client/bakers/blurMargin.js'
);

const bake = params => {
  const baked = [];
  const renderer = {
    generateTexture: options => {
      baked.push(options);
      return { width: options.frame.width };
    },
  };

  return { result: blurredCircleTexture(params, renderer), baked };
};

describe('blurredCircleTexture', () => {
  it('холст включает запас под размытие, круг остаётся радиусом radius', () => {
    const { baked } = bake({ radius: 50, blur: 2, color: 0xffffff });

    expect(baked[0].frame.width).toBe((50 + blurMargin(2)) * 2);
    expect(baked[0].target.circles[0].radius).toBe(50);
  });

  it('contentSize описывает круг, а не холст', () => {
    const { result } = bake({ radius: 3, blur: 1, color: 0xffffff });

    expect(result.contentSize).toBe(6);
    expect(result.texture.width).toBe((3 + blurMargin(1)) * 2);
  });

  it('padding фильтра равен запасу: иначе Pixi обрежет размытие', () => {
    const { baked } = bake({ radius: 4, blur: 3, color: 0xffffff });

    expect(baked[0].target.filters[0].padding).toBe(blurMargin(3));
  });

  it('quality берётся из params, по умолчанию 40', () => {
    const { baked } = bake({ radius: 4, blur: 1, color: 0xffffff });
    const custom = bake({ radius: 4, blur: 1, color: 0xffffff, quality: 10 });

    expect(baked[0].target.filters[0].quality).toBe(40);
    expect(custom.baked[0].target.filters[0].quality).toBe(10);
  });
});
