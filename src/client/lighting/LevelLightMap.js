import {
  AlphaFilter,
  Container,
  Graphics,
  Rectangle,
  Sprite,
  Texture,
} from 'pixi.js';
import { levelZ } from '../levelZ.js';
import { applyParallax } from '../parallax.js';
import { createHole, dispose as disposeHole } from '../parts/map/holeOverlay.js';
import { LIGHT_OVERLAY_BASE_Z, rampWedgePolygon } from './lightMath.js';

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
// Свет верхнего уровня на рампах (`setRamps`, `layoutRamps`): у карты
// уровня `from` рамп, ведущих вверх, — второй контейнер источников
// `rampLights` с маской «клинья этих рамп» в проекции клина. В него
// кладутся источники уровня `to`: клин нарисован в части уровня `from` и
// затемнён её оверлеем, а свет плиты `to` без маски осветил бы и землю под
// мостом.
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

    // свет верхнего уровня, обрезанный клиньями рамп (стенсил-маска):
    // маска заводится вместе с первыми рампами
    this.rampLights = new Container();
    this.overlay.addChild(this.rampLights);
    this.rampMask = null;
    this.ramps = [];
    this.rampPool = [];

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
      this.overlay.addChild(this.rampMask);
      this.rampLights.mask = this.rampMask;
    } else if (!lanes.length && this.rampMask) {
      this.rampLights.mask = null;
      this.rampMask.destroy();
      this.rampMask = null;
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

      for (const lane of this.ramps) {
        this.rampMask.poly(
          rampWedgePolygon(lane, step, scale, camera, shear, segments),
        );
      }

      this.rampMask.fill(WHITE);
    }

    for (const { graphics, volume } of this.topGroups) {
      applyParallax(graphics, camera, (this.level + volume) * shear, 1);
    }
  }

  // раскладка источников кадра: `items` уже спроецированы и отсечены
  // сервисом — `{ texture, x, y, anchorX, anchorY, scaleX, scaleY,
  // rotation, color, alpha }`
  layout(items) {
    layoutPool(this.pool, this.lights, items);
  }

  // источники верхнего уровня на клиньях рамп — тот же формат, что `layout`
  layoutRamps(items) {
    layoutPool(this.rampPool, this.rampLights, items);
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

    for (const sprite of [...this.pool, ...this.rampPool]) {
      sprite.texture = null;
    }

    this.pool = [];
    this.rampPool = [];
    this.rampLights.mask = null;
    this.rampMask = null;
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
