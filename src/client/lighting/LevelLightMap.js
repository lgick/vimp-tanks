import {
  AlphaFilter,
  Container,
  Graphics,
  Mesh,
  MeshGeometry,
  Rectangle,
  Sprite,
  Texture,
} from 'pixi.js';
import { levelZ } from '../levelZ.js';
import { applyParallax } from '../parallax.js';
import { createHole, dispose as disposeHole } from '../parts/map/holeOverlay.js';
import { LIGHT_OVERLAY_BASE_Z } from './lightMath.js';
import { fanIndices, rampWedgePolygon } from './lightGeometry.js';

const WHITE = 0xffffff;

// Карта освещённости ОДНОГО уровня.
//
// Оверлей — контейнер на сцене (`zIndex = levelZ(40, L)`) в МИРОВЫХ
// координатах, без собственного трансформа: фон, маска этажа и аддитивные
// источники. Фильтр на нём рисует содержимое в пуловую
// текстуру пониженного разрешения и кладёт результат на сцену умножением
// (`blendMode: 'multiply'`). Отдельной RenderTexture с `renderer.render`
// здесь нет намеренно: `onRender` частей зовётся ВНУТРИ кадра, когда экран
// уже привязан (`renderStart`), и вложенный рендер в текстуру сбросил бы
// стек целей — весь кадр ушёл бы в карту освещённости. Фильтр Pixi рисует
// через push/pop стека целей, в том же проходе.
//
// Область фильтра — `filterArea`: мировой прямоугольник карты с запасом
// (`area`), задаётся один раз. НЕ `boundsArea`: для него Pixi 8.19
// (`getFastGlobalBounds`) применяет трансформ сцены дважды, область уезжала
// за экран вместе с камерой, фильтр пропускался (`skip`), и содержимое
// ложилось на сцену без умножения — белый экран или пропавшая ночь. Путь
// `filterArea` считается верно, обрезку по экрану делает сам Pixi.
//
// Содержимое:
//   L = 0   фон цвета `ambient`, источники уровня 0 — аддитивно;
//   L >= 1  фон БЕЛЫЙ (умножение на белый картинку не меняет), поверх —
//           маска этажа цвета `ambient` в проекции уровня, затем источники.
//           Вне этажа карта остаётся белой, и уровень 0 не темнеет дважды.
//
// Свет на рампах (`setRamps`, `layoutRampLights`): у карты уровня `from`
// рамп, ведущих вверх, — второй контейнер источников `rampLights` с маской
// «клинья этих рамп» в проекции клина. Клин нарисован с повершинной
// высотой, поэтому свет на нём — меши в проекции клина (`rampLight`): и
// источников уровня `from`, и источников уровня `to` (клин нарисован в
// части уровня `from` и затемнён её оверлеем, а свет плиты `to` без маски
// осветил бы и землю под мостом). Обычные источники (`lights`) получают
// ИНВЕРСНУЮ маску тех же клиньев: на клине не остаётся света в проекции
// пола, чей край не совпал бы с нарисованной трапецией.
//
// Конус фары, упёршийся в стену (`fan` у источника), рисуется не спрайтом, а
// веером-мешем по полигону видимости с той же текстурой: свет кончается на
// стене без стенсил-масок на каждый конус.
//
// Засветка грани (`layoutWashes`): часть луча фары, упёршаяся в стену,
// ложится квадами на видимую грань — от подножия вверх, гаснет к верху.
// Квад рисуется, только пока грань смотрит на центр проекции; крышу
// закрывают вершины объёмов, они выше в оверлее.
//
// Над источниками — лучи фонарей в воздухе (`layoutShafts`) с просветами-
// тенями предметов.
//
// Поверх источников — вершины объёмов уровня (`setTops`): прямоугольники
// клеток цвета `ambient` в проекции `(L + volume) · shear`. Боковые грани
// остаются освещёнными, верх стены фары наземного танка не ловит.
//
// `roof: true` — карта крыш уровня (`game.roofs`): та же маска и те же
// источники, но своя дыра — она открывается, только когда крыша закрывает
// танк (ведёт сервис).
export default class LevelLightMap {
  // `area` — `{ x, y, width, height }` в мировых единицах: карта с запасом
  // на отдалённую камеру
  constructor({ level, ambient, resolution, area, roof = false }) {
    this.level = level;
    this.ambient = ambient;
    this.roof = roof;

    this.overlay = new Container();
    this.overlay.label = roof ? `lighting-roof-${level}` : `lighting-${level}`;
    this.overlay.zIndex = levelZ(LIGHT_OVERLAY_BASE_Z, level);
    this.overlay.eventMode = 'none';

    // фон на всю область: Texture.WHITE с tint
    this.base = new Sprite(Texture.WHITE);
    this.base.tint = level === 0 ? ambient : WHITE;
    this.base.position.set(area.x, area.y);
    this.base.width = area.width;
    this.base.height = area.height;
    this.overlay.addChild(this.base);

    this.mask = level >= 1 ? new Graphics() : null;

    if (this.mask) {
      this.overlay.addChild(this.mask);
    }

    this.lights = new Container();
    this.overlay.addChild(this.lights);

    // свет на клиньях рамп в проекции клина, обрезанный ими же
    // (стенсил-маска). Маски — эта и инверсная у `lights` — заводятся
    // вместе с первыми рампами
    this.rampLights = new Container();
    this.overlay.addChild(this.rampLights);
    this.rampMask = null;
    this.lightsMask = null;
    this.ramps = [];
    this.rampLightPool = [];

    // лучи фонарей в воздухе: по контейнеру на фонарь — спрайт лучей и
    // клинья теней предметов. Тени — ИНВЕРСНАЯ стенсил-маска контейнера:
    // гасят только лучи своего фонаря, пятно на земле и полумрак не трогают
    this.shafts = new Container();
    this.overlay.addChild(this.shafts);
    this.shaftPool = [];

    // вершины объёмов: по графике на высоту объёма, `{ graphics, volume }`
    this.tops = new Container();
    this.overlay.addChild(this.tops);
    this.topGroups = [];

    // спрайты источников переиспользуются между кадрами: число видимых
    // источников меняется, объекты — нет
    this.pool = [];
    // веера конусов, упёршихся в стену (`item.fan`)
    this.fanPool = [];
    // засветка граней стен (`layoutWashes`)
    this.washPool = [];

    // проходной фильтр: разрешение карты и режим наложения на сцену
    this.filter = new AlphaFilter({ alpha: 1 });
    this.filter.resolution = resolution;
    this.filter.blendMode = 'multiply';
    this.overlay.filters = [this.filter];
    // область фильтра переживает смену цепочки (дыра заменяет `filters`):
    // она живёт в том же FilterEffect контейнера
    this.overlay.filterArea = new Rectangle(
      area.x,
      area.y,
      area.width,
      area.height,
    );

    this.resolution = resolution;

    // «дыра» над игроком: у оверлея своя, как у плиты
    this.hole = createHole();

    this.hasMask = false;
  }

