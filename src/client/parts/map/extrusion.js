import { Sprite, MeshSimple } from 'pixi.js';

// Геометрия экструзии слоя: объём (`volume`) и клин рампы. Модуль чистый —
// он ничего не знает ни о парте, ни о сцене, ни о конфиге рендера: всё, что
// нужно (масштаб, сдвиг, тинт, число срезов), приходит параметрами, а
// наружу уходят готовые срезы формата `{ target, k, base, heights,
// occluder, walls }` — тот же, что держит слой в `_slices`.

// Меш с повершинной высотой (клин рампы, грани объёма) ВСЕГДА рисуется
// батчером. При `batchMode: 'auto'` PixiJS
// отправляет меш длиннее 100 вершин (`Mesh.batched`) в обход батчера — в
// общий на весь рендерер шейдер `GlMeshAdaptor`. Тот держит источник
// текстуры в своей `BindGroup`, а уничтожение источника (смена карты
// освобождает текстуру клина) обнуляет её НАВСЕГДА: `BindGroup` слушает
// `change`, видит `destroyed` и делает `resources = null`. Следующий
// небатченый меш падает в `BindGroup.setResource` на чтении `resources[0]`
// — пустой экран через одну смену карты. Батченый меш общего шейдера не
// касается, поэтому режим задаётся явно и не зависит от длины прогона.
function batchedMesh(options) {
  const mesh = new MeshSimple(options);

  mesh.geometry.batchMode = 'batch';

  return mesh;
}

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

// Монолитный объём: боковые грани одним мешем вместо стопки срезов. Когда
// сдвиг верха больше нескольких пикселей (край экрана, отдалённая камера),
// между копиями слоя видны ступени — здание «из слоёв». Грань — квад
// от кромки на высоте уровня слоя до той же кромки на высоте `level +
// volume`: сдвиг вдоль неё растёт непрерывно, как у юбки рампы.
//
// Кромки строятся только там, где соседняя клетка не из набора тайлов
// слоя: внутренние рёбра здания закрыты его же верхом. Грань — на КАЖДУЮ
// открытую сторону клетки.
//
// Текстура грани — НЕ общая запечённая картинка слоя, а своя на тайл:
// ПОЛОСА из `faceTileRepeats` копий его картинки по вертикали (печёт
// `layerAssets.js`). Полоса, а не повтор координат: аппаратный повтор
// (`addressMode: 'repeat'`) на батченом меше не действует — координаты
// зажимаются, и грань размазывала крайний столбец тайла горизонтальными
// полосами. По ширине грани тайл идёт ровно раз, по высоте — столько
// копий полосы, сколько грань занимает на экране (`updateWallMesh`),
// поэтому кирпич везде одного размера.
//
// Верх объёма (копия слоя на высоте `level + volume`) здесь не строится:
// это спрайт запечённой текстуры, его кладёт сборка слоя (`layerAssets.js`)

// сдвиг граней под верх: срезы сортируются по k, и грань обязана
// нарисоваться раньше верха своего объёма
const WALL_EPSILON = 1e-6;

// квадов на меш: батч PixiJS не любит огромные меши, поэтому длинная
// береговая линия режется на несколько
const MAX_WALL_QUADS = 1000;

// ровно 4 вершины на квад: две на верхней кромке, две на нижней
const QUAD_INDICES = [0, 1, 3, 0, 3, 2];

