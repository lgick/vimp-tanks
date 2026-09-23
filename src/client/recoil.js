// Визуальная отдача после выстрела: только рендер — физика и ядро её не
// знают. Модуль чистый: время и конфиг приходят параметрами, PixiJS не
// нужен.

/**
 * Амплитуда отдачи 0..1 через `elapsed` мс после выстрела: быстрый рост
 * до 1 за долю `attack` длительности, затем квадратичный возврат к 0.
 *
 * @param {number} elapsed   мс с выстрела
 * @param {number} duration  полная длительность, мс
 * @param {number} attack    доля длительности на рост (0..1)
 * @returns {number}
 */
export function recoilAmount(elapsed, duration, attack) {
  if (!(duration > 0) || elapsed < 0 || elapsed >= duration) {
    return 0;
  }

  const t = elapsed / duration;

  if (t < attack) {
    return t / attack;
  }

  const back = (t - attack) / (1 - attack);

  return (1 - back) * (1 - back);
}

/**
 * Смещения корпуса и башни в осях КОРПУСА. Отдача идёт против ствола:
 * башня и корпус уезжают назад, а сторона ствола приподнимается — знаки
 * те же, что в `tiltCorners` (`pitch > 0` поднимает нос `+u`, `roll > 0` —
 * борт `+v`).
 *
 * @param {object} p
 * @param {number} p.amount       `recoilAmount`
 * @param {number} p.gunRotation  поворот башни относительно корпуса, рад
 * @param {object} p.config       `recoil` из src/config/render.js
 * @returns {{ gun: {x: number, y: number}, body: {x: number, y: number},
 *   pitch: number, roll: number }}
 */
export function recoilOffsets({ amount, gunRotation, config }) {
  const cos = Math.cos(gunRotation);
  const sin = Math.sin(gunRotation);
  const gun = config.gunKick * amount;
  const body = config.bodyKick * amount;
  const rock = config.rock * amount;

  return {
    gun: { x: -cos * gun, y: -sin * gun },
    body: { x: -cos * body, y: -sin * body },
    pitch: rock * cos,
    roll: rock * sin,
  };
}
