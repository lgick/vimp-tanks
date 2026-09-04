// Демо-карта многоуровневых карт (2.5D): земля (уровень 0) и сквозная
// эстакада (уровень 1) с двумя рампами, перилами и двумя разрывами перил.
// Она же — фикстура отладочных сценариев tests/scenarios/bridge.json,
// fall.json, crosslevel.json, bots_bridge.json.

const width = 80;
const height = 60;
const step = 32;

// тайлы (индексы в spriteSheet.frames)
const tiles = {
  ground: 0, // асфальт, уровень 0
  wall: 1, // стена здания, уровень 0 (physicsStatic)
  slab: 2, // плита моста, уровень 1 (floor)
  railing: 3, // перила моста, уровень 1 (floor + walls)
  rampNorth: 4, // рампа, подъём на север, уровень 0
  rampSouth: 5, // рампа, подъём на юг, уровень 0
};

// геометрия эстакады: 3 тайла проезжей плиты (28..30) плюс перила
// по обеим длинным сторонам (27 и 31)
const bridge = {
  railNorth: 27,
  slabTop: 28,
  slabBottom: 30,
  railSouth: 31,
  left: 2, // внутренняя кромка периметральной стены
  right: width - 3,
};

// рампы: длина и ширина по 3 тайла. Северная стоит ЮЖНЕЕ моста (едешь на
// север — поднимаешься), южная СЕВЕРНЕЕ моста (едешь на юг — поднимаешься).
// В строке перил напротив каждой рампы — проём, иначе въезд заперт.
const rampNorth = { x0: 3, x1: 5, y0: 32, y1: 34 };
const rampSouth = { x0: 74, x1: 76, y0: 24, y1: 26 };

// разрывы перил — обрывы, с которых падают и через которые простреливают
// снизу: один с северной стороны, один с южной
const ledgeNorth = { x0: 30, x1: 33 };
const ledgeSouth = { x0: 48, x1: 51 };

const grid = fill =>
  Array.from({ length: height }, () => Array(width).fill(fill));

const inRange = (value, from, to) => value >= from && value <= to;

const level0 = (function () {
  const map = grid(tiles.ground);

  // периметр
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (y < 2 || y >= height - 2 || x < 2 || x >= width - 2) {
        map[y][x] = tiles.wall;
      }
    }
  }

  // рампы лежат в гриде уровня 0 — по ним едут, оставаясь на земле,
  // пока z не перевалит за половину (core/src/level.rs)
  for (let y = rampNorth.y0; y <= rampNorth.y1; y += 1) {
    for (let x = rampNorth.x0; x <= rampNorth.x1; x += 1) {
      map[y][x] = tiles.rampNorth;
    }
  }

  for (let y = rampSouth.y0; y <= rampSouth.y1; y += 1) {
    for (let x = rampSouth.x0; x <= rampSouth.x1; x += 1) {
      map[y][x] = tiles.rampSouth;
    }
  }

  return map;
})();

const level1 = (function () {
  const map = grid(0); // 0 — пустота: уровня здесь нет, виден нижний

  for (let x = bridge.left; x <= bridge.right; x += 1) {
    for (let y = bridge.slabTop; y <= bridge.slabBottom; y += 1) {
      map[y][x] = tiles.slab;
    }

    // перила по обеим длинным сторонам, кроме проёмов под рампы и
    // разрывов-обрывов
    const openNorth =
      inRange(x, rampSouth.x0, rampSouth.x1) ||
      inRange(x, ledgeNorth.x0, ledgeNorth.x1);
    const openSouth =
      inRange(x, rampNorth.x0, rampNorth.x1) ||
      inRange(x, ledgeSouth.x0, ledgeSouth.x1);

    map[bridge.railNorth][x] = openNorth ? tiles.slab : tiles.railing;
    map[bridge.railSouth][x] = openSouth ? tiles.slab : tiles.railing;

    // торцы: без них с конца моста уезжают в пустоту мимо периметра —
    // стены уровня 0 танку на плите не преграда
    if (x === bridge.left || x === bridge.right) {
      for (let y = bridge.slabTop; y <= bridge.slabBottom; y += 1) {
        map[y][x] = tiles.railing;
      }
    }
  }

  return map;
})();

// центр тайла в НЕмасштабированных мировых единицах (scale накладывает
// движок при раздаче MAP_DATA)
const at = (x, y) => [x * step + step / 2, y * step + step / 2];

