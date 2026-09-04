// Демо-карта многоуровневых карт (2.5D) на ТРИ уровня: земля (0), нижняя
// терраса (1) и верхняя площадка (2). Здесь видно каждую возможность второй
// итерации:
//
//  * рампа 0 → 2 одним прогоном (`rampSteep`) — над её клетками плиты
//    уровня 1 нет, иначе подъём прошивал бы чужую плиту;
//  * ступенчатый путь 0 → 1 → 2 двумя рампами (`rampLong` + `rampStep`);
//  * `rampSide` — рампа, верхний торец которой упирается в проезд уровня 0
//    под плитой: снизу к нему подъезжают, но подняться нельзя (гейт входа
//    пускает на прогон только с торца, отвечающего уровню танка);
//  * ящики уровней 1 и 2 стоят у разрывов перил и падают — на нижнюю плиту
//    или на землю, смотря что под обрывом;
//  * `volumes` — высоты рендер-слоёв: здания уровня 0 и перила уровней 1—2;
//  * разная крутизна: короткий крутой прогон и длинный пологий.
//
// Она же — фикстура отладочных сценариев tests/scenarios/terraces_climb.json,
// terraces_backside.json, terraces_crate.json.

const width = 72;
const height = 48;
const step = 32;

// тайлы (индексы в spriteSheet.frames)
const tiles = {
  ground: 0, // асфальт, уровень 0
  wall: 1, // стена здания, уровень 0 (physicsStatic)
  slab1: 2, // плита нижней террасы, уровень 1 (floor)
  railing1: 3, // перила нижней террасы, уровень 1 (floor + walls)
  slab2: 4, // плита верхней площадки, уровень 2 (floor)
  railing2: 5, // перила верхней площадки, уровень 2 (floor + walls)
  rampLong: 6, // длинный пологий прогон 0 → 1, подъём на восток
  rampSide: 7, // прогон 0 → 1, подъём на север, торцом в проезд под плитой
  rampSteep: 8, // короткий крутой прогон 0 → 2, подъём на запад
  rampStep: 9, // прогон 1 → 2, подъём на восток (лежит в гриде уровня 1)
};

// нижняя терраса и верхняя площадка. Площадка перекрывает террасу с запада
// (x 34..46) и вылезает за неё на восток (x 47..52): за восточной кромкой
// плиты уровня 1 нет — только там и могла лечь рампа 0 → 2
const terrace = { x0: 14, x1: 46, y0: 12, y1: 30 };
const upper = { x0: 34, x1: 52, y0: 16, y1: 26 };

// прогоны. Крутизна — перепад уровней на длину прогона: 1 уровень на 9
// клеток у `rampLong` против 2 уровней на 4 клетки у `rampSteep`
const rampLong = { x0: 5, x1: 13, y: 21 };
const rampSide = { x: 24, y0: 31, y1: 34 };
const rampSteep = { x0: 53, x1: 56, y: 21 };
const rampStep = { x0: 31, x1: 33, y: 21 };

// разрывы перил — обрывы, с которых падают: северный разрыв террасы отдаёт
// на землю, южный разрыв площадки — на плиту террасы этажом ниже
const ledgeTerrace = { x0: 20, x1: 22 };
const ledgeUpper = { x0: 40, x1: 42 };

// здания уровня 0: им и отданы `volumes` — объём виден по смещению стен
// относительно камеры. Ни одно не стоит под обрывом: приземлиться нужно на
// проходимую землю
const buildings = [
  { x0: 8, x1: 11, y0: 14, y1: 17 },
  { x0: 60, x1: 63, y0: 30, y1: 33 },
];

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

  for (const building of buildings) {
    for (let y = building.y0; y <= building.y1; y += 1) {
      for (let x = building.x0; x <= building.x1; x += 1) {
        map[y][x] = tiles.wall;
      }
    }
  }

  // прогоны лежат в гриде того уровня, С которого идут: три из четырёх — в
  // гриде земли
  for (let x = rampLong.x0; x <= rampLong.x1; x += 1) {
    map[rampLong.y][x] = tiles.rampLong;
  }

  for (let y = rampSide.y0; y <= rampSide.y1; y += 1) {
    map[y][rampSide.x] = tiles.rampSide;
  }

  for (let x = rampSteep.x0; x <= rampSteep.x1; x += 1) {
    map[rampSteep.y][x] = tiles.rampSteep;
  }

  return map;
})();

// плита прямоугольником: периметр — перила, кроме проёмов (выходы рамп) и
// разрывов (обрывы). Перила обязаны входить и в `floor`, иначе они не
// экранируют луч снизу
const slabRect = (map, rect, floorTile, wallTile, isOpen) => {
  for (let y = rect.y0; y <= rect.y1; y += 1) {
    for (let x = rect.x0; x <= rect.x1; x += 1) {
      const edge =
        x === rect.x0 || x === rect.x1 || y === rect.y0 || y === rect.y1;

      map[y][x] = edge && !isOpen(x, y) ? wallTile : floorTile;
    }
  }
};

const level1 = (function () {
  const map = grid(0); // 0 — пустота: уровня здесь нет, виден нижний

  slabRect(
    map,
    terrace,
    tiles.slab1,
    tiles.railing1,
    (x, y) =>
      // выход длинной рампы на западном торце
      (x === terrace.x0 && y === rampLong.y) ||
      // выход рампы из-под плиты на южном торце
      (y === terrace.y1 && x === rampSide.x) ||
      // разрыв перил на северном торце
      (y === terrace.y0 && inRange(x, ledgeTerrace.x0, ledgeTerrace.x1)),
  );

  // прогон 1 → 2 идёт по плите террасы: его клетки — часть `floor`
  for (let x = rampStep.x0; x <= rampStep.x1; x += 1) {
    map[rampStep.y][x] = tiles.rampStep;
  }

  return map;
})();

