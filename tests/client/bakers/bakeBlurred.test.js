import { describe, it, expect, vi } from 'vitest';

// Pixi замокан: проверяется настройка фильтра, кадр и освобождение, не отрисовка
vi.mock('pixi.js', () => {
  class Graphics {
    constructor() {
      this.filters = null;
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

    destroy() {}
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

const { Graphics, BlurFilter } = await import('pixi.js');
const { default: bakeBlurred } =
  await import('../../../src/client/bakers/bakeBlurred.js');
const { blurPadding } =
  await import('../../../src/client/bakers/blurMargin.js');

const bake = (options, target = new Graphics()) => {
  const renderer = { generateTexture: vi.fn(() => ({ id: 'texture' })) };
  const texture = bakeBlurred(renderer, target, options);

  return {
    renderer,
    target,
    texture,
    generated: renderer.generateTexture.mock.calls[0][0],
  };
};

describe('bakeBlurred', () => {
  it('padding фильтра — blurPadding(blur)', () => {
    const { target } = bake({ blur: 6, width: 40, height: 40 });
    const [filter] = target.filters;

    expect(filter).toBeInstanceOf(BlurFilter);
    expect(filter.strength).toBe(6);
    expect(filter.padding).toBe(blurPadding(6));
  });

  it('кадр — width × height от (0, 0)', () => {
    const { target, texture, generated } = bake({
      blur: 2,
      width: 30,
      height: 18,
    });

    expect(generated.target).toBe(target);
    expect(generated.frame).toMatchObject({
      x: 0,
      y: 0,
      width: 30,
      height: 18,
    });
    expect(texture).toEqual({ id: 'texture' });
  });

  it('фигура и фильтр освобождены', () => {
    const target = new Graphics();
    const targetDestroy = vi.spyOn(target, 'destroy');
    const filterDestroy = vi.spyOn(BlurFilter.prototype, 'destroy');

    bake({ blur: 3, width: 20, height: 20 }, target);

    expect(targetDestroy).toHaveBeenCalledWith(true);
    expect(filterDestroy).toHaveBeenCalledTimes(1);
    expect(filterDestroy.mock.contexts[0]).toBe(target.filters[0]);

    filterDestroy.mockRestore();
  });

  it('quality по умолчанию 10', () => {
    expect(
      bake({ blur: 2, width: 10, height: 10 }).target.filters[0].quality,
    ).toBe(10);
    expect(
      bake({ blur: 2, quality: 20, width: 10, height: 10 }).target.filters[0]
        .quality,
    ).toBe(20);
  });
});
