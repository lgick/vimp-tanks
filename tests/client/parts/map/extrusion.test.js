import { describe, it, expect } from 'vitest';
import { Texture, TextureSource } from 'pixi.js';
import {
  buildVolumeSlices,
  buildVolumeWalls,
  updateWallMesh,
  orderWallMesh,
  wallEdges,
  buildRampMeshes,
  updateHeightMesh,
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

describe('extrusion: грани монолитного объёма', () => {
  const build = (map, over = {}) =>
    buildVolumeWalls({
      map,
      tiles: [5],
      step: 10,
      baseScale: { x: 0.5, y: 0.5 },
      level: 0,
      volume: 1,
      shear: parallax.shear,
      sideTint: volume.sideTint,
      // боковая текстура — своя на тайл: полоса из копий его картинки
      textures: new Map([[5, texture()]]),
      tileRepeats: 4,
      ...over,
    });

  const quadsOf = slices =>
    slices.reduce((sum, slice) => sum + slice.facing.length, 0);

  it('одиночная клетка — 4 грани', () => {
    expect(quadsOf(build([[5]]))).toBe(4);
  });

  // соседние кромки одной стороны сливаются в прогон
  // грань на КЛЕТКУ кромки: каждая тянет картинку своего тайла, поэтому
  // соседние кромки не сливаются — по периметру блока 3×2 их 10
  it('прямоугольник 3×2 — грань на клетку периметра', () => {
    const map = [
      [5, 5, 5],
      [5, 5, 5],
    ];

    expect(wallEdges(map, new Set([5]))).toHaveLength(10);
    expect(quadsOf(build(map))).toBe(10);
  });

  // внутренний угол L-фигуры рёбер не даёт: соседняя клетка из набора
  it('L-образная фигура — только внешний контур', () => {
    const map = [
      [5, 0],
      [5, 5],
    ];
    const edges = wallEdges(map, new Set([5]));

    expect(edges).toHaveLength(8);

    // между (0,0) и (0,1) ребра нет
    expect(
      edges.some(e => e.ny !== 0 && e.y0 === 1 && e.x0 === 0 && e.x1 === 1),
    ).toBe(false);
  });

  it('кромки грани стоят на уровне слоя и на высоте объёма', () => {
    const [slice] = build([[5]], { level: 1, volume: 0.35 });

    expect(slice.k0).toBeCloseTo(parallax.shear, 6);
    expect(slice.k1).toBeCloseTo(1.35 * parallax.shear, 6);
    // порядок отрисовки — под верхом объёма, но выше его основания
    expect(slice.k).toBeLessThan(1.35 * parallax.shear);
    expect(slice.k).toBeGreaterThan(1.3 * parallax.shear);
    expect(slice.occluder).toBe(true);
    expect(slice.target.tint).toBe(volume.sideTint);
    expect(slice.target.batched).toBe(true);
  });

  // по ширине грани картинка тайла идёт ровно раз и не выходит за полосу:
  // на батченом меше аппаратный повтор не работает, координаты зажимаются
  it('ширина грани — ровно одна картинка тайла', () => {
    const [slice] = build([
      [5, 5],
      [0, 0],
    ]);
    const uvs = slice.target.geometry.uvs;

    for (let i = 0; i < uvs.length; i += 2) {
      expect(uvs[i]).toBeGreaterThanOrEqual(0);
      expect(uvs[i]).toBeLessThanOrEqual(1);
      expect(uvs[i + 1]).toBeLessThanOrEqual(1);
    }

    for (let q = 0; q < slice.facing.length; q += 1) {
      const v = q * 8;

      expect(Math.abs(uvs[v + 2] - uvs[v])).toBeCloseTo(1, 6);
      // верхняя и нижняя вершины одной стороны стоят на одной вертикали
      expect(uvs[v + 4]).toBeCloseTo(uvs[v], 6);
      expect(uvs[v + 6]).toBeCloseTo(uvs[v + 2], 6);
    }
  });

  // Экранная высота грани — `|p - cam| * (k1 - k0)`: у дальней от центра
  // камеры стены грань длиннее. Кирпич одного размера получается только
  // если на повтор текстуры приходится одна и та же экранная длина
  it('копий тайла по высоте тем больше, чем дальше грань от камеры', () => {
    const [near] = build([[5]]);
    const [far] = build([[5]]);
    const rise = parallax.shear;
    // мировая клетка: step 10 × baseScale 0.5
    const cellWorld = 5;
    const repeats = 4;
    // первый квад клетки — её северная грань: глубина считается по y
    const vOf = slice => slice.target.geometry.uvs[5];
    const depthOf = (slice, camera) => Math.abs(slice.base[5] - camera.y);

    const closeCam = { x: 6, y: 6, scaleX: 1 };
    const farCam = { x: 30, y: 30, scaleX: 1 };

    updateWallMesh(near, closeCam);
    updateWallMesh(far, farCam);

    expect(vOf(near)).toBeCloseTo(
      (depthOf(near, closeCam) * rise) / cellWorld / repeats,
      6,
    );
    // та же плотность кирпича: с глубиной растёт и длина грани на экране
    expect(vOf(far) / depthOf(far, farCam)).toBeCloseTo(
      vOf(near) / depthOf(near, closeCam),
      6,
    );
  });

  // Глубина берётся вдоль нормали грани, а не радиусом до камеры: вдоль
  // прямой стены радиус меняется, и ряды кирпича разъезжались веером —
  // стена выглядела выпуклой
  it('вдоль прямой стены ряды кирпича не расходятся', () => {
    const [slice] = build([
      [5, 5, 5, 5, 5],
      [0, 0, 0, 0, 0],
    ]);
    // камера стоит против середины стены, снизу от неё
    const camera = { x: 12.5, y: 60, scaleX: 1 };

    updateWallMesh(slice, camera);

    const uvs = slice.target.geometry.uvs;
    const north = [];

    for (let q = 0; q < slice.facing.length; q += 1) {
      if (slice.normals[q * 2 + 1] === -1) {
        north.push(uvs[q * 8 + 5]);
      }
    }

    expect(north.length).toBeGreaterThan(1);

    for (const v of north) {
      expect(v).toBeCloseTo(north[0], 6);
    }
  });

  // полоса конечна: у самой длинной грани координата упирается в её конец,
  // и последняя копия тайла тянется — за полосу выборка не уходит никогда
  it('очень длинная грань упирается в конец полосы', () => {
    const [slice] = build([[5]]);

    updateWallMesh(slice, { x: 0, y: 5000, scaleX: 1 });

    expect(slice.target.geometry.uvs[5]).toBe(1);
  });

  // стык с верхом объёма: нахлёст задаётся в ЭКРАННЫХ пикселях, поэтому на
  // отдалённой камере (масштаб сцены меньше) он шире в мировых единицах
  it('нахлёст под верх считается в экранных пикселях', () => {
    const slice = build([[5]])[0];
    const camera = { x: 50, y: 50, scaleX: 2 };
    const topAt = () => [slice.target.vertices[0], slice.target.vertices[1]];

    updateWallMesh(slice, camera, 0);

    const [x0, y0] = topAt();

    updateWallMesh(slice, camera, 4);

    const [x1, y1] = topAt();

    // 4 экранных пикселя при масштабе сцены 2 — это 2 мировые единицы
    // вершины лежат во Float32Array, поэтому сравнение не до шестого знака
    expect(Math.hypot(x1 - x0, y1 - y0)).toBeCloseTo(2, 4);

    // порядок отрисовки нахлёст не трогает: верх по-прежнему поверх грани
    expect(slice.k).toBeCloseTo(parallax.shear - 1e-6, 9);
  });

  it('длинный контур режется на несколько мешей', () => {
    // шахматка 50 × 50: у каждой из 1250 клеток все 4 стороны открыты
    const map = Array.from({ length: 50 }, (_, row) =>
      Array.from({ length: 50 }, (__, col) => ((row + col) % 2 ? 0 : 5)),
    );
    const slices = build(map);

    expect(slices.length).toBeGreaterThan(1);
    expect(quadsOf(slices)).toBe(1250 * 4);
  });

  describe('порядок граней', () => {
    // индекс первого вхождения квада `q` в списке индексов
    const positionOf = (slice, q) =>
      Array.from(slice.target.geometry.indices).indexOf(q * 4);
    const quadOf = (slice, nx, ny) => {
      for (let q = 0; q < slice.facing.length; q += 1) {
        if (slice.normals[q * 2] === nx && slice.normals[q * 2 + 1] === ny) {
          return q;
        }
      }

      return -1;
    };

    it('камера севернее блока — северная грань рисуется после южной', () => {
      const [slice] = build([[5]]);
      const north = quadOf(slice, 0, -1);
      const south = quadOf(slice, 0, 1);

      expect(orderWallMesh(slice, { x: 2.5, y: -100 })).toBe(true);
      expect(positionOf(slice, south)).toBeLessThan(positionOf(slice, north));

      // камера южнее — наоборот
      expect(orderWallMesh(slice, { x: 2.5, y: 100 })).toBe(true);
      expect(positionOf(slice, north)).toBeLessThan(positionOf(slice, south));
    });

    it('без смены сторон индексы не переписываются', () => {
      const [slice] = build([[5]]);

      orderWallMesh(slice, { x: 2.5, y: -100 });

      expect(orderWallMesh(slice, { x: 3, y: -90 })).toBe(false);
    });
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

    updateHeightMesh(surface, { x: 0, y: 0 });

    const { target, base, heights } = surface;
    const shift = i =>
      Math.abs(target.vertices[i * 2] - base[i * 2]) +
      Math.abs(target.vertices[i * 2 + 1] - base[i * 2 + 1]);

    expect(heights[0]).toBe(0);
    expect(shift(0)).toBeCloseTo(0, 6);
    expect(shift(heights.length - 1)).toBeGreaterThan(0);
  });
});
