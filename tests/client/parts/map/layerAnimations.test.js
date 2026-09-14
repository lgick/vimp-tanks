import { describe, it, expect, vi, afterEach } from 'vitest';
import { Container, Texture, Ticker } from 'pixi.js';
import { createLighting } from '../../../../src/client/lighting/createLighting.js';
import NeonSign from '../../../../src/client/parts/map/NeonSign.js';
import {
  buildDecals,
  destroyDecals,
  ownedBy,
  updateDecals,
} from '../../../../src/client/parts/map/decals.js';
import {
  buildLayerAnimations,
  destroyLayerAnimations,
  layerAnimationSpec,
  updateLayerAnimations,
} from '../../../../src/client/parts/map/layerAnimations.js';
import { releaseNeonTextures } from '../../../../src/client/parts/map/neonCache.js';

// текстуры неона — рендерером, которого в happy-dom нет: кэш подменён
vi.mock('../../../../src/client/parts/map/neonCache.js', () => ({
  getNeonTextures: vi.fn(() => ({ core: new Texture(), glow: new Texture() })),
  releaseNeonTextures: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
});

const sign = {
  cell: [4, 2],
  level: 1,
  layer: 1,
  text: 'HOTEL',
  color: 0xff3ad0,
  size: 18,
  flicker: { pulse: 0.15, dropouts: 0.2 },
  light: { radius: 80, intensity: 0.7 },
};

const nightLighting = () => {
  const lighting = createLighting();

  lighting.acquireMap('k', { night: true }, 10, 1);

  return lighting;
};

const makeSign = (lighting, animated = new Container()) =>
  new NeonSign({
    sign,
    renderer: {},
    lighting,
    animated,
    step: 10,
    scale: { x: 1, y: 1 },
    level: 1,
  });

describe('ownedBy: владелец вывески и декали', () => {
  const items = [
    { level: 1, layer: 1 },
    { level: 1, layer: 2 },
    { layer: 1 },
  ];

  it('только элементы с совпадающими (level, layer)', () => {
    expect(ownedBy(items, 1, 1)).toEqual([items[0]]);
    expect(ownedBy(items, 1, 2)).toEqual([items[1]]);
    expect(ownedBy(items, 0, 1)).toEqual([items[2]]);
    expect(ownedBy(undefined, 0, 1)).toEqual([]);
  });

  it('layerAnimationSpec раскладывает game по слою', () => {
    const game = {
      animatedTiles: { 45: { frames: [45], fps: 1 } },
      signs: [sign],
      decals: [{ cell: [0, 0], level: 0, layer: 1, frame: 3, kind: 'rotate' }],
    };

    expect(layerAnimationSpec(game, [45], 1, 1)).toEqual({
      exclude: [45],
      hasTiles: true,
      signs: [sign],
      decals: [],
    });
    expect(layerAnimationSpec(undefined, [1], 0, 1).hasTiles).toBe(false);
  });
});

describe('NeonSign', () => {
  it('ночью: эмиссив сервиса и источник света цвета вывески', () => {
    const lighting = nightLighting();
    const addLight = vi.spyOn(lighting, 'addLight');
    const animated = new Container();
    const neon = makeSign(lighting, animated);

    expect(neon.emissive).toBe(true);
    expect(animated.children).toHaveLength(0);
    expect(neon.core.parent?.label).toBe('emissive-1');
    expect(addLight).toHaveBeenCalledWith(
      expect.objectContaining({ level: 1, x: 45, y: 25, color: sign.color, radius: 80 }),
    );
  });

  it('destroy снимает источник и эмиссив и отдаёт текстуры колбэком', () => {
    const lighting = nightLighting();
    const removeLight = vi.spyOn(lighting, 'removeLight');
    const removeEmissive = vi.spyOn(lighting, 'removeEmissive');
    const neon = makeSign(lighting);
    const { core, glow } = neon;
    const release = neon.destroy();

    expect(removeLight).toHaveBeenCalledTimes(1);
    expect(removeEmissive).toHaveBeenCalledWith(core);
    expect(removeEmissive).toHaveBeenCalledWith(glow);
    expect(core.destroyed).toBe(true);
    expect(releaseNeonTextures).not.toHaveBeenCalled();

    release();

    expect(releaseNeonTextures).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['день', () => createLighting()],
    ['lighting.enabled = false', () => createLighting({ enabled: false })],
    ['нет сервиса', () => null],
  ])('%s: addEmissive → false, вывеска в animated и видна, света нет', (name, make) => {
    const lighting = make();
    const addLight = lighting ? vi.spyOn(lighting, 'addLight') : null;
    const animated = new Container();
    const neon = makeSign(lighting, animated);

    neon.update(null, null, null);

    expect(neon.emissive).toBe(false);
    expect(animated.children).toEqual([neon.glow, neon.core]);
    expect(neon.core.position.x).toBe(45);
    expect(neon.core.alpha).toBe(1);
    expect(neon.core.visible).toBe(true);

    if (addLight) {
      expect(addLight).not.toHaveBeenCalled();
    }
  });

  it('эмиссив: позиция по проекции уровня, мерцание в alpha', () => {
    const neon = makeSign(nightLighting());

    neon.update(3.1, { x: 0, y: 0 }, null);

    expect(neon.core.position.x).toBeGreaterThan(45);
    expect(neon.core.alpha).toBeLessThanOrEqual(1);
    expect(neon.core.alpha).toBeGreaterThanOrEqual(0);
  });
});

describe('decals', () => {
  const sheet = {
    textures: { frame70: new Texture(), frame71: new Texture() },
  };

  it('rotate: центр клетки, вращение rps по часам; destroy снимает спрайт', () => {
    const animated = new Container();
    const [decal] = buildDecals(
      [{ cell: [10, 8], frame: 70, kind: 'rotate', rps: 1.5 }],
      sheet,
      32,
      animated,
    );

    expect(decal.sprite.parent).toBe(animated);
    expect(decal.sprite.position.x).toBe(10.5 * 32);

    updateDecals([decal], 0.5);

    expect(decal.sprite.rotation).toBeCloseTo(1.5 * 2 * Math.PI * 0.5, 9);

    destroyDecals([decal]);

    expect(animated.children).toHaveLength(0);
    expect(sheet.textures.frame70.destroyed).toBe(false);
  });

  it('frames: смена кадров как у тайлов', () => {
    const [decal] = buildDecals(
      [{ cell: [0, 0], kind: 'frames', frames: [70, 71], fps: 2 }],
      sheet,
      32,
      new Container(),
    );

    updateDecals([decal], 0.6);

    expect(decal.sprite.texture).toBe(sheet.textures.frame71);
  });
});

describe('layerAnimations: сборка и освобождение', () => {
  it('вывески строятся без тайл-листа, обновляются и освобождаются', async () => {
    const lighting = nightLighting();
    const animated = new Container();
    const spec = layerAnimationSpec({ signs: [sign] }, [1], 1, 1);
    const state = await buildLayerAnimations({
      spec,
      game: { signs: [sign] },
      baseTexture: null,
      spriteSheetData: null,
      map: [[1]],
      tiles: [1],
      step: 10,
      scale: { x: 1, y: 1 },
      level: 1,
      animated,
      renderer: {},
      lighting,
      isAborted: () => false,
    });

    expect(state.sheet).toBe(null);
    expect(state.signs).toHaveLength(1);

    Ticker.shared.lastTime += 16;
    updateLayerAnimations(state, { camera: { x: 0, y: 0 }, levelView: null, screen: null });

    const release = destroyLayerAnimations(state);

    expect(state.signs).toHaveLength(0);

    release();

    expect(releaseNeonTextures).toHaveBeenCalledTimes(1);
  });
});