// Открытые кромки объёма — по одной на СТОРОНУ КЛЕТКИ:
// `{ col, row, nx, ny, x0, y0, x1, y1 }`, где (nx, ny) — внешняя нормаль
// грани, отрезок (x0, y0)–(x1, y1) — само ребро на границах клеток, а
// (col, row) — клетка, чьим тайлом грань и текстурируется.
//
// Соседние кромки НЕ сливаются в прогон: каждая грань тянет картинку
// СВОЕЙ клетки (`buildVolumeWalls`), а тайлы лежат в общей запечённой
// текстуре без повтора — склеенная грань растянула бы один тайл на всю
// стену. Цена — квад на клетку кромки (у `downtown` это ~1700 квадов на
// всю карту, доли миллисекунды на кадр)
export function wallEdges(map, tileSet) {
  const edges = [];
  const rows = map.length;
  const cols = map.reduce((max, row) => Math.max(max, row.length), 0);
  const has = (col, row) => {
    const tile = map[row]?.[col];

    return tile !== undefined && tileSet.has(tile);
  };

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      if (!has(col, row)) {
        continue;
      }

      // северная и южная стороны клетки: ребро идёт по колонке
      for (const ny of [-1, 1]) {
        if (has(col, row + ny)) {
          continue;
        }

        const y = ny < 0 ? row : row + 1;

        edges.push({
          tile: map[row][col],
          col,
          row,
          nx: 0,
          ny,
          x0: col,
          y0: y,
          x1: col + 1,
          y1: y,
        });
      }

      // западная и восточная: ребро идёт по строке
      for (const nx of [-1, 1]) {
        if (has(col + nx, row)) {
          continue;
        }

        const x = nx < 0 ? col : col + 1;

        edges.push({
          tile: map[row][col],
          col,
          row,
          nx,
          ny: 0,
          x0: x,
          y0: row,
          x1: x,
          y1: row + 1,
        });
      }
    }
  }

  return edges;
}

export function buildVolumeWalls({
  map,
  tiles,
  step,
  baseScale,
  level,
  volume,
  shear,
  sideTint,
  textures,
  tileRepeats = 1,
}) {
  const edges = wallEdges(map, new Set(tiles));
  const k0 = level * shear;
  const k1 = (level + volume) * shear;
  // порядок отрисовки — по верху объёма: грань обязана лечь ПОД верх, даже
  // когда нахлёст кадра (`faceBleedPx`) поднимает её кромку выше него
  const kSort = k1 - WALL_EPSILON;
  // мировой размер клетки: в него укладывается ровно один повтор текстуры
  // грани и по ширине, и по высоте — кирпич выходит квадратным
  const cellWorld = step * baseScale.x;
  const slices = [];
  // грани группируются по тайлу: у каждого своя текстура с повтором
  const byTile = new Map();

  for (const edge of edges) {
    if (!byTile.has(edge.tile)) {
      byTile.set(edge.tile, []);
    }

    byTile.get(edge.tile).push(edge);
  }

  for (const [tile, tileEdges] of byTile) {
    const texture = textures?.get(tile);

    if (!texture) {
      console.warn(`buildVolumeWalls: no side texture for tile ${tile}`);
      continue;
    }

    for (let first = 0; first < tileEdges.length; first += MAX_WALL_QUADS) {
      const chunk = tileEdges.slice(first, first + MAX_WALL_QUADS);
      const quads = chunk.length;
      const base = new Float32Array(quads * 8);
      const uvs = new Float32Array(quads * 8);
      const indices = new Uint32Array(quads * 6);
      // нормаль и центр ребра на квад: по ним грань каждый кадр решает,
      // смотрит ли она на камеру (`orderWallMesh`)
      const normals = new Float32Array(quads * 2);
      const centers = new Float32Array(quads * 2);

      for (let q = 0; q < quads; q += 1) {
        const { nx, ny, x0, y0, x1, y1 } = chunk[q];
        const ax = x0 * step;
        const ay = y0 * step;
        const bx = x1 * step;
        const by = y1 * step;
        // по ширине грани тайл идёт ровно раз: клетка — это и есть его
        // ширина, поэтому координаты остаются в пределах картинки
        const ua = 0;
        const ub = 1;
        const v = q * 4;

        // вершины 0, 1 — верхняя кромка, 2, 3 — нижняя, в тех же точках
        for (let i = 0; i < 4; i += 1) {
          const atB = i % 2 === 1;
          const top = i < 2;
          const slot = (v + i) * 2;

          base[slot] = (atB ? bx : ax) * baseScale.x;
          base[slot + 1] = (atB ? by : ay) * baseScale.y;
          uvs[slot] = atB ? ub : ua;
          // высота грани на экране зависит от удаления клетки от центра
          // камеры, поэтому нижняя координата считается в кадре
          // (`updateWallMesh`); здесь — стартовое значение до первого кадра
          uvs[slot + 1] = top ? 0 : 1 / tileRepeats;
        }

        for (let i = 0; i < 6; i += 1) {
          indices[q * 6 + i] = v + QUAD_INDICES[i];
        }

        normals[q * 2] = nx;
        normals[q * 2 + 1] = ny;
        centers[q * 2] = ((ax + bx) / 2) * baseScale.x;
        centers[q * 2 + 1] = ((ay + by) / 2) * baseScale.y;
      }

      const mesh = batchedMesh({
        texture,
        vertices: base.slice(),
        uvs,
        indices,
      });

      mesh.tint = sideTint;

      slices.push({
        target: mesh,
        k: kSort,
        base,
        k0,
        k1,
        cellWorld,
        tileRepeats,
        occluder: true,
        walls: true,
        normals,
        centers,
        // сторона каждого квада на прошлом кадре: 2 — ещё не считалась
        facing: new Uint8Array(quads).fill(2),
      });
    }
  }

  return slices;
}

