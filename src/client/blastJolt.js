// Визуальная реакция танка на взрыв: только рендер — физика и ядро её не
// знают. Модуль чистый: время, конфиг и «случай» приходят параметрами,
// PixiJS не нужен.

const TAU = Math.PI * 2;

// частоты встряски, рад/мс (≈14 и ≈18 Гц): несоизмеримы, поэтому сдвиг не
// ходит по ровной линии
const SHAKE_FREQ_X = 0.09;
const SHAKE_FREQ_Y = 0.113;

/**
 * Сила взрыва по расстоянию: та же спадающая, что у урона в ядре
 * (`TanksSim::explode`, `1 − d / radius`), вне радиуса — 0.
 *
 * @param {number} distance
 * @param {number} radius
 * @returns {number} 0..1
 */
export function blastStrength(distance, radius) {
  if (!(radius > 0) || distance >= radius) {
    return 0;
  }

  return 1 - distance / radius;
}

/**
 * Задел ли взрыв танк и как. null — не задел: другой уровень (плита моста
 * экранирует, как маски ядра) или вне радиуса.
 *
 * @param {object} p
 * @param {number} p.x          мировая точка танка
 * @param {number} p.y
 * @param {number} p.level      физический уровень танка
 * @param {number} p.heading    курс корпуса, рад
 * @param {number} p.hullLength длина корпуса, мировые единицы
 * @param {{x: number, y: number, radius: number, level?: number}} p.blast
 * @param {object} p.config     `blastJolt` из src/config/render.js
 * @param {() => number} [p.rng]
 * @returns {null | { strength: number, dirU: number, dirV: number,
 *   hop: boolean, phaseX: number, phaseY: number }} `dirU/dirV` —
 *   направление на взрыв в осях корпуса: эта сторона и подлетает
 */
export function blastKick({
  x,
  y,
  level,
  heading,
  hullLength,
  blast,
  config,
  rng = Math.random,
}) {
  if ((blast.level || 0) !== (level || 0)) {
    return null;
  }

  const dx = blast.x - x;
  const dy = blast.y - y;
  const distance = Math.hypot(dx, dy);
  const strength = blastStrength(distance, blast.radius);

  if (!strength) {
    return null;
  }

  // под корпусом направление на взрыв вырождено — корпус подбрасывает и
  // кренит в случайную сторону
  const hop = distance < config.underShare * hullLength;
  const angle = hop ? rng() * TAU : Math.atan2(dy, dx) - heading;

  return {
    strength,
    dirU: Math.cos(angle),
    dirV: Math.sin(angle),
    hop,
    phaseX: rng() * TAU,
    phaseY: rng() * TAU,
  };
}

/**
 * Состояние реакции через `elapsed` мс после взрыва.
 *
 * - крен: сторона к взрыву подлетает, затем корпус качается на подвеске —
 *   затухающее колебание `e^(−t/decay)·cos(2π·wobbleHz·t)`; знаки как в
 *   `tiltCorners` (`pitch > 0` — нос `+u`, `roll > 0` — борт `+v`);
 * - подброс (взрыв под корпусом): видимая высота `hop·s·sin(π·t/hopDuration)`,
 *   уровни — прибавляется к высоте в проекции;
 * - встряска: короткий сдвиг корпуса, затухает линейно за `shakeDuration`.
 *
 * @param {object} p
 * @param {number} p.elapsed  мс со взрыва
 * @param {object} p.kick     `blastKick`
 * @param {object} p.config   `blastJolt`
 * @returns {{ pitch: number, roll: number, lift: number, shakeX: number,
 *   shakeY: number, envelope: number, done: boolean }}
 */
export function blastJoltState({ elapsed, kick, config }) {
  const strength = kick.strength;
  const envelope = config.decay > 0 ? Math.exp(-elapsed / config.decay) : 0;
  const wobble = envelope * Math.cos(TAU * config.wobbleHz * (elapsed / 1000));
  const rock = config.rock * strength * wobble;

  const hopping = kick.hop && elapsed < config.hopDuration;
  const lift = hopping
    ? config.hop * strength * Math.sin((Math.PI * elapsed) / config.hopDuration)
    : 0;

  const shaking = elapsed < config.shakeDuration;
  const shake = shaking
    ? config.shake * strength * (1 - elapsed / config.shakeDuration)
    : 0;

  return {
    pitch: rock * kick.dirU,
    roll: rock * kick.dirV,
    lift,
    shakeX: shake * Math.sin(elapsed * SHAKE_FREQ_X + kick.phaseX),
    shakeY: shake * Math.sin(elapsed * SHAKE_FREQ_Y + kick.phaseY),
    envelope: strength * envelope,
    done: elapsed >= config.duration && !hopping,
  };
}
