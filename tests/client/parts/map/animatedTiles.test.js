import { describe, it, expect } from 'vitest';
import { Texture } from 'pixi.js';
import {
  buildAnimatedTiles,
  destroyAnimatedTiles,
  frameIndex,
  resolveFps,
  updateAnimatedTiles,
} from '../../../../src/client/parts/map/animatedTiles.js';

// Анимированные тайлы: живые спрайты на клетках тайлов из
// `game.animatedTiles`, общий номер кадра на группу.
describe('animatedTiles', () => {
  const sheet = {
    textures: Object.fromEntries(
      [43, 45, 60, 61, 62, 63, 64, 65].map(id => [`frame${id}`, new Texture()]),
    ),
  };

  const defs = {
    45: { kind: 'frames', frames: [45, 60, 61, 62], speed: 60 },
    43: { kind: 'frames', frames: [43, 63, 64, 65], fps: 4 },
  };

  const data = {
    map: [
      [1, 45, 45],
      [43, 1, 1],
    ],
    tiles: [1, 45, 43],
    step: 32,
    scale: 0.5,
  };

  it('спрайты только на клетках анимированных тайлов слоя', () => {
    const built = buildAnimatedTiles(data, sheet, defs);
    const cells = built.groups.flatMap(group =>
      group.sprites.map(sprite => [group.id, sprite.x / 32, sprite.y / 32]),
    );

    expect(cells).toEqual(
      expect.arrayContaining([
        [45, 1, 0],
        [45, 2, 0],
        [43, 0, 1],
      ]),
    );
    expect(cells).toHaveLength(3);
    expect(built.groups.every(group => group.sprites.every(s => s.cullable))).toBe(true);
  });

  it('тайл, которого нет в tiles слоя, этому слою не достаётся', () => {
    const built = buildAnimatedTiles({ ...data, tiles: [1, 43] }, sheet, defs);

    expect(built.groups.map(group => group.id)).toEqual([43]);
  });

  it('fps конвейера вычисляется из speed: speed · N / (step · scale)', () => {
    expect(resolveFps(defs[45], 32, 0.5)).toBeCloseTo((60 * 4) / 16, 9);
    expect(resolveFps(defs[43], 32, 0.5)).toBe(4);
    expect(resolveFps(defs[45], 32, { x: 0.5, y: 0.5 })).toBeCloseTo(15, 9);
  });

  it('кадры меняются по времени; спрайты не поворачиваются', () => {
    const built = buildAnimatedTiles(data, sheet, defs);
    const water = built.groups.find(group => group.id === 43);
    const belt = built.groups.find(group => group.id === 45);

    updateAnimatedTiles(built.groups, 0.26);

    expect(water.sprites[0].texture).toBe(sheet.textures.frame63);
    // 15 кадров/с: 0.26 с → кадр 3
    expect(belt.sprites[0].texture).toBe(sheet.textures.frame62);
    expect(belt.sprites[1].texture).toBe(sheet.textures.frame62);

    updateAnimatedTiles(built.groups, 1.0);

    expect(water.sprites[0].texture).toBe(sheet.textures.frame43);

    for (const group of built.groups) {
      for (const sprite of group.sprites) {
        expect(sprite.rotation).toBe(0);
      }
    }
  });

  it('группа вне экрана не обновляется', () => {
    const built = buildAnimatedTiles(data, sheet, defs);

    updateAnimatedTiles(built.groups, 0.26, () => false);

    for (const group of built.groups) {
      expect(group.sprites[0].texture).toBe(group.textures[0]);
    }
  });

  it('frameIndex зацикливается и терпит пустые описания', () => {
    expect(frameIndex(1.25, 4, 4)).toBe(1);
    expect(frameIndex(5, 0, 4)).toBe(0);
    expect(frameIndex(5, 4, 0)).toBe(0);
  });

  it('destroy не освобождает текстуры листа', () => {
    const built = buildAnimatedTiles(data, sheet, defs);

    destroyAnimatedTiles(built);

    expect(built.container.destroyed).toBe(true);
    expect(sheet.textures.frame45.destroyed).toBe(false);
  });
});
