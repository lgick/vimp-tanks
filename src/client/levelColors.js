// Палитра уровней 2.5D: один цвет на уровень, общий для схемы карты
// (`MapRadar`) и отметки чужого танка (`TankRadar`). Длина — `MAX_LEVELS`
// движка (vimp_engine_core::map::MAX_LEVELS = 8): уровень вне палитры
// означал бы карту, которую движок и не принял бы.
export const LEVEL_COLORS = [
  0xffffff, // 0 — земля
  0x8fb7ff, // 1
  0x9fe0c0, // 2
  0xf0d78c, // 3
  0xe0a0d0, // 4
  0xa0d8f0, // 5
  0xf0b08c, // 6
  0xc0c0d8, // 7
];

export const levelColor = level => LEVEL_COLORS[level] ?? LEVEL_COLORS[0];
