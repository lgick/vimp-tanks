import { seeThrough, parallax } from '../config/render.js';
import { cameraCenter } from './camera.js';
import { offsetPoint } from './parallax.js';
import { seeThroughAlpha, seeThroughTint } from './seeThrough.js';

// Сервис пула зависимостей `levelView`: где и на каком уровне находится
// локальный игрок. Движок такого сервиса не даёт и не должен — это игровое
// понятие; плагин отдаёт его своим же партам через
// ClientPlugin.hooks.services (src/client/index.js).
//
// Пишет локальный `Tank` (он единственный знает и свой уровень, и свою
// позицию, и свою высоту, и что он локальный — по сервису `localPlayer`),
// читают все парты, которые обязаны уступить видимость игроку под ними:
// слои `Map`, ящики, чужие танки, дым, бомбы и эффекты.
//
// Формула прозрачности здесь одна на всех (`alphaFor`), режим тоже один
// (`mode`): иначе каждый парт читал бы конфиг по-своему и «дыра» вокруг
// игрока разъехалась бы между слоем и ящиком на нём.
//
// Расстояние до игрока считается в НАРИСОВАННЫХ координатах: и игрок, и
// сущность смещены проекцией 2.5D каждый на свою высоту
// (`src/client/parallax.js`), а дыру в плите `Map` центрирует по той же
// смещённой точке. Считать alpha по сырым мировым точкам значило бы
// разводить круг прозрачности сущностей с нарисованной дырой тем сильнее,
// чем дальше игрок от центра экрана и чем выше сущность.
// Центр камеры — свойство КАДРА, а не парта: его добывает сам сервис.
// Раньше его публиковал ОДИН парт — локальный танк, — и без него
// (наблюдатель, промежуток между смертью и респауном, кадры до появления
// `localPlayer.id`) камеры не было вовсе, а слой карты считал её сам: дыра
// в плите ехала по свежей проекции, а alpha сущностей — по прошлой.
// Порядок `onRender` партов тоже не определён, и тот, кого вызвали раньше
// танка, брал камеру прошлого кадра.
export function createLevelView(cfg = seeThrough, deps = {}) {
  const state = {
    level: 0,
    x: 0,
    y: 0,
    z: 0,
    camera: null,
    // трансформ сцены, по которому посчитан центр; null — ещё ни разу
    key: null,
    stage: deps.stage || null,
    renderer: deps.renderer || null,
  };

  // Кеш живёт на ОДНОМ состоянии сцены, а не на тике общего тикера. Ключ
  // по тику был неверен: за один тик полотно может рисоваться НЕСКОЛЬКО
  // раз — `vimp-engine` до 0.34 зовёт `app.render()` прямо из
  // `updateCoords` (CanvasManagerView), то есть на каждый кадр камеры, а в
  // тике их два и больше (сперва камера дискретного кадра — интерполяция,
  // следом предсказанная своего танка) плюс отрисовка самого тикера.
  // Сколько отрисовок придётся на тик — дело движка и его версии, и
  // опираться на это число плагин не вправе. Всем
  // отрисовкам после первой кеш отдавал камеру ПЕРВОЙ, тогда как сцена
  // стояла уже на последней: проекция 2.5D считалась от чужого центра, и
  // на верхних уровнях всё дрожало на разнице «интерполяция ↔
  // предсказание» — тем сильнее, чем быстрее едет игрок. Парты, читающие
  // сцену напрямую (`Tracks`, `Smoke`, эффекты), в тех же кадрах смещались
  // по свежему центру и разъезжались с танком и плитой.
  //
  // Трансформ сцены во время отрисовки не меняется, поэтому ключ по нему
  // даёт и единый центр на всю отрисовку, и свежесть между отрисовками.
  const camera = () => {
    if (!state.stage) {
      return null;
    }

    const { position, scale } = state.stage;
    const screen = state.renderer?.screen;
    const width = screen ? screen.width : 0;
    const height = screen ? screen.height : 0;
    const key = state.key;

    // `camera === null` — центра не было вовсе (сцена без масштаба до
    // первого кадра): такой ответ не кешируется, иначе он остался бы
    // навсегда
    if (
      state.camera === null ||
      key === null ||
      key.x !== position.x ||
      key.y !== position.y ||
      key.scaleX !== scale.x ||
      key.scaleY !== scale.y ||
      key.width !== width ||
      key.height !== height
    ) {
      state.key = {
        x: position.x,
        y: position.y,
        scaleX: scale.x,
        scaleY: scale.y,
        width,
        height,
      };
      state.camera = cameraCenter(state.stage, state.renderer);
    }

    return state.camera;
  };

  return {
    // Ленивая привязка к сцене: сервис собирается ещё до полотна
    // (`hooks.services(core)` зовётся один раз на ядро), а парт попадает на
    // сцену позже своего конструктора. Привязывается ПЕРВЫЙ, кто позвал, и
    // звать вправе только парты игрового полотна (`Tank`, `Map`): у радара
    // своя сцена и своя проекция.
    attachStage(stage, renderer) {
      if (state.stage || !stage || !renderer) {
        return;
      }

      state.stage = stage;
      state.renderer = renderer;
      state.key = null;
    },

    // центр камеры этого кадра в мировых единицах; null — сцены ещё нет
    camera() {
      return camera();
    },

    set(level, x, y, z = 0) {
      state.level = level;
      state.x = x;
      state.y = y;
      state.z = z;
    },

    // `z` — высота сущности в уровнях; по умолчанию она равна уровню (тело
    // стоит на своей плите), а танк и дым передают свой дробный `z`
    alphaFor(level, worldX, worldY, z = level) {
      const center = camera();
      const view = offsetPoint(
        state.x,
        state.y,
        center,
        state.z * parallax.shear,
      );
      const point = offsetPoint(worldX, worldY, center, z * parallax.shear);

      return seeThroughAlpha({
        viewLevel: state.level,
        viewX: view.x,
        viewY: view.y,
        level,
        x: point.x,
        y: point.y,
        cfg,
      });
    },

    tintFor(level) {
      return seeThroughTint(state.level, level, cfg);
    },

    get cfg() {
      return cfg;
    },
    get mode() {
      return cfg.mode;
    },
    get level() {
      return state.level;
    },
    get x() {
      return state.x;
    },
    get y() {
      return state.y;
    },
    get z() {
      return state.z;
    },
  };
}