// Кадр грани объёма: вершины и UV по высоте.
//
// Грань нарисована от кромки клетки до неё же, поднятой на высоту объёма,
// поэтому её длина на экране растёт с удалением от центра камеры.
// Растянутая на разную длину картинка давала кирпич разного размера,
// поэтому нижняя UV-координата считается каждый кадр.
//
// Считается она по ГЛУБИНЕ грани — расстоянию до центра камеры вдоль её
// нормали, а не по радиусу `|p - cam|`. Вдоль прямой стены радиус меняется
// (в середине он меньше, по краям больше), и ряды кирпича разъезжались
// веером — стена читалась выпуклой. Глубина вдоль нормали вдоль такой
// стены постоянна, поэтому ряды идут параллельно, а размер кирпича
// остаётся тем же: и глубина, и экранная длина грани растут вместе.
//
// На одну копию тайла в полосе приходится `cellWorld` мировых единиц —
// столько же, сколько по ширине грани. Полоса конечна, поэтому у самых
// длинных граней координата упирается в её конец и последняя копия
// тянется.
//
// `bleedPx` — нахлёст под верх объёма в ЭКРАННЫХ пикселях: щель между
// мешем грани и спрайтом верха открывается на дробном масштабе сцены, а
// движок плавно меняет зум от скорости, поэтому запас в мировых единицах
// на отдалённой камере переставал её закрывать
export function updateWallMesh(slice, camera, bleedPx = 0) {
  const { target, base, k0, k1, cellWorld, tileRepeats, normals } = slice;
  const vertices = target.vertices;
  const uvs = target.geometry.uvs;
  const rise = k1 - k0;
  const bleedWorld = bleedPx && camera.scaleX ? bleedPx / camera.scaleX : 0;

  for (let i = 0, len = base.length / 2; i < len; i += 1) {
    const x = base[i * 2];
    const y = base[i * 2 + 1];
    const dx = x - camera.x;
    const dy = y - camera.y;
    // клетка ровно в центре камеры сдвига не получает: делить на ноль
    // нельзя, а нахлёст и высота там и так вырождены
    const dist = Math.sqrt(dx * dx + dy * dy) || 1e-6;
    const top = i % 4 < 2;
    // нахлёст под верх — вдоль луча от камеры: так он остаётся ровно
    // `bleedPx` экранными пикселями на любом удалении
    const k = top ? k1 + bleedWorld / dist : k0;

    vertices[i * 2] = x + dx * k;
    vertices[i * 2 + 1] = y + dy * k;

    if (!top) {
      const quad = i >> 2;
      const depth = normals[quad * 2 + 1] !== 0 ? Math.abs(dy) : Math.abs(dx);
      const span = (depth * rise) / cellWorld / tileRepeats;

      uvs[i * 2 + 1] = span > 1 ? 1 : span;
    }
  }

  // autoUpdate меша заливает буфер позиций сам; UV обновляются вручную —
  // сеттер буфера видит тот же массив и только отмечает его грязным
  target.vertices = vertices;
  target.geometry.uvs = uvs;
}

// Порядок граней объёма. Грань, отвёрнутая от камеры, обязана рисоваться
// раньше видимой: иначе дальняя грань узкой стены ложится поверх ближней.
// Индексы переписываются только при смене стороны хоть одного квада.
// Возвращает true, если порядок поменялся
export function orderWallMesh(slice, camera) {
  const { target, normals, centers, facing } = slice;
  const quads = facing.length;
  let changed = false;

  for (let q = 0; q < quads; q += 1) {
    const dot =
      normals[q * 2] * (camera.x - centers[q * 2]) +
      normals[q * 2 + 1] * (camera.y - centers[q * 2 + 1]);
    const front = dot > 0 ? 1 : 0;

    if (facing[q] !== front) {
      facing[q] = front;
      changed = true;
    }
  }

  if (!changed) {
    return false;
  }

  const indices = target.geometry.indices;
  let slot = 0;

  // сначала отвёрнутые (0), затем смотрящие на камеру (1)
  for (let pass = 0; pass < 2; pass += 1) {
    for (let q = 0; q < quads; q += 1) {
      if (facing[q] !== pass) {
        continue;
      }

      for (let i = 0; i < 6; i += 1) {
        indices[slot] = q * 4 + QUAD_INDICES[i];
        slot += 1;
      }
    }
  }

  // тот же массив: сеттер буфера только отмечает обновление
  target.geometry.indices = indices;

  return true;
}

