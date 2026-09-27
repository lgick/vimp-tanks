import {
  anyCellIn,
  castRay,
  coneFan,
  coneUv,
  fanUvs,
  firstHit,
  rampBlocks,
  rampHeight,
  wallWash,
} from './lightMath.js';

// отступ отсвета фары от стены в долях его радиуса
const BOUNCE_PULL = 0.6;

// Раскладка текстуры источника в мировых единицах — `coneUv`: вершина
// конуса (центр пятна) — в `(margin, height / 2)` текстуры, ось — по
// `rotation`, `sx`/`sy` — мировых единиц на пиксель вдоль и поперёк. Та
// же, что у спрайта `itemOf` (createLighting.js): у пятна `margin` —
// полширины, поворота нет
export function frameOf(light, asset) {
  const { width, height } = asset.texture;

  if (light.kind === 'cone') {
    return {
      x: light.x,
      y: light.y,
      rotation: light.rotation || 0,
      sx: light.radius / asset.length,
      sy: (light.radius * (light.spread ?? 0.5)) / asset.halfWidth,
      margin: asset.margin,
      width,
      height,
    };
  }

  const size = (light.radius * 2) / asset.contentSize;

  return {
    x: light.x,
    y: light.y,
    rotation: 0,
    sx: size,
    sy: size,
    margin: width / 2,
    width,
    height,
  };
}

