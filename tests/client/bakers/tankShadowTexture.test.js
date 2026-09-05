import { describe, it, expect, vi } from 'vitest';

// Pixi замокан: проверяется геометрия холста и настройка фильтра, не отрисовка
vi.mock('pixi.js', () => {
  class Graphics {
    constructor() {
      this.filters = null;
      this.rects = [];
    }

    roundRect(x, y, width, height, radius) {
      this.rects.push({ x, y, width, height, radius });
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

const { default: tankShadowTexture } = await import(
  '../../../src/client/bakers/tankShadowTexture.js'
);
const { default: blurMargin } = await import(
  '../../../src/client/bakers/blurMargin.js'
);

const params = {
  width: 40,
  height: 30,
  radius: 6,
  blur: 2,
  color: 0x000000,
};

const bake = extra => {
  const baked = [];
  const renderer = {
    generateTexture: options => {
      baked.push(options);
      return { width: options.frame.width, height: options.frame.height };
    },
  };

  return {
    result: tankShadowTexture({ ...params, ...extra }, renderer),
    baked,
  };
};

// тень — силуэт корпуса: круг с мягким ореолом вылезал из-под углов
// вращающегося корпуса и читался как серый кружок рядом с машиной
describe('tankShadowTexture', () => {
  it('фигура — прямоугольник в пропорции корпуса, холст с запасом', () => {
    const { baked } = bake();
    const margin = blurMargin(params.blur);
    const shape = baked[0].target.rects[0];

    expect(shape.width).toBe(40);
    expect(shape.height).toBe(30);
    expect(shape.x).toBe(margin);
    expect(shape.y).toBe(margin);
    expect(baked[0].frame.width).toBe(40 + margin * 2);
    expect(baked[0].frame.height).toBe(30 + margin * 2);
  });

  it('contentSize описывает ЧЁТКУЮ длину фигуры, а не холст', () => {
    const { result } = bake();

    expect(result.contentSize).toBe(40);
    expect(result.texture.width).toBe(40 + blurMargin(params.blur) * 2);
  });

  it('padding фильтра равен запасу: иначе Pixi обрежет размытие', () => {
    const { baked } = bake({ blur: 3 });

    expect(baked[0].target.filters[0].padding).toBe(blurMargin(3));
  });

  it('quality берётся из params, по умолчанию 20', () => {
    const { baked } = bake();
    const custom = bake({ quality: 8 });

    expect(baked[0].target.filters[0].quality).toBe(20);
    expect(custom.baked[0].target.filters[0].quality).toBe(8);
  });
});