// Клин рампы: горка — наклонная ПЛОСКОСТЬ, а не лестница из срезов.
// На прогон строится один меш-полоса вдоль оси прогона; у каждой её
// вершины своя высота (`level + rise * progress`), поэтому сдвиг
// параллакса растёт вдоль прогона непрерывно, а не ступенями.
//
// Вершины авторятся сразу в МИРОВЫХ единицах (пиксель грида × scale
// слоя): контейнер статического слоя единичный, и меш в нём стоит без
// собственного трансформа — двигаются только его вершины
// (`updateHeightMesh`)
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
    // борта юбки строятся ровно по границам стражей прогона: их отдаёт
    // ядро (`map::ramp_rail_span`), а не считает эта функция — вторая
    // копия отступа рисовала бы стену там, где физика пускает
    const along0Cell = alongAxis ? run.col0 : run.row0;
    const rails =
      typeof run.rail0 === 'number' && typeof run.rail1 === 'number'
        ? {
            first: (run.rail0 - along0Cell) * perCell,
            last: (run.rail1 - along0Cell) * perCell,
          }
        : null;
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

    const mesh = batchedMesh({
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
        rails,
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
// Борта идут не во всю длину прогона, а ровно между `rails.first` и
// `rails.last` — вершинами, отвечающими границам коллайдеров-стражей
// (`map::ramp_rail_span` в ядре движка): клетка подножия открыта со всех
// сторон, а у прогона длиной в одну клетку бортов нет вовсе (`rails`
// равен null) — тогда от юбки остаётся один торец.
//
// Ближняя к камере грань видна, дальняя всегда накрыта поверхностью,
// поэтому выбирать сторону в рантайме не нужно.
export function buildRampSkirt(surface) {
  const {
    base,
    uvs,
    heights,
    points,
    texture,
    kBase,
    endIndex,
    sideTint,
    rails,
  } = surface;
  // вершин в одном борту: у прогона без бортов их нет вовсе
  const railFirst = rails ? Math.max(0, Math.min(rails.first, points - 1)) : 0;
  const railLast = rails
    ? Math.max(railFirst, Math.min(rails.last, points - 1))
    : -1;
  const railPoints = rails ? railLast - railFirst + 1 : 0;
  // колонки юбки: борт по одной поперечной границе, борт по другой и
  // две колонки торца
  const columns = railPoints * 2 + 2;
  const skirtBase = new Float32Array(columns * 4);
  const skirtUvs = new Float32Array(columns * 4);
  const skirtHeights = new Float32Array(columns * 2);
  // квадов: по (railPoints - 1) на каждый борт плюс один торцевой
  const quads = Math.max(0, railPoints - 1) * 2 + 1;
  const indices = new Uint32Array(quads * 6);

  // источник вершины поверхности для колонки юбки: сперва борт A, затем
  // борт B, затем пара торца
  const sourceOf = column => {
    if (column < railPoints) {
      return (railFirst + column) * 2;
    }

    if (column < railPoints * 2) {
      return (railFirst + column - railPoints) * 2 + 1;
    }

    return endIndex * 2 + (column - railPoints * 2);
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
    const first = strip === 2 ? railPoints * 2 : strip * railPoints;
    const last = strip === 2 ? railPoints * 2 + 1 : first + railPoints - 1;

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

  const mesh = batchedMesh({
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

// Вершины меша с высотой (клин рампы, грани объёма): у каждой своя высота,
// поэтому контейнерным трансформом (applyParallax) их не сдвинуть —
// считаем поточечно той же формулой, что и offsetPoint
// (src/client/parallax.js)
export function updateHeightMesh(slice, camera) {
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
