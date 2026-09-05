import { seeThrough } from '../config/render.js';
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
export function createLevelView(cfg = seeThrough) {
  const state = { level: 0, x: 0, y: 0, z: 0 };

  return {
    set(level, x, y, z = 0) {
      state.level = level;
      state.x = x;
      state.y = y;
      state.z = z;
    },

    alphaFor(level, worldX, worldY) {
      return seeThroughAlpha({
        viewLevel: state.level,
        viewX: state.x,
        viewY: state.y,
        level,
        x: worldX,
        y: worldY,
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
