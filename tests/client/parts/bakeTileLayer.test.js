import { describe, it, expect, vi } from 'vitest';
import { Texture } from 'pixi.js';
import { bakeTileLayer } from '../../../src/client/parts/bakeTileLayer.js';

// Запекание слоя: анимированные тайлы (`game.animatedTiles`) в текстуру не
// попадают — их рисуют живые спрайты поверх.
describe('bakeTileLayer', () => {
  const bake = async exclude => {
    let placed = null;
    const renderer = {
      generateTexture: vi.fn(({ target }) => {
        placed = target.children.length;

        return {};
      }),
    };

    await bakeTileLayer({
      baseTexture: Texture.WHITE,
      spriteSheetData: {
        frames: [
          [0, 0, 1, 1],
          [0, 0, 1, 1],
          [0, 0, 1, 1],
        ],
      },
      map: [
        [1, 2, 2],
        [0, 1, 2],
      ],
      tiles: [1, 2],
      step: 32,
      renderer,
      exclude,
    });

    return placed;
  };

  it('без exclude запекаются все тайлы слоя', async () => {
    expect(await bake(undefined)).toBe(5);
  });

  it('анимированные тайлы исключены', async () => {
    expect(await bake([2])).toBe(2);
  });
});