const level2 = (function () {
  const map = grid(0);

  slabRect(
    map,
    upper,
    tiles.slab2,
    tiles.railing2,
    (x, y) =>
      // выход ступенчатой рампы на западном торце
      (x === upper.x0 && y === rampStep.y) ||
      // выход крутой рампы на восточном торце
      (x === upper.x1 && y === rampSteep.y) ||
      // разрыв перил на южном торце: под ним плита террасы
      (y === upper.y1 && inRange(x, ledgeUpper.x0, ledgeUpper.x1)),
  );

  return map;
})();

// центр тайла в НЕмасштабированных мировых единицах (scale накладывает
// движок при раздаче MAP_DATA)
const at = (x, y) => [x * step + step / 2, y * step + step / 2];

// у динамического объекта `position` — ЛЕВЫЙ ВЕРХНИЙ угол тела, а не центр
// (как в canopy.js), поэтому ящик ставим так, чтобы он целиком лёг на тайл
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

// [x, y, angle] — уровень выведется из геометрии (точка под плитой отдаст
// танк НАВЕРХ); [x, y, angle, level] — уровень задан явно
const spawn = (x, y, angle) => [...at(x, y), angle];
const spawnOn = (x, y, angle, level) => [...at(x, y), angle, level];

export default {
  setId: 'c1',

  scale: 0.4,

  // кадры взяты из общего листа assets/img/tiles.png (544 × 288,
  // сетка 32 × 32 ⇒ 17 колонок × 9 строк)
  spriteSheet: {
    img: 'tiles.png',
    frames: [
      [480, 64, 32, 32], // 0: асфальт
      [128, 224, 32, 32], // 1: стена здания
      [288, 64, 32, 32], // 2: плита террасы
      [352, 96, 32, 32], // 3: перила террасы
      [96, 0, 32, 32], // 4: плита верхней площадки
      [64, 32, 32, 32], // 5: перила верхней площадки
      [352, 64, 32, 32], // 6: длинная рампа 0 → 1
      [384, 64, 32, 32], // 7: рампа 0 → 1 из-под плиты
      [416, 64, 32, 32], // 8: крутая рампа 0 → 2
      [320, 64, 32, 32], // 9: рампа 1 → 2
    ],
  },

  // рендер-слои уровня 0
  layers: {
    1: [tiles.ground, tiles.rampLong, tiles.rampSide, tiles.rampSteep],
    2: [tiles.wall],
  },

  // высоты объёмов уровня 0: здания в целый уровень
  volumes: {
    2: 1.0,
  },

  step,

  physicsStatic: [tiles.wall],

  // надземные уровни; ключ — номер уровня строкой
  levels: {
    1: {
      map: level1,
      floor: [tiles.slab1, tiles.railing1, tiles.rampStep],
      walls: [tiles.railing1],
      // zIndex внутри уровня; движок сдвигает его на LEVEL_Z_STRIDE
      layers: {
        1: [tiles.slab1, tiles.rampStep], // плита под танком
        4: [tiles.railing1], // перила над танком
      },
      volumes: {
        4: 0.35,
      },
    },
    2: {
      map: level2,
      floor: [tiles.slab2, tiles.railing2],
      walls: [tiles.railing2],
      layers: {
        1: [tiles.slab2],
        4: [tiles.railing2],
      },
      volumes: {
        4: 0.35,
      },
    },
  },

  ramps: [
    { tile: tiles.rampLong, dir: 'east', from: 0, to: 1 },
    { tile: tiles.rampSide, dir: 'north', from: 0, to: 1 },
    { tile: tiles.rampSteep, dir: 'west', from: 0, to: 2 },
    { tile: tiles.rampStep, dir: 'east', from: 1, to: 2 },
  ],

  // ящики у разрывов перил (падают: с площадки — на плиту террасы, с
  // террасы — на землю) и два на земле
  physicsDynamic: [
    box(41, 25, 2, 32),
    box(21, 13, 1, 32),
    box(8, 24, 0),
    box(62, 38, 0),
  ],

  // по 8 точек на команду. Уровень 1 и 2 объявлены явно; наземные точки
  // стоят вне плит — под плитой выведенный из геометрии уровень был бы 1,
  // поэтому единственная точка под террасой объявляет свой 0 явно
  respawns: {
    team1: [
      // подножие крутой рампы, носом на запад: отсюда 0 → 2 одним прогоном
      // (tests/scenarios/terraces_climb.json)
      spawn(58, 21, 180),
      // на верхней площадке севернее ящика, носом на юг: ящик сталкивается
      // в разрыв перил (tests/scenarios/terraces_crate.json)
      spawnOn(41, 22, 90, 2),
      spawnOn(20, 20, 0, 1),
      spawnOn(45, 18, 180, 2),
      spawn(5, 8, 0),
      spawn(9, 8, 0),
      spawn(5, 40, 0),
      spawn(9, 40, 0),
    ],
    team2: [
      // под плитой террасы, носом на юг: впереди верхний торец rampSide —
      // подъехать можно, подняться нельзя
      // (tests/scenarios/terraces_backside.json)
      spawnOn(24, 28, 90, 0),
      // западнее того же прогона, носом на восток: заезд сбоку тоже не
      // поднимает (tests/scenarios/terraces_backside.json)
      spawn(20, 33, 0),
      spawnOn(21, 15, 270, 1),
      spawnOn(50, 21, 180, 2),
      spawnOn(40, 28, 180, 1),
      spawn(60, 8, 180),
      spawn(64, 8, 180),
      spawn(60, 40, 180),
    ],
  },

  map: level0,
};
