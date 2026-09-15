import { T, frames } from './city/tiles.js';

// Ночной город на два уровня — эталон `game`-полей карты: поверхности,
// разрушаемые пропы, ночное освещение, анимированные тайлы, неон и декали.
// Графика — заглушки scripts/generate-placeholder-art.js (city.png,
// prop_*.png); финальный арт заменяет файлы без правок кода.
//
// Районы (клетки [col, row], сетка 96 × 72):
//  * запад и восток (1–14 и 81–94 × 20–52) — базы команд, по 8 респаунов;
//  * центр «Neon Strip» (37–58 × 28–43) — перекрёсток, масляное пятно,
//    фонари по углам, вывески на крышах;
//  * эстакада W–E (уровень 1, ряды 20–26) над проспектом, рампы на концах
//    и два разрыва перил;
//  * северо-запад — промзона: встречные конвейеры, ящики, группа бочек,
//    вентиляторы на крышах;
//  * северо-восток — стройка: песок, грязь, заборы, ящики;
//  * юг — канал с водой, два моста уровня 1 и брод с бустером;
//  * прыжок (запад центра) — бустер перед рампой на крышу-парковку.
//
// Пропы стоят только во дворах, на срезках и в тупиках: граф навигации
// ботов строится по статике, и проп в единственном проезде запер бы бота
// (tests/scenarios/bots_downtown.json).
//
// Она же — фикстура сценариев tests/scenarios/downtown_*.json.

const width = 96;
const height = 72;
const step = 32;

// эстакада: перила в рядах 20 и 26, плита 21..25, рампы на концах
const overpass = { x0: 22, x1: 73, railNorth: 20, railSouth: 26 };
const overpassRampWest = { x0: 15, x1: 21 };
const overpassRampEast = { x0: 74, x1: 80 };
// разрывы перил над проспектом — уступы
const overpassLedgeNorth = { x0: 38, x1: 40 };
const overpassLedgeSouth = { x0: 55, x1: 57 };

// прыжок: бустер → рампа → крыша-парковка. От выхода рампы (x0) до
// восточных перил 11 клеток плиты — площадка приземления с запасом
const parking = { x0: 24, x1: 36, y0: 30, y1: 40 };
const jumpBoost = { x0: 18, x1: 19, y0: 34, y1: 36 };
const jumpRamp = { x0: 20, x1: 23, y0: 34, y1: 36 };
const parkingLedge = { x0: 29, x1: 31 };

// канал: стены в рядах 54 и 62, вода между ними
const canal = { wallNorth: 54, wallSouth: 62 };
// мосты уровня 1 через канал: перила по колонкам x0/x1, плита между ними;
// рампы по концам (северная — подъём на юг, южная — на север)
const bridges = [
  { x0: 27, x1: 31 },
  { x0: 64, x1: 68 },
];
const bridgeDeck = { y0: 53, y1: 63 };
const bridgeRampNorth = { y0: 50, y1: 52 };
const bridgeRampSouth = { y0: 64, y1: 66 };
// брод напротив проезда к центру и бустер на южном берегу
const ford = { x0: 45, x1: 50 };
const fordBoost = { x0: 47, x1: 48, y0: 64, y1: 65 };

// здания: стены уровня 0, у `roof` — крыша уровня 1 (под вывески и
// вентиляторы). Вокруг каждого — кольцо тротуара: край крыши обязан
// выходить на проходимую землю
const buildings = [
  // промзона
  { x0: 4, x1: 10, y0: 3, y1: 7, roof: true },
  { x0: 25, x1: 31, y0: 3, y1: 7, roof: true },
  // север центра
  { x0: 37, x1: 44, y0: 3, y1: 15 },
  { x0: 51, x1: 58, y0: 3, y1: 15 },
  // стройка
  { x0: 85, x1: 91, y0: 3, y1: 7 },
  // Neon Strip
  { x0: 38, x1: 43, y0: 29, y1: 32, roof: true },
  { x0: 52, x1: 57, y0: 29, y1: 32, roof: true },
  { x0: 38, x1: 43, y0: 39, y1: 42, roof: true },
  { x0: 52, x1: 57, y0: 39, y1: 42, roof: true },
  // укрытие к востоку от центра (напротив парковки)
  { x0: 62, x1: 70, y0: 31, y1: 39 },
  // базы
  { x0: 3, x1: 8, y0: 45, y1: 50, roof: true },
  { x0: 87, x1: 92, y0: 45, y1: 50, roof: true },
];