  // маска этажа: прогоны клеток в МИРОВЫХ единицах, один раз на изменение.
  // Проекцию уровня даёт трансформ графики (`applyParallax`), вершины на
  // кадр не пересчитываются
  setMask(runs, step, scale) {
    if (!this.mask) {
      return;
    }

    this.mask.clear();
    this.hasMask = runs.length > 0;

    for (const run of runs) {
      this.mask.rect(
        run.col * step * scale.x,
        run.row * step * scale.y,
        run.length * step * scale.x,
        step * scale.y,
      );
    }

    if (this.hasMask) {
      this.mask.fill(this.ambient);
    }
  }

  // вершины объёмов: `groups` — `[{ volume, runs }]`, прогоны клеток в
  // мировых единицах, как у маски. Проекцию высоты даёт трансформ графики
  setTops(groups, step, scale) {
    for (const group of this.topGroups) {
      group.graphics.destroy();
    }

    this.topGroups = [];

    for (const { volume, runs } of groups) {
      if (!runs.length) {
        continue;
      }

      const graphics = new Graphics();

      for (const run of runs) {
        graphics.rect(
          run.col * step * scale.x,
          run.row * step * scale.y,
          run.length * step * scale.x,
          step * scale.y,
        );
      }

      graphics.fill(this.ambient);
      this.tops.addChild(graphics);
      this.topGroups.push({ graphics, volume });
    }
  }

