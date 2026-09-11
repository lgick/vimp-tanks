import { seeThrough, parallax } from '../config/render.js';
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
export function createLevelView(cfg = seeThrough) {
  const state = { level: 0, x: 0, y: 0, z: 0, camera: null };

  return {
    set(level, x, y, z = 0) {
      state.level = level;
      state.x = x;
      state.y = y;
      state.z = z;
    },

    // центр камеры в мировых единицах (`src/client/camera.js`): его считает
    // тот же локальный `Tank`, который пишет сюда позицию, — один раз за
    // кадр. null (до первого кадра) оставляет точки как есть
    setCamera(camera) {
      state.camera = camera;
    },

    // `z` — высота сущности в уровнях; по умолчанию она равна уровню (тело
    // стоит на своей плите), а танк и дым передают свой дробный `z`
    alphaFor(level, worldX, worldY, z = level) {
      const camera = state.camera;
      const view = offsetPoint(
        state.x,
        state.y,
        camera,
        state.z * parallax.shear,
      );
      const point = offsetPoint(worldX, worldY, camera, z * parallax.shear);

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
    get camera() {
      return state.camera;
    },
  };
}