const grid = fill =>
  Array.from({ length: height }, () => Array(width).fill(fill));

const rect = (map, x0, y0, x1, y1, tile) => {
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      map[y][x] = tile;
    }
  }
};

const hline = (map, y, x0, x1, tile) => rect(map, x0, y, x1, y, tile);
const vline = (map, x, y0, y1, tile) => rect(map, x, y0, x, y1, tile);

const inRange = (value, from, to) => value >= from && value <= to;

// пунктир разметки по чётным клеткам
const dashes = (map, y, x0, x1) => {
  for (let x = x0; x <= x1; x += 2) {
    if (map[y][x] === T.ASPHALT) {
      map[y][x] = T.LANE;
    }
  }
};

const level0 = (function () {
  const map = grid(T.ASPHALT);

  // здания с кольцом тротуара
  for (const b of buildings) {
    rect(map, b.x0 - 1, b.y0 - 1, b.x1 + 1, b.y1 + 1, T.SIDEWALK);
  }

  for (const b of buildings) {
    rect(map, b.x0, b.y0, b.x1, b.y1, T.WALL);
  }

  // разметка: проспект под эстакадой, Neon Strip, южная дорога и берег
  dashes(map, 23, 2, 93);
  dashes(map, 35, 38, 44);
  dashes(map, 35, 51, 57);
  dashes(map, 47, 2, 93);
  dashes(map, 68, 2, 93);

  // промзона: встречные конвейеры по 12 клеток
  rect(map, 6, 11, 17, 12, T.CONVEYOR_E);
  rect(map, 16, 15, 27, 16, T.CONVEYOR_W);

  // стройка: пятна песка и грязи
  rect(map, 63, 9, 72, 15, T.SAND);
  rect(map, 80, 12, 90, 16, T.SAND);
  rect(map, 73, 3, 79, 8, T.MUD);
  rect(map, 75, 11, 79, 16, T.MUD);

  // масляное пятно 6 × 4 в центре перекрёстка
  rect(map, 45, 34, 50, 37, T.OIL);

  // канал: вода через всю ширину, стены с проёмами под мостами и у брода
  rect(map, 1, canal.wallNorth + 1, width - 2, canal.wallSouth - 1, T.WATER);

  for (const y of [canal.wallNorth, canal.wallSouth]) {
    for (let x = 1; x < width - 1; x += 1) {
      const open =
        inRange(x, ford.x0, ford.x1) ||
        bridges.some(bridge => inRange(x, bridge.x0, bridge.x1));

      if (!open) {
        map[y][x] = T.CANAL_WALL;
      }
    }
  }

  // бустеры: брод на север и разгон перед рампой парковки на восток
  rect(map, fordBoost.x0, fordBoost.y0, fordBoost.x1, fordBoost.y1, T.BOOST_N);
  rect(map, jumpBoost.x0, jumpBoost.y0, jumpBoost.x1, jumpBoost.y1, T.BOOST_E);

  // рампы лежат в гриде уровня 0
  rect(map, overpassRampWest.x0, overpass.railNorth + 1, overpassRampWest.x1, overpass.railSouth - 1, T.RAMP_E);
  rect(map, overpassRampEast.x0, overpass.railNorth + 1, overpassRampEast.x1, overpass.railSouth - 1, T.RAMP_W);
  rect(map, jumpRamp.x0, jumpRamp.y0, jumpRamp.x1, jumpRamp.y1, T.RAMP_E);

  for (const bridge of bridges) {
    rect(map, bridge.x0 + 1, bridgeRampNorth.y0, bridge.x1 - 1, bridgeRampNorth.y1, T.RAMP_S);
    rect(map, bridge.x0 + 1, bridgeRampSouth.y0, bridge.x1 - 1, bridgeRampSouth.y1, T.RAMP_N);
  }

  // периметр
  hline(map, 0, 0, width - 1, T.WALL);
  hline(map, height - 1, 0, width - 1, T.WALL);
  vline(map, 0, 0, height - 1, T.WALL);
  vline(map, width - 1, 0, height - 1, T.WALL);

  return map;
})();

