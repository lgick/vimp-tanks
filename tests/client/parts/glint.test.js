import { describe, it, expect, vi, afterEach } from 'vitest';
import { Container, Texture } from 'pixi.js';
import {
  glintHit,
  ensureGlint,
  hideGlint,
  placeGlint,
} from '../../../src/client/parts/glint.js';
import { lighting as lightingConfig } from '../../../src/config/render.js';

const asset = { texture: Texture.WHITE, contentSize: 64 };
const hit = { angle: 1, color: 0xffc070, strength: 2 };

// сервис-заглушка: ночь, предмет на экране, один источник
const makeService = ({ night = true, onScreen = true, glint = true } = {}) => ({
  texture: vi.fn(key => (key === 'glint' && glint ? asset : null)),
  isNight: vi.fn(() => night),
  onScreen: vi.fn(() => onScreen),
  lightsAt: vi.fn(() => [hit]),
});

const query = { x: 10, y: 20, z: 0, level: 1, reach: 30 };

describe('glint: glintHit', () => {
  const enabled = lightingConfig.glints.enabled;

  afterEach(() => {
    lightingConfig.glints.enabled = enabled;
  });

  it('отдаёт сильнейший источник и передаёт exclude', () => {
    const service = makeService();
    const own = [{}];

    expect(glintHit(service, { ...query, exclude: own })).toBe(hit);
    expect(service.lightsAt).toHaveBeenCalledWith(10, 20, 1, 1, own);
  });

  it('без exclude — null в сервис', () => {
    const service = makeService();

    glintHit(service, query);

    expect(service.lightsAt).toHaveBeenCalledWith(10, 20, 1, 1, null);
  });

  it('null: засвет выключен, нет текстуры, день, вне экрана, нет сервиса', () => {
    lightingConfig.glints.enabled = false;
    expect(glintHit(makeService(), query)).toBeNull();
    lightingConfig.glints.enabled = enabled;

    expect(glintHit(makeService({ glint: false }), query)).toBeNull();
    expect(glintHit(makeService({ night: false }), query)).toBeNull();
    expect(glintHit(makeService({ onScreen: false }), query)).toBeNull();
    expect(glintHit(null, query)).toBeNull();
  });

  it('источников нет — null', () => {
    const service = makeService();

    service.lightsAt.mockReturnValue([]);

    expect(glintHit(service, query)).toBeNull();
  });
});

describe('glint: пара «блик + маска»', () => {
  it('ensureGlint заводит пару один раз, маска — раньше блика', () => {
    const parent = new Container();
    const glint = ensureGlint(null, parent, asset.texture);

    expect(parent.children).toEqual([glint.mask, glint.sprite]);
    expect(glint.sprite.mask).toBe(glint.mask);
    expect(glint.sprite.blendMode).toBe('add');
    expect(ensureGlint(glint, parent, asset.texture)).toBe(glint);
    expect(parent.children).toHaveLength(2);
  });

  it('placeGlint раскладывает блик, hideGlint прячет', () => {
    const glint = ensureGlint(null, new Container(), asset.texture);
    const { intensity, size } = lightingConfig.glints;

    placeGlint(glint, { hit, asset, x: 3, y: 4, rotation: 0.5, size: 64 });

    expect(glint.sprite.visible).toBe(true);
    expect(glint.sprite.position.x).toBe(3);
    expect(glint.sprite.position.y).toBe(4);
    expect(glint.sprite.rotation).toBe(0.5);
    expect(glint.sprite.scale.x).toBeCloseTo((64 * size) / 64);
    expect(glint.sprite.tint).toBe(0xffc070);
    expect(glint.sprite.alpha).toBeCloseTo(Math.min(1, intensity * 2));

    hideGlint(glint);
    expect(glint.sprite.visible).toBe(false);
    expect(() => hideGlint(null)).not.toThrow();
  });
});
