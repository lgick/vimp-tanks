import { Sprite, MeshSimple } from 'pixi.js';

// Геометрия экструзии слоя: объём (`volume`) и клин рампы. Модуль чистый —
// он ничего не знает ни о парте, ни о сцене, ни о конфиге рендера: всё, что
// нужно (масштаб, сдвиг, тинт, число срезов), приходит параметрами, а
// наружу уходят готовые срезы формата `{ target, k, base, heights,
// occluder }` — тот же, что держит слой в `_slices`.

// Объём слоя: K копий ТОЙ ЖЕ запечённой картинки, каждая следующая
// сдвинута от центра камеры сильнее предыдущей. Срезы уходят в
// контейнер-перекрыватель (`occluder: true`), потому что им нужен zIndex
// выше динамики своего уровня.
export function buildVolumeSlices({
  bakedTexture,
  level,
  volume,
  shear,
  count,
  sideTint,
}) {
  const slices = [];

  for (let i = 1; i <= count; i += 1) {
    const sprite = new Sprite(bakedTexture);

    // нижние срезы — боковые грани блока, они темнее; верхний остаётся
    // самим слоем и рисуется последним, поверх остальных
    sprite.tint = i === count ? 0xffffff : sideTint;

    slices.push({
      target: sprite,
      k: (level + (volume * i) / count) * shear,
      occluder: true,
    });
  }

  return slices;
}