  // клинья рамп, ведущих с этого уровня вверх: полосы в клетках
  // (`buildRampLanes`) и то, что нужно их проекции. Контур пересчитывает
  // `place` — у клина своя высота на каждую вершину
  setRamps(lanes, step, scale, segments) {
    this.ramps = lanes;
    this.rampGeometry = { step, scale, segments };

    if (lanes.length && !this.rampMask) {
      this.rampMask = new Graphics();
      this.lightsMask = new Graphics();
      this.overlay.addChild(this.rampMask, this.lightsMask);
      this.rampLights.mask = this.rampMask;
      this.lights.setMask({ mask: this.lightsMask, inverse: true });
    } else if (!lanes.length && this.rampMask) {
      this.rampLights.mask = null;
      this.lights.mask = null;
      this.rampMask.destroy();
      this.lightsMask.destroy();
      this.rampMask = null;
      this.lightsMask = null;
    }
  }

  // уровни вершин рамп: источники этих уровней идут в `rampLights`
  rampLevels() {
    return new Set(this.ramps.map(lane => lane.to));
  }

  // проекция уровня для маски и вершин объёмов; фон и область фильтра —
  // мировые и от камеры не зависят
  place(camera, shear) {
    if (this.mask) {
      applyParallax(this.mask, camera, this.level * shear, 1);
    }

    if (this.rampMask) {
      const { step, scale, segments } = this.rampGeometry;

      this.rampMask.clear();
      this.lightsMask.clear();

      for (const lane of this.ramps) {
        const polygon = rampWedgePolygon(
          lane,
          step,
          scale,
          camera,
          shear,
          segments,
        );

        this.rampMask.poly(polygon);
        this.lightsMask.poly(polygon);
      }

      this.rampMask.fill(WHITE);
      this.lightsMask.fill(WHITE);
    }

    for (const { graphics, volume } of this.topGroups) {
      applyParallax(graphics, camera, (this.level + volume) * shear, 1);
    }
  }

  // Цепочка фильтров оверлея после шага дыры. Фильтр дыры заменяет
  // проходной целиком, поэтому и режим наложения (multiply), и разрешение
  // карты он обязан нести сам: без этого под плитой, то есть почти всё
  // время игрока на земле, карта рисовалась в полном разрешении. Без дыры
  // возвращается проходной фильтр
  syncFilters() {
    if (this.hole.attached) {
      this.hole.filter.blendMode = 'multiply';
      this.hole.filter.resolution = this.resolution;
    } else if (this.overlay.filters?.[0] !== this.filter) {
      this.overlay.filters = [this.filter];
    }
  }

  // раскладка источников кадра: `items` уже спроецированы и отсечены
  // сервисом — `{ texture, x, y, anchorX, anchorY, scaleX, scaleY,
  // rotation, color, alpha }`
  layout(items) {
    layoutPool(this.pool, this.lights, items.filter(item => !item.fan));
    layoutFans(this.fanPool, this.lights, items.filter(item => item.fan));
  }

  // Засветка граней стен фарами: `items` — `{ wash, texture, color, alpha }`,
  // где `wash` — квады `wallWash` в мировых единицах. Оверлей мировой, без
  // трансформа, поэтому вершины проецируются здесь: `p + (p − cam)·k`,
  // `k = высота вершины·shear` (высоты абсолютные, `wallWash`). UV и индексы
  // заливаются только на смене засветки; квад грани, отвёрнутой от камеры
  // (она под крышей), получает вырожденные индексы — переписываются они
  // только при смене видимости, как в `orderWallMesh`
  layoutWashes(items, camera, shear) {
    growMeshPool(this.washPool, this.lights, items.length);

    for (let i = 0; i < this.washPool.length; i += 1) {
      const mesh = this.washPool[i];
      const item = items[i];

      if (!item) {
        mesh.visible = false;
        continue;
      }

      const { wash } = item;
      const geometry = mesh.geometry;

      if (mesh.wash !== wash) {
        geometry.positions = new Float32Array(wash.base.length);
        geometry.uvs = wash.uvs;
        geometry.indices = new Uint32Array(wash.indices.length);
        mesh.wash = wash;
        mesh.facing = new Int8Array(wash.normals.length / 2).fill(-1);
      }

      const positions = geometry.positions;

      projectVertices(positions, wash.base, wash.heights, camera, shear);
      // тот же массив: сеттер буфера только отмечает обновление
      geometry.positions = positions;

      const { normals, mids } = wash;

      const indices = geometry.indices;
      let changed = false;

      for (let q = 0; q < mesh.facing.length; q += 1) {
        const front =
          camera &&
          normals[q * 2] * (camera.x - mids[q * 2]) +
            normals[q * 2 + 1] * (camera.y - mids[q * 2 + 1]) >
            0
            ? 1
            : 0;

        if (mesh.facing[q] === front) {
          continue;
        }

        mesh.facing[q] = front;
        changed = true;

        for (let j = 0; j < 6; j += 1) {
          indices[q * 6 + j] = front ? wash.indices[q * 6 + j] : q * 4;
        }
      }

      if (changed) {
        geometry.indices = indices;
      }

      showLight(mesh, item);
    }
  }

