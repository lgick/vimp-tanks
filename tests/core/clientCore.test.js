import { describe, it, expect } from 'vitest';
import hostDefaults from 'vimp-engine/config/hostDefaults.js';
import tanksGameConfig from '../../src/config/game.js';
import { readFileSync } from 'node:fs';
import {
  M1_Z,
  M1_LEVEL,
  M1_VZ,
  M1_PITCH,
  M1_ROLL,
  C_STATE,
} from '../../src/client/snapshotFields.js';
import {
  coreAvailable,
  makeCore,
  makeClientCore,
  frameBuffer,
  decodeFrame,
  stepTicks,
} from './helpers.js';

// JS↔WASM харнесс клиентского ядра (ClientCore, срез 2.6): кадры реального
// GameCore проходят через push_frame → sample → hot-буфер/take_frames.
// Распаковка проверяется decode_frame (замена unpackFrame — pack и unpack
// живут в одном crate, расхождение форматов исключено по построению).

const TIME_STEP_MS = hostDefaults.timers.timeStep;
const DT = TIME_STEP_MS / 1000;

// флаги hot-буфера (зеркало games/tanks/core/src/client/mod.rs)
const HAS_GAME = 1;
const HAS_CAMERA = 2;
const HAS_PREDICTED = 4;
const HAS_FRAMES = 8;

// слоёная карта-фикстура (2.5D): та же, что в core.test.js
const layeredMap = readFileSync(
  new URL('./fixtures/layered.json', import.meta.url),
  'utf8',
);

const push = (client, buffer, localNow) =>
  client.push_frame(new Uint8Array(buffer), localNow);

// кадр ядра: pack_body + pack_frame → ArrayBuffer
const packFrame = (core, serverTime, seq, { camera = null, playerId = -1 } = {}) => {
  core.pack_body();
  core.pack_frame(
    serverTime,
    seq,
    camera !== null,
    camera ? camera[0] : 0,
    camera ? camera[1] : 0,
    camera ? Boolean(camera[2]) : false,
    camera && camera[3] ? String(camera[3]) : undefined,
    playerId,
  );

  return frameBuffer(core);
};

