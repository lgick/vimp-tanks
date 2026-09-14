import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  CELL,
  SHEET_COLUMNS,
  SHEET_ROWS,
  T,
  frames,
} from '../src/data/maps/city/tiles.js';

// Арт-заглушки карты downtown: тайл-лист assets/img/city.png и спрайты
// пропов assets/img/prop_*.png. Без зависимостей: PNG кодируется вручную
// (сигнатура, IHDR, IDAT через zlib, IEND, CRC32). Скрипт детерминированный
// (свой ГПСЧ с фиксированным зерном), повторный запуск даёт те же байты.
// Узнаваемые плоские цвета плюс простой узор, чтобы механика читалась без
// арта; финальный арт заменяет файлы, сохранив раскладку city.png
// (src/data/maps/city/tiles.js) и имена prop_*.png.
//
// Запуск: npm run art:placeholders

const outDir = fileURLToPath(new URL('../assets/img/', import.meta.url));

// --- PNG ---------------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;

  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }

  return c >>> 0;
});

const crc32 = buffer => {
  let crc = 0xffffffff;

  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);

  length.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(body));

  return Buffer.concat([length, body, crc]);
};

// RGBA 8 бит, без межстрочной фильтрации (фильтр 0 в начале каждой строки)
const encodePng = image => {
  const header = Buffer.alloc(13);

  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header[8] = 8;
  header[9] = 6;

  const stride = image.width * 4;
  const raw = Buffer.alloc((stride + 1) * image.height);

  for (let y = 0; y < image.height; y += 1) {
    raw[y * (stride + 1)] = 0;
    image.data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

// --- рисование ---------------------------------------------------------

const createImage = (width, height) => ({
  width,
  height,
  data: Buffer.alloc(width * height * 4),
});

// детерминированный ГПСЧ (mulberry32)
const createRandom = seed => {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;

    let t = state;

    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const rgb = hex => [(hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff];

// рисовальщик в прямоугольнике листа: координаты локальные, выход за
// пределы клетки отсекается
const createPen = (image, originX, originY, size) => {
  const set = (x, y, hex, alpha = 1) => {
    const px = Math.floor(x);
    const py = Math.floor(y);

    if (px < 0 || py < 0 || px >= size.w || py >= size.h) {
      return;
    }

    const index = ((originY + py) * image.width + originX + px) * 4;
    const [r, g, b] = rgb(hex);
    const a = image.data[index + 3] / 255;
    const outA = alpha + a * (1 - alpha);

    if (outA === 0) {
      return;
    }

    const mix = (src, dst) =>
      Math.round((src * alpha + dst * a * (1 - alpha)) / outA);

    image.data[index] = mix(r, image.data[index]);
    image.data[index + 1] = mix(g, image.data[index + 1]);
    image.data[index + 2] = mix(b, image.data[index + 2]);
    image.data[index + 3] = Math.round(outA * 255);
  };

  const rect = (x, y, w, h, hex, alpha = 1) => {
    for (let py = y; py < y + h; py += 1) {
      for (let px = x; px < x + w; px += 1) {
        set(px, py, hex, alpha);
      }
    }
  };

  const disc = (cx, cy, radius, hex, alpha = 1) => {
    for (let py = Math.floor(cy - radius); py <= cy + radius; py += 1) {
      for (let px = Math.floor(cx - radius); px <= cx + radius; px += 1) {
        if ((px + 0.5 - cx) ** 2 + (py + 0.5 - cy) ** 2 <= radius * radius) {
          set(px, py, hex, alpha);
        }
      }
    }
  };

  const speckle = (random, count, hex, alpha) => {
    for (let i = 0; i < count; i += 1) {
      set(random() * size.w, random() * size.h, hex, alpha);
    }
  };

  return { set, rect, disc, speckle, size };
};

// поворот локального узора на 90° шагами: 0 — как нарисовано (восток),
// 1 — север, 2 — запад, 3 — юг
const rotated = (pen, turns) => {
  const n = CELL - 1;
  const map = (x, y) => {
    switch (turns % 4) {
      case 1:
        return [y, n - x];
      case 2:
        return [n - x, n - y];
      case 3:
        return [n - y, x];
      default:
        return [x, y];
    }
  };

  return {
    ...pen,
    set: (x, y, hex, alpha) => pen.set(...map(x, y), hex, alpha),
    rect: (x, y, w, h, hex, alpha) => {
      for (let py = y; py < y + h; py += 1) {
        for (let px = x; px < x + w; px += 1) {
          pen.set(...map(px, py), hex, alpha);
        }
      }
    },
  };
};

// --- тайлы -------------------------------------------------------------

const asphalt = (pen, random) => {
  pen.rect(0, 0, CELL, CELL, 0x34373e);
  pen.speckle(random, 60, 0x4a4e57, 0.8);
  pen.speckle(random, 30, 0x24262b, 0.8);
};

// шеврон «>» с периодом 16 px, сдвинутый на phase px вдоль ленты
const chevrons = (pen, phase) => {
  pen.rect(0, 0, CELL, CELL, 0x2b2f35);
  pen.rect(0, 0, CELL, 3, 0x596069);
  pen.rect(0, CELL - 3, CELL, 3, 0x596069);

  for (let y = 4; y < CELL - 4; y += 1) {
    const offset = Math.abs(y - 15.5) / 2;

    for (let x = 0; x < CELL; x += 1) {
      const u = (((x - phase + offset) % 16) + 16) % 16;

      if (u < 4) {
        pen.set(x, y, 0xe0c040);
      }
    }
  }
};

// стрелка бустера на восток; bright — второй кадр пульса
const boostArrow = (pen, bright) => {
  pen.rect(0, 0, CELL, CELL, bright ? 0x4a3410 : 0x302410);
  pen.rect(1, 1, CELL - 2, 1, 0xff9a20);
  pen.rect(1, CELL - 2, CELL - 2, 1, 0xff9a20);

  const color = bright ? 0xfff070 : 0xffa830;

  pen.rect(5, 13, 12, 6, color);

  for (let x = 17; x < 27; x += 1) {
    const half = 27 - x;

    pen.rect(x, 16 - half, 1, half * 2, color);
  }
};

const water = (pen, phase) => {
  pen.rect(0, 0, CELL, CELL, 0x1f4f7a);

  for (let x = 0; x < CELL; x += 1) {
    for (const base of [6, 16, 26]) {
      const y = base + 2 * Math.sin(((x + phase * 8) / CELL) * 2 * Math.PI);

      pen.set(x, y, 0x6fb4e8, 0.9);
    }
  }
};

const ramp = (pen, random) => {
  pen.rect(0, 0, CELL, CELL, 0x7d8087);
  pen.speckle(random, 30, 0x5c5f66, 0.6);

  // поперечные рёбра и стрелка подъёма (на восток до поворота)
  for (let x = 2; x < CELL; x += 6) {
    pen.rect(x, 2, 2, CELL - 4, 0x5a5d63);
  }

  pen.rect(8, 15, 14, 2, 0xf0f0f0);
  pen.rect(20, 12, 2, 8, 0xf0f0f0);
  pen.rect(22, 13, 2, 6, 0xf0f0f0);
  pen.rect(24, 14, 2, 4, 0xf0f0f0);
};

const drawTile = (pen, id, random) => {
  switch (id) {
    case T.EMPTY:
      return;
    case T.ASPHALT:
      asphalt(pen, random);
      return;
    case T.SIDEWALK:
      pen.rect(0, 0, CELL, CELL, 0x676a70);
      pen.speckle(random, 30, 0x7c7f86, 0.7);
      pen.rect(0, 0, CELL, 1, 0x4c4f55);
      pen.rect(0, 16, CELL, 1, 0x4c4f55);
      pen.rect(0, 0, 1, CELL, 0x4c4f55);
      pen.rect(16, 0, 1, CELL, 0x4c4f55);
      return;
    case T.LANE:
      asphalt(pen, random);
      pen.rect(4, 15, 16, 3, 0xe8c83a);
      return;
    case T.SAND:
      pen.rect(0, 0, CELL, CELL, 0xc49a52);
      pen.speckle(random, 90, 0xe0bd78, 0.8);
      pen.speckle(random, 40, 0x94703a, 0.8);
      return;
    case T.MUD:
      pen.rect(0, 0, CELL, CELL, 0x4e3822);

      for (let i = 0; i < 6; i += 1) {
        pen.disc(random() * CELL, random() * CELL, 2 + random() * 3, 0x33240f, 0.8);
      }

      pen.speckle(random, 30, 0x6e5335, 0.7);
      return;
    case T.WATER:
    case T.WATER_2:
    case T.WATER_3:
    case T.WATER_4:
      water(pen, [T.WATER, T.WATER_2, T.WATER_3, T.WATER_4].indexOf(id));
      return;
    case T.OIL:
      asphalt(pen, random);
      pen.disc(16, 16, 14, 0x0c0c10, 0.95);
      pen.disc(12, 13, 5, 0x3a2a5a, 0.5);
      pen.disc(20, 20, 4, 0x1f4a4a, 0.5);
      return;
    case T.CONVEYOR_E:
    case T.CONVEYOR_E_2:
    case T.CONVEYOR_E_3:
    case T.CONVEYOR_E_4: {
      const frame = [T.CONVEYOR_E, T.CONVEYOR_E_2, T.CONVEYOR_E_3, T.CONVEYOR_E_4].indexOf(id);

      // кадр k сдвигает шевроны на k/4 тайла по ленте
      chevrons(pen, frame * (CELL / 4));
      return;
    }
    case T.CONVEYOR_W:
    case T.CONVEYOR_W_2:
    case T.CONVEYOR_W_3:
    case T.CONVEYOR_W_4: {
      const frame = [T.CONVEYOR_W, T.CONVEYOR_W_2, T.CONVEYOR_W_3, T.CONVEYOR_W_4].indexOf(id);

      chevrons(rotated(pen, 2), frame * (CELL / 4));
      return;
    }
    case T.BOOST_N:
    case T.BOOST_N_2:
      boostArrow(rotated(pen, 1), id === T.BOOST_N_2);
      return;
    case T.BOOST_E:
    case T.BOOST_E_2:
      boostArrow(pen, id === T.BOOST_E_2);
      return;
    case T.WALL:
      pen.rect(0, 0, CELL, CELL, 0x6e4636);

      for (let y = 0; y < CELL; y += 8) {
        pen.rect(0, y, CELL, 1, 0x4a2c20);

        for (let x = y % 16 === 0 ? 0 : 8; x < CELL; x += 16) {
          pen.rect(x, y, 1, 8, 0x4a2c20);
        }
      }

      return;
    case T.ROOF:
      pen.rect(0, 0, CELL, CELL, 0x3f444e);
      pen.speckle(random, 40, 0x525864, 0.7);
      pen.rect(0, 0, CELL, 1, 0x2c3038);
      pen.rect(0, 0, 1, CELL, 0x2c3038);
      return;
    case T.SLAB:
      pen.rect(0, 0, CELL, CELL, 0x8a8d93);
      pen.speckle(random, 40, 0x9ea1a7, 0.7);
      pen.rect(0, 0, CELL, 1, 0x6c6f75);
      pen.rect(0, 0, 1, CELL, 0x6c6f75);
      return;
    case T.RAILING:
      pen.rect(0, 0, CELL, CELL, 0x8a8d93);
      pen.rect(4, 4, CELL - 8, CELL - 8, 0x202020);

      for (let i = 0; i < CELL * 2; i += 8) {
        for (let k = 0; k < 4; k += 1) {
          for (let y = 4; y < CELL - 4; y += 1) {
            const x = i + k - y;

            if (x >= 4 && x < CELL - 4) {
              pen.set(x, y, 0xf0c020);
            }
          }
        }
      }

      return;
    case T.RAMP_E:
      ramp(pen, random);
      return;
    case T.RAMP_N:
      ramp(rotated(pen, 1), random);
      return;
    case T.RAMP_W:
      ramp(rotated(pen, 2), random);
      return;
    case T.RAMP_S:
      ramp(rotated(pen, 3), random);
      return;
    case T.CANAL_WALL:
      pen.rect(0, 0, CELL, CELL, 0x56616a);
      pen.speckle(random, 50, 0x6f7b84, 0.8);
      pen.rect(0, 10, CELL, 1, 0x3c454c);
      pen.rect(0, 21, CELL, 1, 0x3c454c);
      return;
    case T.FAN:
      // вентилятор на прозрачном фоне: вращает декаль, не кадры
      pen.disc(16, 16, 14, 0x2a2e34);
      pen.disc(16, 16, 12, 0x15171a);

      for (const [dx, dy] of [
        [1, 0],
        [0, 1],
        [-1, 0],
        [0, -1],
      ]) {
        for (let r = 3; r < 11; r += 1) {
          pen.disc(16 + dx * r + dy * 2, 16 + dy * r - dx * 2, 2.2, 0xa0a8b0);
        }
      }

      pen.disc(16, 16, 3, 0xd0d4d8);
      return;
    default:
      throw new Error(`generate-placeholder-art: no painter for tile ${id}`);
  }
};

const buildTileSheet = () => {
  const image = createImage(SHEET_COLUMNS * CELL, SHEET_ROWS * CELL);

  frames.forEach(([x, y, w, h], id) => {
    const pen = createPen(image, x, y, { w, h });

    drawTile(pen, id, createRandom(1000 + id));
  });

  return image;
};

// --- пропы -------------------------------------------------------------

const drawImage = (width, height, paint, seed) => {
  const image = createImage(width, height);

  paint(createPen(image, 0, 0, { w: width, h: height }), createRandom(seed));

  return image;
};

// заградительный забор стройки: белые и оранжевые полосы, столбы по краям
const fence = pen => {
  const { w, h } = pen.size;

  for (let x = 0; x < w; x += 1) {
    pen.rect(x, 2, 1, h - 4, Math.floor(x / 8) % 2 ? 0xf0f0f0 : 0xf07a1a);
  }

  pen.rect(0, 0, 4, h, 0x505050);
  pen.rect(w - 4, 0, 4, h, 0x505050);
  pen.rect(w / 2 - 2, 0, 4, h, 0x505050);
};

const fenceBroken = (pen, random) => {
  const { w, h } = pen.size;

  for (let i = 0; i < 9; i += 1) {
    const x = random() * (w - 8);
    const y = random() * (h - 3);

    pen.rect(x, y, 4 + random() * 6, 2 + random() * 2, i % 2 ? 0xf0f0f0 : 0xf07a1a, 0.9);
  }

  pen.rect(0, 0, 4, 4, 0x505050);
  pen.rect(w - 4, h - 4, 4, 4, 0x505050);
};

const crate = (pen, damage) => {
  const { w, h } = pen.size;

  pen.rect(0, 0, w, h, 0x9a6a36);
  pen.rect(0, 0, w, 3, 0x6a4420);
  pen.rect(0, h - 3, w, 3, 0x6a4420);
  pen.rect(0, 0, 3, h, 0x6a4420);
  pen.rect(w - 3, 0, 3, h, 0x6a4420);

  for (let i = 0; i < w; i += 1) {
    pen.rect(i, Math.floor((i * h) / w), 2, 2, 0x6a4420);
  }

  if (damage) {
    // трещины
    for (let i = 0; i < 14; i += 1) {
      pen.rect(6 + i, 22 - Math.floor(i / 2), 1, 2, 0x2a1a0a);
      pen.rect(26 - i, 6 + Math.floor(i / 3), 1, 2, 0x2a1a0a);
    }
  }
};

const crateBroken = (pen, random) => {
  const { w, h } = pen.size;

  for (let i = 0; i < 10; i += 1) {
    const horizontal = random() < 0.5;
    const length = 8 + random() * 10;

    pen.rect(
      random() * (w - 4),
      random() * (h - 4),
      horizontal ? length : 3,
      horizontal ? 3 : length,
      i % 3 ? 0x9a6a36 : 0x6a4420,
      0.95,
    );
  }
};

// бочка сверху: красный круг с кольцами и крышкой
const barrel = pen => {
  const { w } = pen.size;
  const c = w / 2;

  pen.disc(c, c, c - 0.5, 0x6a1010);
  pen.disc(c, c, c - 2, 0xc02020);
  pen.disc(c, c, c - 5, 0x8a1818);
  pen.disc(c, c, c - 6, 0xc02020);
  pen.disc(c - 3, c - 3, 2, 0xe0e0e0);
  pen.rect(c - 1, c - 6, 2, 12, 0xf0d020);
  pen.rect(c - 6, c - 1, 12, 2, 0xf0d020);
};

const outputs = {
  'city.png': buildTileSheet(),
  'prop_fence.png': drawImage(64, 12, fence, 1),
  'prop_fence_broken.png': drawImage(64, 12, fenceBroken, 2),
  'prop_crate.png': drawImage(32, 32, pen => crate(pen, false), 3),
  'prop_crate_damaged.png': drawImage(32, 32, pen => crate(pen, true), 4),
  'prop_crate_broken.png': drawImage(32, 32, crateBroken, 5),
  'prop_barrel.png': drawImage(24, 24, barrel, 6),
};

for (const [name, image] of Object.entries(outputs)) {
  writeFileSync(`${outDir}${name}`, encodePng(image));
  console.log(`placeholder art: assets/img/${name} (${image.width} × ${image.height})`);
}