  // Свет на клиньях рамп: `items` — `{ ramp, texture, color, alpha }`, где
  // `ramp` — меш `rampLight` в мировых единицах. Оверлей мировой, поэтому
  // вершины проецируются здесь высотой клина в своей точке: `p + (p −
  // cam)·k`, `k = высота·shear`. UV и индексы заливаются только на смене
  // меша
  layoutRampLights(items, camera, shear) {
    growMeshPool(this.rampLightPool, this.rampLights, items.length);

    for (let i = 0; i < this.rampLightPool.length; i += 1) {
      const mesh = this.rampLightPool[i];
      const item = items[i];

      if (!item) {
        mesh.visible = false;
        continue;
      }

      const { ramp } = item;
      const geometry = mesh.geometry;

      if (mesh.ramp !== ramp) {
        geometry.positions = new Float32Array(ramp.base.length);
        geometry.uvs = ramp.uvs;
        geometry.indices = ramp.indices;
        mesh.ramp = ramp;
      }

      const positions = geometry.positions;

      projectVertices(positions, ramp.base, ramp.heights, camera, shear);
      // тот же массив: сеттер буфера только отмечает обновление
      geometry.positions = positions;

      showLight(mesh, item);
    }
  }

  // раскладка лучей кадра: `items` — `{ texture, x, y, scale, rotation,
  // color, alpha, shadows }`, где `shadows` — клинья теней
  // `[[x0, y0, …], …]` в тех же нарисованных координатах
  layoutShafts(items) {
    while (this.shaftPool.length < items.length) {
      const container = new Container();
      const sprite = new Sprite();
      const shadow = new Graphics();

      sprite.anchor.set(0.5);
      sprite.blendMode = 'add';
      container.addChild(sprite, shadow);
      this.shafts.addChild(container);
      this.shaftPool.push({ container, sprite, shadow, masked: false });
    }

    for (let i = 0; i < this.shaftPool.length; i += 1) {
      const entry = this.shaftPool[i];
      const item = items[i];

      if (!item) {
        entry.container.visible = false;
        continue;
      }

      const { container, sprite, shadow } = entry;
      const shadows = item.shadows || [];

      container.visible = true;
      sprite.texture = item.texture;
      sprite.position.set(item.x, item.y);
      sprite.scale.set(item.scale);
      sprite.rotation = item.rotation;
      sprite.tint = item.color;
      sprite.alpha = item.alpha;

      shadow.clear();

      for (const polygon of shadows) {
        shadow.poly(polygon);
      }

      if (shadows.length) {
        shadow.fill(WHITE);
      }

      // маска ставится и снимается только на смене: без теней стенсил не
      // нужен вовсе
      const masked = shadows.length > 0;

      if (masked !== entry.masked) {
        entry.masked = masked;

        if (masked) {
          container.setMask({ mask: shadow, inverse: true });
        } else {
          container.mask = null;
          // снятая маска возвращает графике отрисовку: пустая она невидима
          shadow.visible = false;
        }
      }

      if (masked) {
        shadow.visible = true;
      }
    }
  }

  // Освобождение: сначала со сцены, потом ресурсы. Текстуры источников —
  // общие запечённые ассеты, их не трогаем
  destroy() {
    const overlay = this.overlay;

    overlay.parent?.removeChild(overlay);
    disposeHole(this.hole, overlay);
    overlay.filters = [];
    this.filter.destroy();

    for (const sprite of this.pool) {
      sprite.texture = null;
    }

    // геометрию вееров Mesh.destroy не уничтожает — только отвязывает
    for (const mesh of [
      ...this.fanPool,
      ...this.rampLightPool,
      ...this.washPool,
    ]) {
      mesh.texture = Texture.EMPTY;
      mesh.geometry.destroy();
    }

    this.pool = [];
    this.fanPool = [];
    this.rampLightPool = [];
    this.washPool = [];
    this.rampLights.mask = null;
    this.lights.mask = null;
    this.rampMask = null;
    this.lightsMask = null;
    this.ramps = [];

    for (const entry of this.shaftPool) {
      entry.container.mask = null;
      entry.sprite.texture = null;
    }

    this.shaftPool = [];
    this.topGroups = [];

    overlay.destroy({ children: true, texture: false, textureSource: false });
  }
}

