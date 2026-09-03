// Сервис пула зависимостей `levelView`: где и на каком уровне находится
// локальный игрок. Движок такого сервиса не даёт и не должен — это игровое
// понятие; плагин отдаёт его своим же партам через
// ClientPlugin.hooks.services (src/client/index.js).
//
// Пишет локальный `Tank` (он единственный знает и свой уровень, и свою
// позицию, и что он локальный — по сервису `localPlayer`), читают
// слои `Map` уровня >= 1, чтобы стать полупрозрачными над игроком.
export function createLevelView() {
  const state = { level: 0, x: 0, y: 0 };

  return {
    set(level, x, y) {
      state.level = level;
      state.x = x;
      state.y = y;
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
  };
}
