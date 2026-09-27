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
    // предупреждение об отсутствующем центре камеры выдано (один раз на
    // сессию): кадров без камеры бывает много подряд, и поток в консоли
    // на проде бесполезен
    warned: false,
    // журнал клиентских ошибок движка (сервис пула `diagnostics`): сервис
    // игры создаётся до полотна, и его отдают парты (`setDiagnostics`)
    diagnostics: null,
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
  // Центра камеры не бывает только в кадре без трансформа сцены, и путь, по
  // которому такой кадр возникает, — дело движка (масштаб сцены ставит он).
  // Потребители проекции `null` терпят (`offsetPoint`, `modelLean`), поэтому
  // тихо он бы и остался; один раз сказать в консоль — единственный способ
  // прижать причину на проде, где идут опубликованные сборки
  const warnNoCamera = () => {
    if (state.warned) {
      return;
    }

    state.warned = true;
    const stage = state.stage;
    const screen = state.renderer?.screen;

    const payload = {
      // уничтоженная сцена — отдельная причина, и по трансформу её не
      // отличить от просто обнулённого масштаба: у мёртвого контейнера
      // трансформ обнулён весь
      destroyed: stage ? stage.destroyed : null,
      position: stage ? { x: stage.position?.x, y: stage.position?.y } : null,
      scale: stage ? { x: stage.scale?.x, y: stage.scale?.y } : null,
      screen: screen ? { width: screen.width, height: screen.height } : null,
    };

    console.warn(
      '[tanks] levelView: центра камеры нет — кадр без трансформа сцены',
      payload,
    );
    state.diagnostics?.warn('tanks.camera.missing', payload);
  };

  const camera = () => {
    // сцены ещё нет — штатное начало кадра (парт спрашивает сервис до того,
    // как первый парт полотна отдал ему сцену), и говорить тут не о чем
    if (!state.stage) {
      return null;
    }

    // мёртвая сцена: у уничтоженного контейнера PixiJS `position` и `scale`
    // обнулены, и читать трансформ ниже нельзя. Аномалия — говорим о ней,
    // а ждём новую сцену от `attachStage`
    if (state.stage.destroyed) {
      warnNoCamera();

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

      // сцена есть, а центра нет — это и есть аномальный кадр
      if (state.camera === null) {
        warnNoCamera();
      }
    }

    return state.camera;
  };

  return {
    // Ленивая привязка к сцене: сервис собирается ещё до полотна
    // (`hooks.services(core)` зовётся один раз на ядро), а парт попадает на
    // сцену позже своего конструктора. Привязывается ПЕРВЫЙ, кто позвал, и
    // звать вправе только парты игрового полотна (`Tank`, `Map`): у радара
    // своя сцена и своя проекция.
    //
    // Исключение из «первый и навсегда» — УНИЧТОЖЕННАЯ сцена: сервис живёт
    // столько же, сколько ядро, а полотно движок вправе пересобрать. Держать
    // мёртвую сцену значило бы отдавать `null` до конца матча, то есть
    // выключить проекцию 2.5D целиком
    attachStage(stage, renderer) {
      if (!stage || !renderer) {
        return;
      }

      if (state.stage && !state.stage.destroyed) {
        return;
      }

      state.stage = stage;
      state.renderer = renderer;
      state.key = null;
      state.camera = null;
    },

    // журнал клиентских ошибок движка (сервис пула `diagnostics`, vimp-engine
    // ≥ 0.35.0): его отдают парты, у которых он есть в dependencies. Первый
    // непустой — навсегда; на старом движке сервиса нет, и остаётся console.warn
    setDiagnostics(diagnostics) {
      if (!state.diagnostics && diagnostics) {
        state.diagnostics = diagnostics;
      }
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