const level1 = (function () {
  const map = grid(T.EMPTY); // 0 — пустота: уровня здесь нет, виден нижний

  // крыши зданий (визуальные, но в `floor`: карта освещённости уровня
  // затемняет только его плиту)
  for (const b of buildings) {
    if (b.roof) {
      rect(map, b.x0, b.y0, b.x1, b.y1, T.ROOF);
    }
  }

  // эстакада: торцы — выходы рамп во всю ширину плиты, перила по длинным
  // сторонам кроме разрывов
  rect(map, overpass.x0, overpass.railNorth + 1, overpass.x1, overpass.railSouth - 1, T.SLAB);

  for (let x = overpass.x0; x <= overpass.x1; x += 1) {
    map[overpass.railNorth][x] = inRange(x, overpassLedgeNorth.x0, overpassLedgeNorth.x1)
      ? T.SLAB
      : T.RAILING;
    map[overpass.railSouth][x] = inRange(x, overpassLedgeSouth.x0, overpassLedgeSouth.x1)
      ? T.SLAB
      : T.RAILING;
  }

  // масляное пятно на эстакаде
  rect(map, 60, 22, 62, 24, T.OIL);

  // крыша-парковка: периметр — перила, кроме выхода рампы (запад) и
  // разрыва на южной стороне
  rect(map, parking.x0, parking.y0, parking.x1, parking.y1, T.SLAB);
  hline(map, parking.y0, parking.x0, parking.x1, T.RAILING);
  hline(map, parking.y1, parking.x0, parking.x1, T.RAILING);
  vline(map, parking.x0, parking.y0, parking.y1, T.RAILING);
  vline(map, parking.x1, parking.y0, parking.y1, T.RAILING);
  vline(map, parking.x0, jumpRamp.y0, jumpRamp.y1, T.SLAB);
  hline(map, parking.y1, parkingLedge.x0, parkingLedge.x1, T.SLAB);

  // мосты через канал: торцы — выходы рамп
  for (const bridge of bridges) {
    rect(map, bridge.x0 + 1, bridgeDeck.y0, bridge.x1 - 1, bridgeDeck.y1, T.SLAB);
    vline(map, bridge.x0, bridgeDeck.y0, bridgeDeck.y1, T.RAILING);
    vline(map, bridge.x1, bridgeDeck.y0, bridgeDeck.y1, T.RAILING);
  }

  return map;
})();

// центр тайла в НЕмасштабированных мировых единицах (scale накладывает
// движок при раздаче MAP_DATA)
const at = (x, y) => [x * step + step / 2, y * step + step / 2];

// у динамического объекта `position` — ЛЕВЫЙ ВЕРХНИЙ угол тела: тело
// центрируется на клетке (x, y); забор в 2 клетки начинается с клетки x
const body = (x, y, w, h, extra) => ({
  layer: 3,
  position: [x * step + (step - w) / 2, y * step + (step - h) / 2],
  angle: 0,
  width: w,
  height: h,
  linearDamping: 6.0,
  angularDamping: 14.0,
  level: 0,
  ...extra,
});

const fence = (x, y) => ({
  ...body(x, y, 64, 12, {}),
  position: [x * step, y * step + (step - 12) / 2],
  density: 30,
  img: 'prop_fence.png',
  game: { prop: 'fence', imgDestroyed: 'prop_fence_broken.png' },
});

const crate = (x, y, level = 0) =>
  body(x, y, 32, 32, {
    density: 40,
    img: 'prop_crate.png',
    level,
    game: {
      prop: 'crate',
      imgDamaged: 'prop_crate_damaged.png',
      imgDestroyed: 'prop_crate_broken.png',
    },
  });

const barrel = (x, y) =>
  body(x, y, 24, 24, {
    density: 30,
    img: 'prop_barrel.png',
    game: { prop: 'barrel' },
  });

// все респауны наземные, уровень 0 объявлен явно
const spawn = (x, y, angle) => [...at(x, y), angle, 0];

const lamp = (x, y, level = 0, extra = {}) => ({
  cell: [x, y],
  level,
  radius: 110,
  color: 0xffc070,
  intensity: 0.9,
  head: true,
  flicker: 0,
  ...extra,
});

const every = (from, to, by, make) => {
  const out = [];

  for (let v = from; v <= to; v += by) {
    out.push(make(v));
  }

  return out;
};

const belt = 60; // = coreParams.surfaces.types.conveyor.belt

