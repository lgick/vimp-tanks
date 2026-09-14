// Мерцание неоновой вывески: чистая функция времени и зерна. Никакого
// `Math.random` — одинаковая картина у всех клиентов и в тестах.
//
// Составляющие:
// - базовый пульс `1 − pulse·(0.5 + 0.5·sin)`;
// - «сбои» — короткие провалы по псевдослучайному расписанию: время режется
//   на окна, и для каждого окна SplitMix32 от зерна и номера окна решает,
//   будет ли в нём сбой и где он начнётся. Сбой гасит ядро (`core`)
//   сильнее, чем ореол (`glow`): газ в трубке гаснет, а стекло ещё светится.

// частота базового пульса, Гц
const PULSE_HZ = 0.8;

// длина окна расписания сбоев и длительность одного сбоя, с
export const DROPOUT_WINDOW = 0.6;
export const DROPOUT_DURATION = 0.09;

// яркость ядра и ореола во время сбоя
const DROPOUT_CORE = 0.12;
const DROPOUT_GLOW = 0.55;

// SplitMix32: беззнаковое 32-битное число из 32-битного входа
export function splitMix32(value) {
  let z = (value + 0x9e3779b9) >>> 0;

  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;

  return (z ^ (z >>> 16)) >>> 0;
}

// зерно вывески из её клетки и уровня: соседние вывески мерцают не синхронно
export function cellSeed(col, row, level = 0) {
  return splitMix32(
    (Math.imul(col, 73856093) ^ Math.imul(row, 19349663) ^ Math.imul(level, 83492791)) >>> 0,
  );
}

// доля [0, 1) из пары (зерно, номер окна, соль)
function unit(seed, window, salt) {
  return splitMix32((seed ^ Math.imul(window + salt, 0x27d4eb2d)) >>> 0) / 4294967296;
}

const clamp01 = value => Math.min(1, Math.max(0, value));

// идёт ли сбой в момент `t` (секунды)
export function inDropout(t, seed, dropouts) {
  if (!(dropouts > 0)) {
    return false;
  }

  const window = Math.floor(t / DROPOUT_WINDOW);

  if (unit(seed, window, 0) >= dropouts) {
    return false;
  }

  const start = window * DROPOUT_WINDOW + unit(seed, window, 1) * (DROPOUT_WINDOW - DROPOUT_DURATION);

  return t >= start && t < start + DROPOUT_DURATION;
}

// яркость ядра и ореола в `[0, 1]`. `cfg` — `sign.flicker`:
// `pulse` (глубина пульса) и `dropouts` (доля окон со сбоем); без cfg — 1
export function brightness(t, seed, cfg) {
  const pulse = clamp01(cfg?.pulse || 0);
  const phase = (seed % 1000) / 1000;
  const base = 1 - pulse * (0.5 + 0.5 * Math.sin(2 * Math.PI * (PULSE_HZ * t + phase)));

  if (inDropout(t, seed, cfg?.dropouts || 0)) {
    return { core: clamp01(base * DROPOUT_CORE), glow: clamp01(base * DROPOUT_GLOW) };
  }

  return { core: clamp01(base), glow: clamp01(base) };
}
