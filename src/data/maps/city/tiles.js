// Каталог кадров тайл-листа города assets/img/city.png (карта downtown).
// Id тайла — индекс в `frames`: bakeTileLayer.js берёт текстуру
// `frame${id}`. Кадр 0 — прозрачная пустышка: `0` в `levels[n].map` значит
// «уровня здесь нет», поэтому тайл 0 не стоит ни на одном уровне.
//
// Лист — сетка 16 × 8 клеток по 32 px (512 × 256). Кадр id лежит в клетке
// (id % 16, id / 16). Финальный арт заменяет city.png без правок кода, если
// сохраняет эту раскладку. Заглушки рисует scripts/generate-placeholder-art.js.

export const CELL = 32;
export const SHEET_COLUMNS = 16;
export const SHEET_ROWS = 8;

export const T = {
  EMPTY: 0,
  ASPHALT: 1,
  SIDEWALK: 2,
  LANE: 3,
  SAND: 4,
  MUD: 5,
  WATER: 6,
  OIL: 7,
  CONVEYOR_E: 8,
  CONVEYOR_W: 9,
  BOOST_N: 10,
  BOOST_E: 11,
  WALL: 12,
  ROOF: 13,
  SLAB: 14,
  RAILING: 15,
  RAMP_N: 16,
  RAMP_S: 17,
  RAMP_E: 18,
  RAMP_W: 19,
  CANAL_WALL: 20,
  // дополнительные кадры анимаций (в сетках карты не стоят)
  WATER_2: 21,
  WATER_3: 22,
  WATER_4: 23,
  CONVEYOR_E_2: 24,
  CONVEYOR_E_3: 25,
  CONVEYOR_E_4: 26,
  CONVEYOR_W_2: 27,
  CONVEYOR_W_3: 28,
  CONVEYOR_W_4: 29,
  BOOST_N_2: 30,
  BOOST_E_2: 31,
  FAN: 32,
};

const FRAME_COUNT = T.FAN + 1;

export const frames = Array.from({ length: FRAME_COUNT }, (_, id) => [
  (id % SHEET_COLUMNS) * CELL,
  Math.floor(id / SHEET_COLUMNS) * CELL,
  CELL,
  CELL,
]);