// у динамического объекта `position` — ЛЕВЫЙ ВЕРХНИЙ угол тела, а не центр
// (как в canopy.js), поэтому ящик 64 × 64 ставим так, чтобы он целиком лёг
// на тайл (x, y) и не задел перила соседних строк
const box = (x, y, level, size = 64) => ({
  density: 40,
  layer: 3,
  position: [x * step, y * step + (step - size) / 2],
  angle: 0,
  width: size,
  height: size,
  img: 'b1.png',
  linearDamping: 6.0,
  angularDamping: 14.0,
  level,
});

// [x, y, angle] — уровень выведется из геометрии (0, если точка не под
// плитой); [x, y, angle, level] — уровень задан явно
const spawn = (x, y, angle) => [...at(x, y), angle];
const spawnOn = (x, y, angle, level) => [...at(x, y), angle, level];

export default {
  setId: 'c1',

  scale: 0.4,

  // кадры взяты из общего листа assets/img/tiles.png (544 × 288,
  // сетка 32 × 32 ⇒ 17 колонок × 9 строк). Собственный тайл-лист города —
  // отдельная задача; менять надо только эти шесть координат
  spriteSheet: {
    img: 'tiles.png',
    frames: [
      [480, 64, 32, 32], // 0: асфальт
      [128, 224, 32, 32], // 1: стена здания
      [288, 64, 32, 32], // 2: плита моста
      [352, 96, 32, 32], // 3: перила моста
      [352, 64, 32, 32], // 4: рампа, подъём на север
      [384, 64, 32, 32], // 5: рампа, подъём на юг
    ],
  },

  // рендер-слои уровня 0
  layers: {
    1: [tiles.ground, tiles.rampNorth, tiles.rampSouth], // под танком
    2: [tiles.wall],
  },

  // высоты объёмов: здания уровня 0 — в целый уровень
  volumes: {
    2: 1.0,
  },

  step,

  physicsStatic: [tiles.wall],

  // надземные уровни; ключ — номер уровня строкой
  levels: {
    1: {
      map: level1,
      floor: [tiles.slab, tiles.railing],
      walls: [tiles.railing],
      // zIndex внутри уровня; движок сдвигает его на LEVEL_Z_STRIDE
      layers: {
        1: [tiles.slab], // плита под танком (zIndex 101)
        4: [tiles.railing], // перила над танком (zIndex 104)
      },
      // перила — низкий объём: экструзия в четверть уровня
      volumes: {
        4: 0.35,
      },
    },
  },

  ramps: [
    { tile: tiles.rampNorth, dir: 'north', from: 0, to: 1 },
    { tile: tiles.rampSouth, dir: 'south', from: 0, to: 1 },
  ],

  // 2 ящика на земле под мостом и 2 на плите — проверка `level` динамики.
  // Мостовые ящики — по одному тайлу, у самых разрывов перил: у динамики
  // карты есть правила уровня, поэтому вытолкнутый в разрыв ящик падает на
  // землю и меняет уровень, а не висит над пустотой.
  // Средний ряд плиты (29) свободен — по нему идут отладочные сценарии
  physicsDynamic: [
    box(20, 28, 0),
    box(60, 28, 0),
    box(31, bridge.slabTop, 1, 32),
    box(49, bridge.slabBottom, 1, 32),
  ],

  // по 10 точек: 8 наземных (уровень выводится) и 2 мостовых (явный 1).
  // Ни одна наземная точка не стоит под плитой — иначе выведенный уровень
  // оказался бы 1
  respawns: {
    team1: [
      // первая точка — у подножия западной рампы, носом на север: с неё
      // въезд на мост — одна клавиша (tests/scenarios/bridge.json)
      spawn(3, 38, 270),
      spawn(9, 38, 0),
      spawn(6, 6, 0),
      spawn(12, 6, 0),
      spawn(6, 14, 0),
      spawn(12, 14, 0),
      spawn(6, 22, 0),
      spawn(12, 22, 0),
      spawnOn(10, 29, 0, 1),
      spawnOn(16, 29, 0, 1),
    ],
    team2: [
      // первая точка — под южным разрывом перил, носом на север: отсюда
      // видно кромку моста снизу (tests/scenarios/crosslevel.json)
      spawn(49, 36, 270),
      spawn(70, 38, 180),
      spawn(73, 6, 180),
      spawn(67, 6, 180),
      spawn(73, 14, 180),
      spawn(67, 14, 180),
      spawn(73, 22, 180),
      spawn(67, 22, 180),
      spawnOn(69, 29, 180, 1),
      spawnOn(63, 29, 180, 1),
    ],
  },

  map: level0,
};