describe.skipIf(!coreAvailable)('ClientCore (клиентское ядро)', () => {
  describe('decode_frame — распаковка кадра v5', () => {
    it('распаковывает заголовок пустого кадра', () => {
      const core = makeCore();
      const client = makeClientCore();
      const decoded = decodeFrame(client, packFrame(core, 1234.5, 42));

      expect(decoded.port).toBe(5);
      expect(decoded.seq).toBe(42);
      expect(decoded.serverTime).toBe(1234.5);
      expect(decoded.camera).toBe(0);
      expect(decoded.player).toBeNull();
      expect(decoded.snapshot).toEqual({});
    });

    it('отбрасывает кадр с чужой версией формата', () => {
      const core = makeCore();
      const client = makeClientCore();
      const bytes = new Uint8Array(packFrame(core, 0, 1));

      bytes[1] = 99;
      expect(JSON.parse(client.decode_frame(bytes))).toBeNull();
    });

    it('распаковывает камеру с forceReset и shake', () => {
      const core = makeCore();
      const client = makeClientCore();
      const decoded = decodeFrame(
        client,
        packFrame(core, 0, 1, { camera: [10.5, -3.25, true, '20:200'] }),
      );

      expect(decoded.camera).toEqual([10.5, -3.25, true, '20:200']);
    });

    it('распаковывает player-блок без округления', () => {
      const core = makeCore();
      const client = makeClientCore();

      core.spawn_actor(1, 'm1', 1, 100.123, 200.456, 0);

      const decoded = decodeFrame(client, packFrame(core, 0, 1, { playerId: 1 }));

      expect(decoded.player.gameId).toBe(1);
      expect(decoded.player.state).toHaveLength(8);
      expect(decoded.player.centering).toBe(false);
      // Float32-точность без округления до 2 знаков
      expect(decoded.player.state[0]).toBeCloseTo(100.123, 3);
    });

    it('распаковывает танк (round2) и null-маркер удаления', () => {
      const core = makeCore();
      const client = makeClientCore();

      core.spawn_actor(2, 'm1', 1, 100.567, 50, 0);
      stepTicks(core, 1); // кэш строк снапшота обновляется на тике

      let decoded = decodeFrame(client, packFrame(core, 0, 1));
      const row = decoded.snapshot.m1['2'];

      expect(row).toHaveLength(16);
      expect(row[0]).toBe(100.57); // round2
      expect(row.slice(7, 10)).toEqual([3, 2, 1]); // condition, size, teamId
      expect(row[10]).toBe(0); // angvel — стоящий танк не крутится
      expect(row.slice(11, 13)).toEqual([0, 0]); // z, level — карты нет

      core.remove_actor(2);
      decoded = decodeFrame(client, packFrame(core, 0, 2));
      expect(decoded.snapshot.m1['2']).toBeNull();
    });

    it('распаковывает трассер с wasHit, shooterId и уровнями', () => {
      const core = makeCore();
      const client = makeClientCore();

      core.spawn_actor(1, 'm1', 1, 100, 100, 0);
      core.apply_input(1, 1, 'down', 'fire');
      stepTicks(core, 1);

      const decoded = decodeFrame(client, packFrame(core, 0, 1));
      const tracer = decoded.snapshot.w1[0];

      expect(tracer).toHaveLength(10);
      expect(tracer[6]).toBe(0); // wasHit (u8 по wire-формату, промах)
      expect(tracer[7]).toBe(1); // shooterId
      expect(tracer.slice(8, 10)).toEqual([0, 0]); // startLevel/endLevel
    });
  });

  describe('интерполяция e2e', () => {
    // два кадра ядра со сдвигом танка: интерполированная позиция между ними
    const makeFrames = () => {
      const core = makeCore();

      core.spawn_actor(1, 'm1', 1, 100, 100, 0);
      core.apply_input(1, 1, 'down', 'forward');
      stepTicks(core, 60);

      const f1 = packFrame(core, 1000, 1, { camera: [1, 2] });
      const x1 = decodeFrame(makeClientCore(), f1).snapshot.m1['1'][0];

      stepTicks(core, 12); // ~100 мс

      const f2 = packFrame(core, 1100, 2, { camera: [3, 4] });
      const x2 = decodeFrame(makeClientCore(), f2).snapshot.m1['1'][0];

      return { f1, f2, x1, x2 };
    };

    it('hot-буфер: интерполированный танк и камера между кадрами', () => {
      const { f1, f2, x1, x2 } = makeFrames();
      const client = makeClientCore();

      expect(Number.isNaN(client.offset())).toBe(true);

      expect(push(client, f1, 1000)).toBe(true);
      expect(push(client, f2, 1100)).toBe(true);
      expect(client.offset()).toBeCloseTo(0, 6);

      // renderTime = 1150 − delay(100) = 1050 → alpha 0.5
      const len = client.sample(1150);
      const hot = client.hot_values();

      expect(len).toBe(hot.length);

      const flags = hot[0];

      expect(flags & HAS_GAME).toBeTruthy();
      expect(flags & HAS_CAMERA).toBeTruthy();
      expect(flags & HAS_FRAMES).toBeTruthy();
      expect(flags & HAS_PREDICTED).toBeFalsy();

      // камера интерполирована между [1,2] и [3,4]
      expect(hot[1]).toBeCloseTo(2, 5);
      expect(hot[2]).toBeCloseTo(3, 5);

      // один танк: keyId m1 (1), gameId 1, x между кадрами
      expect(hot[3]).toBe(1);
      expect(hot[4]).toBe(1);
      expect(hot[5]).toBe(1);
      expect(hot[6]).toBeCloseTo((x1 + x2) / 2, 1);
      expect(x2).toBeGreaterThan(x1);
    });

    it('событийные кадры выдаются ровно один раз', () => {
      const { f1, f2 } = makeFrames();
      const client = makeClientCore();

      push(client, f1, 1000);
      push(client, f2, 1100);
      client.sample(1150);

      const frames = JSON.parse(client.take_frames());

      expect(frames).toHaveLength(1); // пересечён только seq 1
      expect(frames[0].game.m1['1'][0]).toBeGreaterThan(100);
      expect(frames[0].camera).toEqual([1, 2]);

      client.sample(1151);
      expect(JSON.parse(client.take_frames())).toEqual([]);
    });

    it('реордер и дубликаты seq не ломают буфер', () => {
      const { f1, f2, x1, x2 } = makeFrames();
      const client = makeClientCore();

      // кадры в обратном порядке + дубликат
      push(client, f2, 1100);
      push(client, f1, 1000);
      push(client, f1, 1000);

      client.sample(1150);

      const hot = client.hot_values();

      expect(hot[6]).toBeCloseTo((x1 + x2) / 2, 1);
      expect(JSON.parse(client.take_frames())).toHaveLength(1);
    });
  });

  describe('предикт e2e', () => {
    // ядро + клиент с общим стартовым кадром (player-блок id 1)
    const setup = () => {
      const core = makeCore();
      const client = makeClientCore();

      core.spawn_actor(1, 'm1', 1, 100, 100, 0);
      stepTicks(core, 1); // кэш строк снапшота обновляется на тике
      client.set_model('m1');
      client.set_active(true);

      const f1 = packFrame(core, 1000, 1, { camera: [100, 100], playerId: 1 });

      push(client, f1, 1000);
      client.sample(1150); // кадр пересечён: meta своего танка получена

      return { core, client };
    };

    it('player-блок включает предикт, ввод двигает предсказанный танк', () => {
      const { client } = setup();

      expect(client.my_game_id()).toBe(1);

      let hot = client.hot_values();

      expect(hot[0] & HAS_PREDICTED).toBeTruthy();

      // predicted-запись последняя (18 f32: keyId, gameId + 16 полей m1),
      // x — третье поле записи
      expect(hot[hot.length - 16]).toBeCloseTo(100, 3);

      client.apply_input('down', 'forward', 1150);

      for (let i = 1; i <= 60; i += 1) {
        client.sample(1150 + i * TIME_STEP_MS);
      }

      hot = client.hot_values();

      const x = hot[hot.length - 16];

      expect(x).toBeGreaterThan(105);

      // камера следует предсказанной позиции
      expect(hot[1]).toBeCloseTo(x, 3);
    });

    it('после CLEAR predicted-хвоста в hot-буфере нет', () => {
      const { client } = setup();

      expect(client.hot_values()[0] & HAS_PREDICTED).toBeTruthy();

      // полный CLEAR: мира больше нет — предикт не должен пересоздавать
      // сущность на полотне (баг «призрака» после смены карты)
      client.reset();
      client.sample(1200);

      // (обнуление my_game_id — движковая половина того же фикса, она
      // проверяется cargo-тестом крейта)
      expect(client.hot_values()[0] & HAS_PREDICTED).toBeFalsy();
    });

    it('реплика движения сходится с ядром на реальном конфиге', () => {
      const { core, client } = setup();

      core.apply_input(1, 2, 'down', 'forward');
      client.apply_input('down', 'forward', 1150);

      for (let i = 1; i <= 120; i += 1) {
        core.step(DT);
        client.sample(1150 + i * TIME_STEP_MS);
      }

      const [coreX] = core.position_of(1);
      const hot = client.hot_values();
      const predictedX = hot[hot.length - 16];

      // допуск шире cargo-паритета: рендер-тик клиента дробит время
      // аккумулятором (float-режим реального цикла)
      expect(Math.abs(predictedX - coreX)).toBeLessThan(5);
      expect(predictedX).toBeGreaterThan(150);
    });
  });

  describe('try_fire и подавление дублей', () => {
    const setup = () => {
      const core = makeCore();
      const client = makeClientCore();

      core.spawn_actor(1, 'm1', 1, 100, 100, 0);
      stepTicks(core, 1);
      client.set_model('m1');
      client.set_active(true);
      push(client, packFrame(core, 1000, 1, { playerId: 1 }), 1000);
      client.sample(1150);
      client.take_frames(); // очередь событийных кадров выкачивается тиком

      return { core, client };
    };

    it('возвращает трассер в формате снапшота', () => {
      const { client } = setup();
      const spawn = JSON.parse(client.try_fire(1200));

      expect(spawn.w1).toHaveLength(1);

      const tracer = spawn.w1[0];

      expect(tracer).toHaveLength(10);
      expect(tracer[7]).toBe(1); // shooterId
      expect(tracer[6]).toBe(false); // мир пуст — промах
      // 2.5D-хвост: одноуровневая карта — оба уровня нулевые
      expect(tracer[8]).toBe(0);
      expect(tracer[9]).toBe(0);
    });

    it('не стреляет без предикта или мёртвым танком', () => {
      const core = makeCore();
      const client = makeClientCore();

      // нет модели/кадров
      expect(client.try_fire(0)).toBeUndefined();

      core.spawn_actor(1, 'm1', 1, 100, 100, 0);
      stepTicks(core, 1);
      client.set_model('m1');
      client.set_active(true);
      push(client, packFrame(core, 1000, 1, { playerId: 1 }), 1000);
      client.sample(1150);
      expect(client.try_fire(1200)).toBeTruthy();
    });

    it('авторитетный дубль своего трассера подавляется', () => {
      const { core, client } = setup();

      // локальный выстрел → pending-запись
      expect(client.try_fire(1200)).toBeTruthy();

      // авторитетный дубль от ядра
      core.apply_input(1, 2, 'down', 'fire');
      stepTicks(core, 1);
      push(client, packFrame(core, 1200, 2, { playerId: 1 }), 1200);
      client.sample(1350);

      const frames = JSON.parse(client.take_frames());

      expect(frames).toHaveLength(1);
      expect(frames[0].game.w1).toEqual([]); // свой дубль вычищен
    });

  });

  describe('поверхности (surface_at / surface_types / surface_dir_at)', () => {
    // слоёная фикстура + разметка: на земле тайл 5 (строка 3, колонка 2) —
    // песок, тайл 6 (строка 3, колонка 5) — конвейер на север; вся плита
    // моста уровня 1 (тайл 2) — бустер на восток. step 32, scale 1
    const surfacedMap = () => {
      const map = JSON.parse(layeredMap);

      map.map[3][2] = 5;
      map.map[3][5] = 6;
      map.game = {
        surfaces: {
          0: { 5: 'sand', 6: { type: 'conveyor', dir: 'north' } },
          1: { 2: { type: 'boost', dir: 'east' } },
        },
      };

      return JSON.stringify(map);
    };

    const nameAt = (client, x, y, level) => {
      const index = client.surface_at(x, y, level);

      return index < 0 ? null : JSON.parse(client.surface_types())[index];
    };

    it('без карты — -1', () => {
      const client = makeClientCore();

      expect(client.surface_at(80, 112, 0)).toBe(-1);
      expect(client.surface_dir_at(80, 112, 0)).toBe(-1);
    });

    it('типы в порядке индексов из coreParams.surfaces', () => {
      const client = makeClientCore();

      expect(JSON.parse(client.surface_types())).toEqual(
        Object.keys(tanksGameConfig.coreParams.surfaces.types).sort(),
      );
    });

    it('surface_at отдаёт тип клетки по уровням', () => {
      const client = makeClientCore();

      client.set_map(surfacedMap());

      expect(nameAt(client, 80, 112, 0)).toBe('sand');
      expect(nameAt(client, 176, 112, 0)).toBe('conveyor');
      expect(nameAt(client, 368, 272, 1)).toBe('boost');
      // под плитой на земле и соседняя клетка — нейтрально
      expect(client.surface_at(368, 272, 0)).toBe(-1);
      expect(client.surface_at(112, 112, 0)).toBe(-1);
    });

    it('surface_dir_at: стрелка у конвейера и бустера, -1 у ненаправленных', () => {
      const client = makeClientCore();

      client.set_map(surfacedMap());

      expect(client.surface_dir_at(176, 112, 0)).toBe(0); // north
      expect(client.surface_dir_at(368, 272, 1)).toBe(3); // east
      expect(client.surface_dir_at(80, 112, 0)).toBe(-1);
      expect(client.surface_dir_at(112, 112, 0)).toBe(-1);
    });

    it('карта без game.surfaces — -1', () => {
      const client = makeClientCore();

      client.set_map(layeredMap);

      expect(client.surface_at(80, 112, 0)).toBe(-1);
    });
  });

  describe('разрушаемые пропы (байт state строки c1)', () => {
    // слоёная фикстура + забор на земле по курсу танка: угол объекта
    // (200, 84), 32×32 → центр (216, 100)
    const fenceMap = () => {
      const map = JSON.parse(layeredMap);

      map.physicsDynamic = [
        {
          position: [200, 84],
          angle: 0,
          width: 32,
          height: 32,
          density: 100,
          linearDamping: 3,
          angularDamping: 3,
          game: { prop: 'fence' },
        },
      ];

      return JSON.stringify(map);
    };

    // ядро с забором и танком (gameId 1), стреляющим по нему, пока забор
    // не сломается
    const breakFence = () => {
      const core = makeCore();

      core.load_map(fenceMap());
      core.spawn_actor(1, 'm1', 1, 100, 100, 0);
      stepTicks(core, 1);

      const before = packFrame(core, 1000, 1);

      for (let seq = 1; seq <= 20; seq += 1) {
        core.apply_input(1, seq, 'down', 'fire');
        stepTicks(core, 30);
      }

      return { core, before };
    };

    // строки динамики карты из hot-буфера: [flags, camX, camY, число
    // танков, (keyId, gameId, поля m1)…, число тел, (keyId, index, поля)…].
    // Камера пишется всегда — без флага HAS_CAMERA нулями
    const hotBodies = (hot, bodyWidth) => {
      let offset = 3;

      const tanks = hot[offset];

      offset += 1 + tanks * (2 + tanksGameConfig.snapshot.m1.fields.length);

      const count = hot[offset];
      const rows = [];

      offset += 1;

      for (let i = 0; i < count; i += 1) {
        rows.push(hot.slice(offset, offset + 2 + bodyWidth));
        offset += 2 + bodyWidth;
      }

      return rows;
    };

    it('кадр с разрушенным телом декодируется со state = 2', () => {
      const { core, before } = breakFence();
      const client = makeClientCore();

      // строки динамики карты декодер ключует `d{index}`
      expect(decodeFrame(client, before).snapshot.c1.d0[C_STATE]).toBe(0);

      const after = packFrame(core, 2000, 2);

      expect(decodeFrame(client, after).snapshot.c1.d0[C_STATE]).toBe(2);
    });

    it('строки тел в hot-буфере несут state', () => {
      const { core } = breakFence();
      const client = makeClientCore();

      push(client, packFrame(core, 1000, 1), 1000);
      stepTicks(core, 12);
      push(client, packFrame(core, 1100, 2), 1100);
      client.sample(1150);

      const bodyWidth = tanksGameConfig.snapshot.c1.fields.length;
      const rows = hotBodies(client.hot_values(), bodyWidth);

      expect(rows).toHaveLength(1);
      // [keyId, index, ...поля]: поле state — на своей позиции схемы
      expect(rows[0][1]).toBe(0);
      expect(rows[0][2 + C_STATE]).toBe(2);
    });
  });

  describe('слоёная карта', () => {
    // 2.5D: клиент предсказывает уровень своего танка по той же слоёной
    // карте, что и хост, и режет луч теми же сегментами
    it('на слоёной карте трассер с моста падает за кромкой плиты', () => {
      const core = makeCore();
      const client = makeClientCore();

      core.load_map(layeredMap);
      client.set_map(layeredMap);

      // плита моста: колонки 10..12 (x 320..416), строки 5..14 (y 160..480)
      core.spawn_actor(1, 'm1', 1, 352, 300, 0);
      stepTicks(core, 1);
      client.set_model('m1');
      client.set_active(true);
      push(client, packFrame(core, 1000, 1, { playerId: 1 }), 1000);
      client.sample(1150);
      client.take_frames();

      // предсказанный хвост своей строки: z, уровень и хвост наклона
      // (16 полей схемы m1 после keyId/gameId)
      const hot = client.hot_values();
      const row = hot.slice(hot.length - 16);

      expect(row[M1_LEVEL]).toBe(1);
      expect(row[M1_Z]).toBe(1);
      expect(row[M1_VZ]).toBe(0);
      expect(row[M1_PITCH]).toBe(0);
      expect(row[M1_ROLL]).toBe(0);

      const tracer = JSON.parse(client.try_fire(1200)).w1[0];

      // ствол смотрит на восток: кромка плиты на x = 416
      expect(tracer[8]).toBe(1); // startLevel — мост
      expect(tracer[9]).toBe(0); // endLevel — луч упал на землю
    });
  });
});