export default {
  setId: 'c1',

  scale: 0.4,

  spriteSheet: {
    img: 'city.png',
    frames,
  },

  // рендер-слои уровня 0: стены канала — отдельный низкий объём, в общем
  // слое с 1.0 они вытянулись бы на полный этаж, как здания
  layers: {
    1: [
      T.ASPHALT,
      T.SIDEWALK,
      T.LANE,
      T.SAND,
      T.MUD,
      T.WATER,
      T.OIL,
      T.CONVEYOR_E,
      T.CONVEYOR_W,
      T.BOOST_N,
      T.BOOST_E,
      T.RAMP_N,
      T.RAMP_S,
      T.RAMP_E,
      T.RAMP_W,
    ],
    2: [T.WALL],
    4: [T.CANAL_WALL],
  },

  volumes: {
    2: 1.0,
    4: 0.25,
  },

  step,

  physicsStatic: [T.WALL, T.CANAL_WALL],

  levels: {
    1: {
      map: level1,
      floor: [T.SLAB, T.RAILING, T.ROOF, T.OIL],
      walls: [T.RAILING],
      // крыши — свой слой 2 (`game.roofs`): они непрозрачны, пока не
      // закрывают танк; вывески и вентиляторы стоят на нём, а не на перилах
      layers: {
        1: [T.SLAB, T.OIL],
        2: [T.ROOF],
        4: [T.RAILING],
      },
      volumes: {
        4: 0.35,
      },
    },
  },

  ramps: [
    { tile: T.RAMP_E, dir: 'east', from: 0, to: 1 },
    { tile: T.RAMP_W, dir: 'west', from: 0, to: 1 },
    { tile: T.RAMP_S, dir: 'south', from: 0, to: 1 },
    { tile: T.RAMP_N, dir: 'north', from: 0, to: 1 },
  ],

  physicsDynamic: [
    // промзона: ящики во дворе, бочки группой у западной ленты (цепная
    // реакция)
    crate(3, 11),
    crate(3, 13),
    crate(20, 10),
    crate(21, 10),
    crate(31, 15),
    crate(32, 15),
    barrel(28, 13),
    barrel(29, 13),
    barrel(28, 14),
    barrel(29, 14),
    // стройка: две линии заборов с объездом по краям, ящики
    fence(62, 8),
    fence(64, 8),
    fence(66, 8),
    fence(68, 8),
    fence(70, 8),
    fence(82, 11),
    fence(84, 11),
    fence(86, 11),
    fence(88, 11),
    fence(90, 11),
    crate(66, 4),
    crate(68, 4),
    crate(80, 4),
    crate(82, 4),
    // бочки у стены канала
    barrel(10, 63),
    barrel(85, 63),
    // ящики на крыше-парковке, в стороне от полосы приземления
    crate(34, 31, 1),
    crate(35, 31, 1),
  ],

  // первые точки команд — стартовые позиции сценариев
  // tests/scenarios/downtown_*.json (одна клавиша до цели)
  respawns: {
    team1: [
      // носом на восток: прямо на западную рампу эстакады
      spawn(9, 24, 0),
      // вдоль северного края рампы: под эстакадой
      spawn(4, 20, 0),
      // бустер → рампа → крыша-парковка
      spawn(9, 35, 0),
      // под парковкой к масляному пятну перекрёстка
      spawn(4, 37, 0),
      spawn(4, 29, 0),
      spawn(9, 29, 0),
      spawn(4, 42, 0),
      spawn(9, 42, 0),
    ],
    team2: [
      spawn(86, 24, 180),
      spawn(91, 24, 180),
      spawn(86, 35, 180),
      spawn(91, 37, 180),
      spawn(91, 29, 180),
      spawn(86, 29, 180),
      spawn(91, 42, 180),
      spawn(86, 42, 180),
    ],
  },

  game: {
    surfaces: {
      0: {
        [T.SAND]: 'sand',
        [T.MUD]: 'mud',
        [T.WATER]: 'water',
        [T.OIL]: 'oil',
        [T.CONVEYOR_E]: { type: 'conveyor', dir: 'east' },
        [T.CONVEYOR_W]: { type: 'conveyor', dir: 'west' },
        [T.BOOST_N]: { type: 'boost', dir: 'north' },
        [T.BOOST_E]: { type: 'boost', dir: 'east' },
      },
      1: {
        [T.OIL]: 'oil',
      },
    },

    lighting: {
      night: true,
      ambient: 0x3a4260,
      lamps: [
        // проспект: по обе стороны эстакады, не под плитой
        ...every(12, 84, 8, x => lamp(x, 19)),
        ...every(16, 80, 8, x => lamp(x, 27)),
        // перекрёсток Neon Strip
        lamp(44, 33, 0, { color: 0xffd9a0 }),
        lamp(51, 33, 0, { color: 0xffd9a0 }),
        lamp(44, 38, 0, { color: 0xffd9a0 }),
        lamp(51, 38, 0, { color: 0xffd9a0 }),
        // южная дорога и берег канала
        ...every(12, 84, 8, x => lamp(x, 45)),
        ...every(16, 80, 16, x => lamp(x, 68, 0, { flicker: 0.2 })),
        // базы и районы
        lamp(12, 32, 0, { color: 0xa0c8ff }),
        lamp(83, 32, 0, { color: 0xa0c8ff }),
        lamp(15, 9, 0, { flicker: 0.35 }),
        lamp(80, 10, 0, { flicker: 0.35 }),
        // свои фонари уровня 1: эстакада, парковка, мосты
        ...every(26, 70, 8, x => lamp(x, 23, 1, { radius: 90, color: 0xcfe0ff })),
        lamp(30, 35, 1, { radius: 100 }),
        lamp(29, 58, 1, { radius: 90 }),
        lamp(66, 58, 1, { radius: 90 }),
      ],
    },

    animatedTiles: {
      [T.WATER]: {
        kind: 'frames',
        frames: [T.WATER, T.WATER_2, T.WATER_3, T.WATER_4],
        fps: 4,
      },
      [T.CONVEYOR_E]: {
        kind: 'frames',
        frames: [T.CONVEYOR_E, T.CONVEYOR_E_2, T.CONVEYOR_E_3, T.CONVEYOR_E_4],
        speed: belt,
      },
      [T.CONVEYOR_W]: {
        kind: 'frames',
        frames: [T.CONVEYOR_W, T.CONVEYOR_W_2, T.CONVEYOR_W_3, T.CONVEYOR_W_4],
        speed: belt,
      },
      [T.BOOST_N]: { kind: 'frames', frames: [T.BOOST_N, T.BOOST_N_2], fps: 2 },
      [T.BOOST_E]: { kind: 'frames', frames: [T.BOOST_E, T.BOOST_E_2], fps: 2 },
    },

    // крыши уровня 1: отдельный рендер-слой, см. `levels[1].layers`
    roofs: { 1: [T.ROOF] },

    signs: [
      {
        cell: [40, 30],
        level: 1,
        layer: 2,
        text: 'HOTEL',
        color: 0xff3ad0,
        size: 18,
        flicker: { pulse: 0.15, dropouts: 0.1 },
        light: { radius: 80, intensity: 0.7 },
      },
      {
        cell: [55, 30],
        level: 1,
        layer: 2,
        text: 'BAR',
        color: 0x3ae0ff,
        size: 20,
        flicker: { pulse: 0.3, dropouts: 0.3 },
        light: { radius: 70, intensity: 0.6 },
      },
      {
        cell: [40, 41],
        level: 1,
        layer: 2,
        text: 'CLUB',
        color: 0x9a5aff,
        size: 18,
        angle: -8,
        flicker: { pulse: 0.05, dropouts: 0 },
        light: { radius: 80, intensity: 0.7 },
      },
      {
        cell: [55, 41],
        level: 1,
        layer: 2,
        text: 'MOTEL',
        color: 0xff5a3a,
        size: 16,
        flicker: { pulse: 0.2, dropouts: 0.5 },
        light: { radius: 70, intensity: 0.6 },
      },
      {
        cell: [5, 47],
        level: 1,
        layer: 2,
        text: 'GUNS',
        color: 0x5aff7a,
        size: 16,
        flicker: { pulse: 0.1, dropouts: 0.05 },
        light: { radius: 60, intensity: 0.5 },
      },
      {
        cell: [90, 47],
        level: 1,
        layer: 2,
        text: 'GUNS',
        color: 0x5aff7a,
        size: 16,
        flicker: { pulse: 0.1, dropouts: 0.2 },
        light: { radius: 60, intensity: 0.5 },
      },
    ],

    // вентиляторы на крышах промзоны
    decals: [
      { cell: [6, 5], level: 1, layer: 2, frame: T.FAN, kind: 'rotate', rps: 1.5 },
      { cell: [8, 5], level: 1, layer: 2, frame: T.FAN, kind: 'rotate', rps: 1.1 },
      { cell: [27, 5], level: 1, layer: 2, frame: T.FAN, kind: 'rotate', rps: 1.8 },
      { cell: [29, 5], level: 1, layer: 2, frame: T.FAN, kind: 'rotate', rps: 0.9 },
    ],
  },

  map: level0,
};
