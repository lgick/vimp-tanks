import { describe, it, expect } from 'vitest';
import { Texture, TextureSource } from 'pixi.js';
import {
  buildVolumeSlices,
  buildRampMeshes,
  updateRampMesh,
} from '../../../../src/client/parts/map/extrusion.js';
import { parallax, volume } from '../../../../src/config/render.js';

// Геометрия экструзии — чистые функции: ни парта, ни сцены, ни конфига.
// Поведение слоя целиком проверяется в MapLayer.test.js, здесь — сама
// арифметика срезов.

const texture = () =>
  new Texture({ source: new TextureSource({ width: 20, height: 20 }) });

// полоса рампы в КЛЕТКАХ грида (то, что отдаёт buildRampLanes): строка 0,
// колонки 0..2, подъём на восток с уровня 0 на уровень 1
const lane = (over = {}) => ({
  axis: 0,
  sign: 1,
  from: 0,
  to: 1,
  col0: 0,
  col1: 2,
  row0: 0,
  row1: 1,
  ...over,
});

describe('extrusion: объём слоя', () => {
  const build = (over = {}) =>
    buildVolumeSlices({
      bakedTexture: texture(),
      level: 0,
      volume: 1,
      shear: parallax.shear,
      count: 4,
      sideTint: volume.sideTint,
      ...over,
    });

  it('даёт ровно count срезов, каждый выше предыдущего', () => {
    const slices = build();

    expect(slices).toHaveLength(4);

    for (let i = 1; i < slices.length; i += 1) {
      expect(slices[i].k).toBeGreaterThan(slices[i - 1].k);
    }

    // верхний срез стоит на полной высоте объёма
    expect(slices[slices.length - 1].k).toBeCloseTo(parallax.shear, 6);
  });

  it('боковые срезы темнее верхнего и уходят в перекрыватель', () => {
    const slices = build();

    for (const slice of slices.slice(0, -1)) {
      expect(slice.target.tint).toBe(volume.sideTint);
      expect(slice.occluder).toBe(true);
    }

    expect(slices[slices.length - 1].target.tint).toBe(0xffffff);
  });

  // объём слоя уровня N стоит НА нём, а не на земле
  it('уровень слоя поднимает весь объём', () => {
    const ground = build();
    const bridge = build({ level: 1 });

    for (let i = 0; i < ground.length; i += 1) {
      expect(bridge[i].k).toBeCloseTo(ground[i].k + parallax.shear, 6);
    }
  });
});

describe('extrusion: клин рампы', () => {
  const build = (over = {}) =>
    buildRampMeshes({
      runs: [lane()],
      texture: texture(),
      step: 10,
      shear: parallax.shear,
      baseScale: { x: 0.5, y: 0.5 },
      segments: volume.rampSegments,
      sideTint: volume.sideTint,
      ...over,
    });

  it('на прогон даёт юбку и поверхность, юбку — первой', () => {
    const [skirt, surface] = build();

    expect(skirt.k).toBeCloseTo(0, 6);
    expect(surface.k).toBeCloseTo(parallax.shear, 6);
    expect(skirt.target.tint).toBe(volume.sideTint);
  });

  // вершины авторятся сразу в МИРОВЫХ единицах: контейнер слоя единичный
  it('вершины стоят в мировых единицах (клетка × scale)', () => {
    const [, surface] = build();

    // колонка 2 при step 10 и scale 0.5 — это мировые 10
    const last = surface.base.length - 4;

    expect(surface.base[last]).toBeCloseTo(10, 6);
  });

  // юбка длинного прогона (terraces.rampLong — 9 клеток) длиннее порога
  // батчинга PixiJS (100 вершин): без явного `batchMode` её рисовал бы
  // общий шейдер `GlMeshAdaptor`, чья `BindGroup` ломается НАВСЕГДА на
  // уничтожении текстуры клина — пустой экран через одну смену карты
  it('меши клина батчатся и на длинном прогоне', () => {
    const [skirt, surface] = build({
      runs: [lane({ col1: 8, rail0: 0, rail1: 8 })],
    });

    expect(skirt.target.geometry.positions.length / 2).toBeGreaterThan(100);
    expect(skirt.target.batched).toBe(true);
    expect(surface.target.batched).toBe(true);
  });

  it('нисходящий прогон спускается от верхнего уровня к нижнему', () => {
    const [skirt, surface] = build({ runs: [lane({ from: 1, to: 0 })] });
    const { heights } = surface;

    // насыпь стоит на НИЖНЕМ уровне прогона
    expect(skirt.k).toBeCloseTo(0, 6);
    expect(heights[0]).toBeCloseTo(parallax.shear, 6);
    expect(heights[heights.length - 1]).toBeCloseTo(0, 6);
  });
});

describe('extrusion: сдвиг вершин камерой', () => {
  it('вершина уезжает от центра камеры тем сильнее, чем она выше', () => {
    const [, surface] = buildRampMeshes({
      runs: [lane()],
      texture: texture(),
      step: 10,
      shear: parallax.shear,
      baseScale: { x: 1, y: 1 },
      segments: 1,
      sideTint: volume.sideTint,
    });

    updateRampMesh(surface, { x: 0, y: 0 });

    const { target, base, heights } = surface;
    const shift = i =>
      Math.abs(target.vertices[i * 2] - base[i * 2]) +
      Math.abs(target.vertices[i * 2 + 1] - base[i * 2 + 1]);

    expect(heights[0]).toBe(0);
    expect(shift(0)).toBeCloseTo(0, 6);
    expect(shift(heights.length - 1)).toBeGreaterThan(0);
  });
});
