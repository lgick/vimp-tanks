import { describe, it, expect } from 'vitest';
import { Container, Sprite, Texture, TextureSource } from 'pixi.js';
import WreckScorch from '../../../src/client/parts/WreckScorch.js';
import { levelZ } from '../../../src/client/levelZ.js';
import { parallax, wreckFx } from '../../../src/config/render.js';

// Копоть остова: сиблинг на сцене в точке гибели, проявляется за fadeIn,
// проецируется по своей высоте и живёт до респауна

const asset = {
  textures: [Texture.EMPTY, Texture.EMPTY],
  contentSize: 40,
};

// центр камеры сцены без трансформа при renderer.screen 800×600
const camera = { x: 400, y: 300 };

const scorchAt = (options = {}, scorchAsset = asset) => {
  const stage = new Container();
  const scorch = new WreckScorch(stage, scorchAsset, {
    x: 100,
    y: 100,
    z: 0,
    level: 0,
    sizeScale: 1,
    ...options,
  });

  return { stage, scorch };
};

describe('WreckScorch', () => {
  it('спрайт — на сцене, прозрачный, под танком своего уровня', () => {
    const { stage, scorch } = scorchAt({ level: 1, sizeScale: 2 });

    expect(stage.children).toEqual([scorch.sprite]);
    expect(scorch.sprite).toBeInstanceOf(Sprite);
    expect(scorch.sprite.alpha).toBe(0);
    expect(scorch.sprite.zIndex).toBe(levelZ(2, 1));
    expect(scorch.scale).toBeCloseTo((wreckFx.scorch.size * 2) / 40, 6);
  });

  it('проявляется за fadeIn', () => {
    const { scorch } = scorchAt();
    const { alpha, fadeIn } = wreckFx.scorch;

    expect(scorch.settled).toBe(false);

    scorch.step(fadeIn / 2);

    expect(scorch.alpha).toBeCloseTo(alpha / 2, 6);
    expect(scorch.settled).toBe(false);

    scorch.step(fadeIn);

    expect(scorch.alpha).toBeCloseTo(alpha, 6);
    expect(scorch.settled).toBe(true);
  });

  it('на земле проекция не смещает копоть', () => {
    const { scorch } = scorchAt();

    scorch.render(camera, null);

    expect(scorch.sprite.position.x).toBeCloseTo(100, 6);
    expect(scorch.sprite.position.y).toBeCloseTo(100, 6);
    expect(scorch.sprite.scale.x).toBeCloseTo(scorch.scale, 6);
  });

  it('на высоте z > 0 — проекция offsetPoint от центра камеры', () => {
    const { scorch } = scorchAt({ z: 1 });
    const k = parallax.shear;

    scorch.render(camera, null);

    expect(scorch.sprite.position.x).toBeCloseTo(100 + (100 - 400) * k, 6);
    expect(scorch.sprite.position.y).toBeCloseTo(100 + (100 - 300) * k, 6);
    expect(scorch.sprite.scale.x).toBeCloseTo(scorch.scale * (1 + k), 6);
  });

  it('alpha и tint — через levelView', () => {
    const { scorch } = scorchAt({ level: 1, z: 1 });
    const calls = [];
    const levelView = {
      alphaFor: (...args) => {
        calls.push(args);

        return 0.5;
      },
      tintFor: () => 0x808080,
    };

    scorch.step(wreckFx.scorch.fadeIn);
    scorch.render(camera, levelView);

    expect(calls).toEqual([[1, 100, 100, 1]]);
    expect(scorch.sprite.alpha).toBeCloseTo(wreckFx.scorch.alpha * 0.5, 6);
    expect(scorch.sprite.tint).toBe(0x808080);
  });

  it('destroy снимает спрайт со сцены и не трогает текстуру', () => {
    // настоящая текстура: у Texture.EMPTY destroy — пустышка, и проверка
    // на ней прошла бы, даже если копоть уничтожает общую текстуру
    const texture = new Texture({ source: new TextureSource() });
    const { stage, scorch } = scorchAt(
      {},
      { textures: [texture], contentSize: 40 },
    );

    scorch.destroy();

    expect(stage.children).toHaveLength(0);
    expect(scorch.sprite.destroyed).toBe(true);
    expect(texture.destroyed).toBe(false);
    expect(texture.source.destroyed).toBe(false);
  });
});