// Препятствия свету фар и окклюзия конусов сервиса `lighting`: сетка стен и
// рамп по уровням, веер фары у стены, упор оси, засветка грани и отсвет.
// `getMap()` — текущее состояние карты сервиса (сетки `blockers` и
// `rampCells` живут в нём и уходят вместе с картой)
export function createOcclusion({ getMap, cfg }) {
  // веера фар у стен: источник -> { key, shape, hit }. Пересчёт — только
  // когда фара сдвинулась, повернулась или сменилась сетка препятствий
  const fans = new WeakMap();
  // номер сборки сетки препятствий (`sync`): ключ кеша вееров
  let blockersVersion = 0;

  // Сетка препятствий свету фар: на уровень — клетки его объёмов с высотой
  // (стены зданий, канала, перила; то же, что закрывают вершины `setTops`)
  // и клетки рамп, ведущих с него вверх. `tops`/`ramps` — вклады частей
  // сервиса: level -> Map(owner -> { cells, volume }) и level -> Map(owner
  // -> lanes)
  const sync = (tops, ramps) => {
    const map = getMap();

    map.blockers = new Map();
    map.rampCells = new Map();
    blockersVersion += 1;

    const { cols, rows } = map;

    if (!(cols > 0 && rows > 0)) {
      return;
    }

    const inside = (col, row) => col >= 0 && col < cols && row >= 0 && row < rows;

    for (const [level, byOwner] of tops) {
      let grid = null;

      for (const { cells, volume } of byOwner.values()) {
        for (const [col, row] of cells) {
          if (inside(col, row)) {
            grid ||= new Float32Array(cols * rows);
            grid[row * cols + col] = Math.max(grid[row * cols + col], volume);
          }
        }
      }

      if (grid) {
        map.blockers.set(level, grid);
      }
    }

    for (const [level, byOwner] of ramps) {
      const lanes = [...byOwner.values()].flat();

      if (!lanes.length) {
        continue;
      }

      const cells = new Int32Array(cols * rows);

      lanes.forEach((lane, index) => {
        for (let row = lane.row0; row < lane.row1; row += 1) {
          for (let col = lane.col0; col < lane.col1; col += 1) {
            if (inside(col, row)) {
              cells[row * cols + col] = index + 1;
            }
          }
        }
      });

      map.rampCells.set(level, { cells, lanes });
    }
  };

  // Препятствия свету фары `light` на её уровне: `isBlocked` для
  // `castRay`; null — ни стен, ни рамп на уровне нет. На полосу, где
  // стоит сама фара, правила рамп (`rampBlocks`) не действуют: танк на
  // склоне светит по нему как раньше
  const obstaclesFor = light => {
    const map = getMap();
    const level = light.level ?? 0;
    const grid = map.blockers.get(level) || null;
    const { cols, rows } = map;
    const cellW = map.step * map.scale.x;
    const cellH = map.step * map.scale.y;
    const indexOf = (col, row) =>
      col >= 0 && col < cols && row >= 0 && row < rows ? row * cols + col : -1;
    const ramp = map.rampCells.get(level) || null;

    if (!grid && !ramp) {
      return null;
    }

    const laneAt = index => (ramp && index >= 0 && ramp.cells[index] > 0
      ? ramp.lanes[ramp.cells[index] - 1]
      : null);
    // полоса, на которой стоит сама фара: танк на склоне светит по ней
    // как раньше, а соседние горки загораживают его свет по общим правилам
    const home = laneAt(
      indexOf(Math.floor(light.x / cellW), Math.floor(light.y / cellH)),
    );
    return (col, row, prevCol, prevRow, x, y) => {
      const index = indexOf(col, row);

      if (grid && index >= 0 && grid[index] > 0) {
        return true;
      }

      if (!ramp || prevCol === null || prevCol === undefined) {
        return false;
      }

      const lane = laneAt(index);
      const prevLane = laneAt(indexOf(prevCol, prevRow));

      if (home && (lane === home || prevLane === home)) {
        return false;
      }

      return rampBlocks({
        lane,
        prevLane,
        col,
        row,
        prevCol,
        prevRow,
        x,
        y,
        z: light.z ?? level,
        cellW,
        cellH,
      });
    };
  };

  // Есть ли клетка стены или рампы уровня фары в мировом AABB
  // прямоугольника текстуры конуса: вдоль оси от `-alongBack` до
  // `alongMax`, поперёк `±acrossMax`. Запас в клетку на кромки
  const obstaclesNear = (light, rotation, alongMax, alongBack, acrossMax) => {
    const map = getMap();
    const level = light.level ?? 0;
    const { cols, rows } = map;
    const cellW = map.step * map.scale.x;
    const cellH = map.step * map.scale.y;
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const along of [-alongBack, alongMax]) {
      for (const across of [-acrossMax, acrossMax]) {
        const x = light.x + along * cos - across * sin;
        const y = light.y + along * sin + across * cos;

        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }

    const col0 = Math.floor(minX / cellW) - 1;
    const row0 = Math.floor(minY / cellH) - 1;
    const col1 = Math.floor(maxX / cellW) + 1;
    const row1 = Math.floor(maxY / cellH) + 1;

    return (
      anyCellIn(map.blockers.get(level), cols, rows, col0, row0, col1, row1) ||
      anyCellIn(
        map.rampCells.get(level)?.cells,
        cols,
        rows,
        col0,
        row0,
        col1,
        row1,
      )
    );
  };

  const occlusionCfg = () => cfg.headlights?.occlusion;

  // объём стены уровня в мировой точке по сетке препятствий; 0 — не стена
  const volumeAt = (level, x, y) => {
    const map = getMap();
    const grid = map.blockers.get(level);
    const col = Math.floor(x / (map.step * map.scale.x));
    const row = Math.floor(y / (map.step * map.scale.y));

    if (!grid || col < 0 || col >= map.cols || row < 0 || row >= map.rows) {
      return 0;
    }

    return grid[row * map.cols + col];
  };

  // высота клина рампы уровня над ним в мировой точке; 0 — не рампа
  const rampHeightAt = (level, x, y) => {
    const map = getMap();
    const ramp = map.rampCells.get(level);
    const cellW = map.step * map.scale.x;
    const cellH = map.step * map.scale.y;
    const col = Math.floor(x / cellW);
    const row = Math.floor(y / cellH);

    if (!ramp || col < 0 || col >= map.cols || row < 0 || row >= map.rows) {
      return 0;
    }

    const index = ramp.cells[row * map.cols + col];

    return index > 0
      ? rampHeight(ramp.lanes[index - 1], x, y, cellW, cellH) - level
      : 0;
  };

  // Веер фары у стены и точка упора её оси — `{ shape, hit }`: `shape` —
  // null, пока конус никуда не упёрся (рисуется прежним спрайтом). Без
  // окклюзии, без стен на уровне или без текстуры — null
  const occlusionOf = (light, asset) => {
    const occlusion = occlusionCfg();

    if (!occlusion?.enabled || !asset || !(light.radius > 0)) {
      return null;
    }

    const level = light.level ?? 0;
    const rotation = light.rotation || 0;
    const spread = light.spread ?? 0.5;
    // высота — в ключе: от неё зависит, пропустит ли фару борт рампы
    const key = `${light.x},${light.y},${light.z},${rotation},${level},${light.radius},${spread},${blockersVersion},${occlusion.rays}`;
    const cached = fans.get(light);

    if (cached && cached.key === key && cached.texture === asset.texture) {
      return cached;
    }

    const isBlocked = obstaclesFor(light);

    if (!isBlocked) {
      return null;
    }

    const map = getMap();
    const cellW = map.step * map.scale.x;
    const cellH = map.step * map.scale.y;
    const frame = frameOf(light, asset);
    const alongMax = (frame.width - frame.margin) * frame.sx;
    const alongBack = frame.margin * frame.sx;
    const acrossMax = (frame.height / 2) * frame.sy;

    // В прямоугольнике текстуры конуса нет ни стены, ни рампы — лучи
    // ничего не встретят: веер не обрежется (`shape: null`), а ось длиной
    // `light.radius ≤ alongMax` не упрётся (`hit: null`). Едущий танк в
    // открытом поле не платит за 64+ луча каждый кадр
    if (!obstaclesNear(light, rotation, alongMax, alongBack, acrossMax)) {
      const result = {
        key,
        texture: asset.texture,
        shape: null,
        hit: null,
        wash: null,
        fan: null,
      };

      fans.set(light, result);

      return result;
    }

    const { points, clipped, closed, reaches, forward } = coneFan(
      {
        x: light.x,
        y: light.y,
        rotation,
        alongMax,
        alongBack,
        acrossMax,
        rays: occlusion.rays,
      },
      isBlocked,
      cellW,
      cellH,
    );
    const wash = cfg.headlights?.wash;
    const result = {
      key,
      texture: asset.texture,
      shape: clipped ? { points, closed, uvs: fanUvs(points, frame) } : null,
      hit: firstHit(
        light.x,
        light.y,
        Math.cos(rotation),
        Math.sin(rotation),
        light.radius,
        isBlocked,
        cellW,
        cellH,
      ),
      // веер целиком, даже не обрезанный: свет на клиньях рамп (`rampLight`)
      fan: { points, closed, frame },
      // часть луча, упёршаяся в стену или в борт насыпи рампы, — на её
      // видимой грани
      wash:
        wash?.intensity > 0
          ? wallWash({
              x: light.x,
              y: light.y,
              points,
              reaches,
              forward,
              uvOf: (px, py) => coneUv(px, py, frame),
              wallAt: (wx, wy) =>
                Math.max(
                  volumeAt(level, wx, wy),
                  rampHeightAt(level, wx, wy),
                ),
              cellW,
              cellH,
              height: wash.height,
            })
          : null,
    };

    fans.set(light, result);

    return result;
  };

  // видна ли точка из фары: между ними нет стены уровня фары
  const reachesPoint = (light, x, y) => {
    if (light.kind !== 'cone' || !occlusionCfg()?.enabled) {
      return true;
    }

    const isBlocked = obstaclesFor(light);

    if (!isBlocked) {
      return true;
    }

    const distance = Math.hypot(x - light.x, y - light.y);

    if (distance < 1e-6) {
      return true;
    }

    const map = getMap();

    return (
      castRay(
        light.x,
        light.y,
        (x - light.x) / distance,
        (y - light.y) / distance,
        distance,
        isBlocked,
        map.step * map.scale.x,
        map.step * map.scale.y,
      ) >= distance
    );
  };

  // Отсвет фары от стены: радиальное пятно на полу перед точкой упора оси,
  // сила — доля фары, спадает с расстоянием до стены. Центр отнесён от
  // стены на `BOUNCE_PULL` радиуса: пятно почти не заходит за неё
  const bounceOf = (light, hit) => {
    const bounce = cfg.headlights?.bounce;

    if (
      !bounce ||
      !(bounce.intensity > 0) ||
      !(bounce.radius > 0) ||
      hit.distance > (bounce.maxDistance ?? light.radius)
    ) {
      return null;
    }

    const rotation = light.rotation || 0;
    const back = bounce.radius * BOUNCE_PULL;

    return {
      kind: 'radial',
      level: light.level,
      levels: light.levels,
      x: hit.x - Math.cos(rotation) * back,
      y: hit.y - Math.sin(rotation) * back,
      z: light.z,
      radius: bounce.radius,
      color: light.color,
      intensity:
        (light.intensity ?? 1) *
        bounce.intensity *
        (1 - hit.distance / light.radius),
    };
  };

  return { sync, occlusionOf, reachesPoint, bounceOf };
}