// Клин рампы: горка — наклонная ПЛОСКОСТЬ, а не лестница из срезов.
// На прогон строится один меш-полоса вдоль оси прогона; у каждой её
// вершины своя высота (`level + rise * progress`), поэтому сдвиг
// параллакса растёт вдоль прогона непрерывно, а не ступенями.
//
// Вершины авторятся сразу в МИРОВЫХ единицах (пиксель грида × scale
// слоя): контейнер статического слоя единичный, и меш в нём стоит без
// собственного трансформа — двигаются только его вершины
// (`updateRampMesh`)
export function buildRampMeshes({
  runs,
  texture,
  step,
  shear,
  baseScale,
  segments: segmentsPerCell,
  sideTint,
}) {
  const meshes = [];
  const bakedWidth = texture.width || 1;
  const bakedHeight = texture.height || 1;
  const perCell = Math.max(1, Math.round(segmentsPerCell) || 1);

  for (const run of runs) {
    const alongAxis = run.axis === 0;
    const cells = alongAxis ? run.col1 - run.col0 : run.row1 - run.row0;
    const segments = Math.max(1, cells * perCell);
    const x0 = run.col0 * step;
    const x1 = run.col1 * step;
    const y0 = run.row0 * step;
    const y1 = run.row1 * step;
    const points = segments + 1;
    // базовая плоскость прогона — его НИЖНИЙ уровень: у нисходящей
    // рампы (`from > to`) тайл лежит в гриде ВЕРХНЕГО, и насыпь стоит на
    // нижнем, а не на уровне слоя
    const low = Math.min(run.from, run.to);
    const high = Math.max(run.from, run.to);
    const kBase = low * shear;
    const base = new Float32Array(points * 4);
    const uvs = new Float32Array(points * 4);
    const skirtUvs = new Float32Array(points * 4);
    // высота каждой вершины в долях сдвига: её и просит offsetPoint
    const heights = new Float32Array(points * 2);
    const indices = new Uint32Array(segments * 6);

    // UV юбки берутся не с самой кромки прогона: дальняя кромка
    // (`col1`/`row1`) — это уже СЛЕДУЮЩАЯ клетка, тайла рампы в ней нет,
    // и вертикальная грань, растянувшая её пиксели, оказывалась
    // прозрачной — насыпь читалась как пустая с одной стороны. Сдвиг
    // внутрь на пиксель грида ставит выборку внутрь крайнего тайла и на
    // картинке не виден
    const uvInset = 1;

    for (let i = 0; i < points; i += 1) {
      const t = i / segments;
      // «в горку» у прогонов разных направлений — разная сторона
      // прямоугольника: знак берётся из run.sign, как в ядре
      const progress = run.sign > 0 ? t : 1 - t;
      // высота вершины — ровно то же `lerp(from, to, progress)`, по
      // которому ядро ведёт z танка (`core/src/level.rs`): у нисходящей
      // рампы подъём идёт от `from` ВНИЗ
      const k = (run.from + (run.to - run.from) * progress) * shear;
      const along0 = alongAxis ? x0 : y0;
      const along1 = alongAxis ? x1 : y1;
      const along = along0 + (along1 - along0) * t;
      const ax = alongAxis ? along : x0;
      const ay = alongAxis ? y0 : along;
      const bx = alongAxis ? along : x1;
      const by = alongAxis ? y1 : along;
      const slot = i * 4;

      base[slot] = ax * baseScale.x;
      base[slot + 1] = ay * baseScale.y;
      base[slot + 2] = bx * baseScale.x;
      base[slot + 3] = by * baseScale.y;

      uvs[slot] = ax / bakedWidth;
      uvs[slot + 1] = ay / bakedHeight;
      uvs[slot + 2] = bx / bakedWidth;
      uvs[slot + 3] = by / bakedHeight;

      // те же точки, подтянутые внутрь прогона: ими текстурируется юбка
      const insetA = alongAxis ? ay + uvInset : ax + uvInset;
      const insetB = alongAxis ? by - uvInset : bx - uvInset;
      const alongInset = Math.min(
        Math.max(along, (alongAxis ? x0 : y0) + uvInset),
        (alongAxis ? x1 : y1) - uvInset,
      );

      skirtUvs[slot] = (alongAxis ? alongInset : insetA) / bakedWidth;
      skirtUvs[slot + 1] = (alongAxis ? insetA : alongInset) / bakedHeight;
      skirtUvs[slot + 2] = (alongAxis ? alongInset : insetB) / bakedWidth;
      skirtUvs[slot + 3] = (alongAxis ? insetB : alongInset) / bakedHeight;

      heights[i * 2] = k;
      heights[i * 2 + 1] = k;
    }

    for (let i = 0; i < segments; i += 1) {
      const v = i * 2;
      const slot = i * 6;

      indices[slot] = v;
      indices[slot + 1] = v + 1;
      indices[slot + 2] = v + 3;
      indices[slot + 3] = v;
      indices[slot + 4] = v + 3;
      indices[slot + 5] = v + 2;
    }

    const mesh = new MeshSimple({
      texture,
      vertices: base.slice(),
      uvs,
      indices,
    });

    // юбка рисуется ДО поверхности (её k — базовая плоскость прогона),
    // поэтому кладётся первой: сортировка срезов по k это же и даёт
    meshes.push(
      buildRampSkirt({
        base,
        uvs: skirtUvs,
        heights,
        points,
        texture,
        kBase,
        sideTint,
        // «верх» прогона: там торец закрыт, у подножия он остаётся
        // открытым — это законный вход
        endIndex: run.sign > 0 ? points - 1 : 0,
      }),
    );

    meshes.push({
      target: mesh,
      // порядок отрисовки — по вершине клина: выше всего он у своего
      // верхнего торца, там же он и обязан перекрывать соседей
      k: high * shear,
      base,
      heights,
    });
  }

  return meshes;
}