// Есть ли у уровня карта освещённости — обычная или крыш (`map` —
// состояние карты сервиса `lighting`): уровень может состоять из одних
// крыш, и его свет обязан дойти до них
export function hasLevelMap(map, level) {
  return map.levels.has(level) || map.roofLevels.has(level);
}

// Пул мешей-добавок света в `container`: растёт до `count`. Меш — режим
// `add`, пустая текстура, геометрия-заглушка: все её буферы вызывающий
// заменяет при первой раскладке меша (новый меш не совпадает ни с одним
// веером, засветкой или клином). Лишние меши прячет вызывающий
function growMeshPool(pool, container, count) {
  while (pool.length < count) {
    const geometry = new MeshGeometry({
      positions: new Float32Array(6),
      uvs: new Float32Array(6),
      indices: new Uint32Array(3),
    });
    const mesh = new Mesh({ geometry, texture: Texture.EMPTY });

    mesh.blendMode = 'add';
    pool.push(mesh);
    container.addChild(mesh);
  }
}

// меш-добавка кадра: видим, с текстурой, цветом и силой источника
function showLight(mesh, item) {
  mesh.visible = true;
  mesh.texture = item.texture;
  mesh.tint = item.color;
  mesh.alpha = item.alpha;
}

// Вершины меша с повершинной высотой в мировом оверлее: точка `p` с
// абсолютной высотой `z` (уровни) ложится в `p + (p − cam)·z·shear` — та
// же формула, что у `offsetPoint` (src/client/parallax.js). Без камеры —
// мировая точка. Не для срезов extrusion.js: там `heights` — уже `k`
function projectVertices(positions, base, heights, camera, shear) {
  for (let v = 0; v < heights.length; v += 1) {
    const x = base[v * 2];
    const y = base[v * 2 + 1];
    const k = camera ? heights[v] * shear : 0;

    positions[v * 2] = camera ? x + (x - camera.x) * k : x;
    positions[v * 2 + 1] = camera ? y + (y - camera.y) * k : y;
  }
}

// спрайты источников переиспользуются между кадрами: число видимых
// источников меняется, объекты — нет
function layoutPool(pool, container, items) {
  while (pool.length < items.length) {
    const sprite = new Sprite();

    sprite.blendMode = 'add';
    pool.push(sprite);
    container.addChild(sprite);
  }

  for (let i = 0; i < pool.length; i += 1) {
    const sprite = pool[i];
    const item = items[i];

    if (!item) {
      sprite.visible = false;
      continue;
    }

    sprite.visible = true;
    sprite.texture = item.texture;
    sprite.anchor.set(item.anchorX, item.anchorY);
    sprite.position.set(item.x, item.y);
    sprite.scale.set(item.scaleX, item.scaleY);
    sprite.rotation = item.rotation;
    sprite.tint = item.color;
    sprite.alpha = item.alpha;
  }
}

// Веера конусов: меш на источник. `item.fan` — `{ shape, x, y, scale }`:
// `shape` (`points` и `uvs` в мировых единицах) один на все кадры, пока фара
// стоит; проекцию высоты даёт трансформ меша `p·scale + (x, y)` — ровно
// `offsetPoint`
function layoutFans(pool, container, items) {
  growMeshPool(pool, container, items.length);

  for (let i = 0; i < pool.length; i += 1) {
    const mesh = pool[i];
    const item = items[i];

    if (!item) {
      mesh.visible = false;
      continue;
    }

    const { fan } = item;
    const { shape } = fan;

    // буферы переписываются только на смене веера
    if (mesh.shape !== shape) {
      const geometry = mesh.geometry;
      const rays = shape.points.length / 2 - 1;
      const topology = `${rays}:${Boolean(shape.closed)}`;

      // индексы зависят только от числа лучей и замкнутости веера
      if (mesh.topology !== topology) {
        geometry.indices = fanIndices(rays, shape.closed);
        mesh.topology = topology;
      }

      geometry.positions = shape.points;
      geometry.uvs = shape.uvs;
      mesh.shape = shape;
    }

    showLight(mesh, item);
    mesh.position.set(fan.x, fan.y);
    mesh.scale.set(fan.scale);
  }
}
