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
import { LIGHT_OVERLAY_BASE_Z } from './lightMath.js';

const WHITE = 0xffffff;

// Карта освещённости ОДНОГО уровня.
//
// Оверлей — контейнер на сцене (`zIndex = levelZ(40, L)`): фон, маска этажа
// и аддитивные источники. Фильтр на нём рисует содержимое в пуловую
// текстуру пониженного разрешения и кладёт результат на сцену умножением
// (`blendMode: 'multiply'`). Отдельной RenderTexture с `renderer.render`
// здесь нет намеренно: `onRender` частей зовётся ВНУТРИ кадра, когда экран
// уже привязан (`renderStart`), и вложенный рендер в текстуру сбросил бы
// стек целей — весь кадр ушёл бы в карту освещённости. Фильтр Pixi рисует
// через push/pop стека целей, в том же проходе.
//
// Содержимое:
//   L = 0   фон цвета `ambient`, источники уровня 0 — аддитивно;
//   L >= 1  фон БЕЛЫЙ (умножение на белый картинку не меняет), поверх —
//           маска этажа цвета `ambient` в проекции уровня, затем источники.
//           Вне этажа карта остаётся белой, и уровень 0 не темнеет дважды.
//
// Поверх источников — вершины объёмов уровня (`setTops`): прямоугольники
// клеток цвета `ambient` в проекции `(L + volume) · shear`. Боковые грани
// остаются освещёнными, верх стены фары наземного танка не ловит.
//
// `roof: true` — карта крыш уровня (`game.roofs`): та же маска и те же
// источники, но своя дыра — она открывается, только когда крыша закрывает
// танк (ведёт сервис).
export default class LevelLightMap {
  constructor({ level, ambient, resolution, roof = false }) {
    this.level = level;
    this.ambient = ambient;
    this.roof = roof;

    this.overlay = new Container();
    this.overlay.label = roof ? `lighting-roof-${level}` : `lighting-${level}`;
    this.overlay.zIndex = levelZ(LIGHT_OVERLAY_BASE_Z, level);
    this.overlay.eventMode = 'none';
    // границы фильтра — ровно экран: без них Pixi считал бы их по всем
    // источникам, включая спрятанные
    this.overlay.boundsArea = new Rectangle(0, 0, 1, 1);

    // фон на весь экран: Texture.WHITE с tint
    this.base = new Sprite(Texture.WHITE);
    this.base.tint = level === 0 ? ambient : WHITE;
    this.overlay.addChild(this.base);

    // мир внутри оверлея: трансформ, обратный контр-трансформу оверлея, —
    // то есть снова мировые координаты сцены
    this.world = new Container();
    this.overlay.addChild(this.world);

    this.mask = level >= 1 ? new Graphics() : null;

    if (this.mask) {
      this.world.addChild(this.mask);
    }

    this.lights = new Container();
    this.world.addChild(this.lights);

    // вершины объёмов: по графике на высоту объёма, `{ graphics, volume }`
    this.tops = new Container();
    this.world.addChild(this.tops);
    this.topGroups = [];

    // спрайты источников переиспользуются между кадрами: число видимых
    // источников меняется, объекты — нет
    this.pool = [];

    // проходной фильтр: разрешение карты и режим наложения на сцену
    this.filter = new AlphaFilter({ alpha: 1 });
    this.filter.resolution = resolution;
    this.filter.blendMode = 'multiply';
    this.overlay.filters = [this.filter];

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

  // контр-трансформ сцены: оверлей растянут ровно на экран, а мир внутри —
  // в координатах сцены
  place(stage, screen, camera, shear) {
    const { scale, position } = stage;

    this.overlay.scale.set(1 / scale.x, 1 / scale.y);
    this.overlay.position.set(-position.x / scale.x, -position.y / scale.y);
    this.overlay.boundsArea.width = screen.width;
    this.overlay.boundsArea.height = screen.height;

    this.base.width = screen.width;
    this.base.height = screen.height;

    this.world.scale.set(scale.x, scale.y);
    this.world.position.set(position.x, position.y);

    if (this.mask) {
      applyParallax(this.mask, camera, this.level * shear, 1);
    }

    for (const { graphics, volume } of this.topGroups) {
      applyParallax(graphics, camera, (this.level + volume) * shear, 1);
    }
  }

  // раскладка источников кадра: `items` уже спроецированы и отсечены
  // сервисом — `{ texture, x, y, anchorX, anchorY, scaleX, scaleY,
  // rotation, color, alpha }`
  layout(items) {
    while (this.pool.length < items.length) {
      const sprite = new Sprite();

      sprite.blendMode = 'add';
      this.pool.push(sprite);
      this.lights.addChild(sprite);
    }

    for (let i = 0; i < this.pool.length; i += 1) {
      const sprite = this.pool[i];
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

    this.pool = [];
    this.topGroups = [];

    overlay.destroy({ children: true, texture: false, textureSource: false });
  }
}