// Юбка клина: горка — насыпь, а не парящая плоскость. Под поверхностью
// прогона видна была бы земля, и карта врала бы — «пусто, значит проеду»,
// хотя борта прогона закрыты коллайдерами-стражами движка
// (`packages/engine/core/src/map.rs`, RAMP_GUARD_GROUP).
//
// Строятся ровно те грани, что закрыты физически: два борта ВДОЛЬ оси
// (по обеим поперечным границам прогона) и торец на ВЕРХНЕМ конце.
// Нижний торец остаётся открытым — через него на горку и заезжают.
// Нижняя кромка ложится на базовую плоскость прогона (`kBase`), поэтому у
// прогона 1 → 2 под юбкой остаётся видимый просвет — и проезд там
// действительно есть.
//
// Ближняя к камере грань видна, дальняя всегда накрыта поверхностью,
// поэтому выбирать сторону в рантайме не нужно.
export function buildRampSkirt(surface) {
  const { base, uvs, heights, points, texture, kBase, endIndex, sideTint } =
    surface;
  // колонки юбки: борт по одной поперечной границе, борт по другой и
  // две колонки торца
  const columns = points * 2 + 2;
  const skirtBase = new Float32Array(columns * 4);
  const skirtUvs = new Float32Array(columns * 4);
  const skirtHeights = new Float32Array(columns * 2);
  // квадов: по (points - 1) на каждый борт плюс один торцевой
  const quads = (points - 1) * 2 + 1;
  const indices = new Uint32Array(quads * 6);

  // источник вершины поверхности для колонки юбки: сперва борт A, затем
  // борт B, затем пара торца
  const sourceOf = column => {
    if (column < points) {
      return column * 2;
    }

    if (column < points * 2) {
      return (column - points) * 2 + 1;
    }

    return endIndex * 2 + (column - points * 2);
  };

  for (let column = 0; column < columns; column += 1) {
    const source = sourceOf(column);
    const slot = column * 4;
    const x = base[source * 2];
    const y = base[source * 2 + 1];

    // верхняя кромка идёт по поверхности, нижняя стоит в той же мировой
    // точке — разводит их только высота
    skirtBase[slot] = x;
    skirtBase[slot + 1] = y;
    skirtBase[slot + 2] = x;
    skirtBase[slot + 3] = y;

    // UV нижней кромки — те же, что у верхней: пиксели кромки тянутся
    // вниз по грани
    skirtUvs[slot] = uvs[source * 2];
    skirtUvs[slot + 1] = uvs[source * 2 + 1];
    skirtUvs[slot + 2] = uvs[source * 2];
    skirtUvs[slot + 3] = uvs[source * 2 + 1];

    skirtHeights[column * 2] = heights[source];
    skirtHeights[column * 2 + 1] = kBase;
  }

  let quad = 0;

  for (let strip = 0; strip < 3; strip += 1) {
    const first = strip === 2 ? points * 2 : strip * points;
    const last = strip === 2 ? points * 2 + 1 : first + points - 1;

    for (let column = first; column < last; column += 1) {
      const v = column * 2;
      const slot = quad * 6;

      indices[slot] = v;
      indices[slot + 1] = v + 1;
      indices[slot + 2] = v + 3;
      indices[slot + 3] = v;
      indices[slot + 4] = v + 3;
      indices[slot + 5] = v + 2;

      quad += 1;
    }
  }

  const mesh = new MeshSimple({
    texture,
    vertices: skirtBase.slice(),
    uvs: skirtUvs,
    indices,
  });

  // боковая грань насыпи темнее её поверхности — ровно как у объёмов
  mesh.tint = sideTint;

  return {
    target: mesh,
    k: kBase,
    base: skirtBase,
    heights: skirtHeights,
  };
}

// Вершины клина рампы: у каждой своя высота, поэтому контейнерным
// трансформом (applyParallax) их не сдвинуть — считаем поточечно той же
// формулой, что и offsetPoint (src/client/parallax.js)
export function updateRampMesh(slice, camera) {
  const { target, base, heights } = slice;
  const vertices = target.vertices;

  for (let i = 0, len = heights.length; i < len; i += 1) {
    const x = base[i * 2];
    const y = base[i * 2 + 1];
    const k = heights[i];

    vertices[i * 2] = x + (x - camera.x) * k;
    vertices[i * 2 + 1] = y + (y - camera.y) * k;
  }

  // autoUpdate меша заливает буфер позиций сам на ближайшем рендере
  target.vertices = vertices;
}
