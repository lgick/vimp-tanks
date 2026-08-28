import { vi } from 'vitest';
import RecordingSocketManager from 'vimp-engine/devtools/RecordingSocketManager.js';
import { offlinePlayerData } from 'vimp-engine/lib/offlinePlayerData.js';
import {
  coreAvailable,
  makeCore,
  makeClientCore,
  decodeFrame,
} from '../core/helpers.js';

// Каркас интеграционных тестов host-фасада: строит HostGame поверх
// реального Rust-ядра (pkg-node) — сквозное покрытие core-driven пути
// (GameCoreAdapter → panel/reportKill, pack_body/pack_frame; бинарные
// кадры декодирует клиентское ядро — ClientCore.decode_frame, срез 2.6).
// Пропускается, если core/pkg-node не собран (см. npm run core:build).
//
// Все игровые модули — синглтоны, поэтому тест-файлы обязаны изолироваться
// через vi.resetModules() в beforeEach и импортировать всё ДИНАМИЧЕСКИ
// внутри теста (не статическим top-level import).

export { coreAvailable };

// распаковка бинарного кадра клиентским ядром (лениво: без pkg-node
// тесты скипаются до первого вызова)
let frameDecoder = null;

export const decodeShot = buffer =>
  decodeFrame((frameDecoder ??= makeClientCore()), buffer);

// Загружает реальные конфиги в свежий синглтон config (зеркало init
// host.worker.js). Должна вызываться после vi.resetModules().
export const loadConfig = async () => {
  const config = (await import('vimp-engine/lib/config.js')).default;

  config.set('auth', (await import('../../src/config/auth.js')).default);
  config.set('wsports', (await import('vimp-engine/config/wsports.js')).default);

  // merge движок+игра — зеркало applyRoomOverrides из host.worker.js
  const hostDefaults = (await import('vimp-engine/config/hostDefaults.js'))
    .default;
  const tanksGameConfig = (await import('../../src/config/game.js')).default;

  config.set('game', { ...hostDefaults, ...tanksGameConfig });

  config.set('game:isDevMode', true);

  // кадр на каждом тике: тесты двигают цикл tick(host, 1) и ждут снапшот
  config.set('game:timers:networkSendRate', 1);

  return config;
};

// Транспорт тестов — движковый RecordingSocketManager: он наследует боевой
// SocketManager и берёт список отправителей из его прототипа, поэтому новый
// кадр движка (sendAccolades и любой следующий за ним) появляется здесь сам.
// Ручной список отправителей, стоявший тут раньше, отставал от движка молча —
// до первого `is not a function` посреди онбординга.
export class FakeSocketManager extends RecordingSocketManager {
  // последний sendShot для конкретного сокета; бинарный кадр декодируется
  // клиентским ядром в прежнюю форму [snapshot, camera, serverTime, seq]
  lastShot(socketId) {
    const frame = this.lastFrame(socketId);

    return frame
      ? [frame.snapshot, frame.camera, frame.serverTime, frame.seq]
      : null;
  }

  // последний sendShot целиком (включая player-блок предикшена)
  lastFrame(socketId) {
    const shots = this.framesOf('sendShot').filter(
      f => f.socketId === socketId,
    );

    return shots.length ? decodeShot(shots[shots.length - 1].args[0]) : null;
  }

  // алиас движкового clearFrames() — историческое имя тестов игры
  clear() {
    this.clearFrames();
  }
}

// Создаёт свежий HostGame с реальными мета-модулями, реальным ядром и
// фейковым SocketManager. Fake timers включаются ДО конструктора (тот
// стартует игровой цикл/таймеры). Ядро использует детерминированный seed.
// game — поверхностные оверрайды конфига игры (например { maxPlayers: 2 }),
// opts — опции HostGame ({ hostSocketId, onMapChange }).
export const createHost = async ({ seed = 42, game = {}, opts = {} } = {}) => {
  vi.useFakeTimers();

  const config = await loadConfig();
  const HostGame = (await import('vimp-engine/host/HostGame.js')).default;
  const hostPlugin = (await import('../../src/host/index.js')).default;
  const core = makeCore({ seed });
  const socket = new FakeSocketManager();
  const gameConfig = { ...config.get('game'), ...game };
  // мастера в тестах нет: без заглушки PlayerDataSync и Accolades уходят в
  // настоящий fetch по относительному URL и шумят отказом в каждом тесте
  const host = new HostGame(gameConfig, socket, core, hostPlugin, {
    playerDataFetch: offlinePlayerData(),
    ...opts,
  });

  return { host, socket, core, config };
};

// Ждёт микрозадачу (HostGame.createUser отвечает через queueMicrotask;
// fake timers её не подделывают).
export const flushMicro = () =>
  new Promise(resolve => queueMicrotask(resolve));

// Полный онбординг игрока до isReady=true. Возвращает gameId.
export const connectPlayer = async (
  host,
  { name = 'P1', model = 'm1', socketId = 's1' } = {},
) => {
  let gameId;

  host.createUser({ name, model }, socketId, id => {
    gameId = id;
  });

  await flushMicro();

  host.sendMap(gameId);
  host.mapReady(gameId);
  host.firstShotReady(gameId);

  return gameId;
};

// Игрок выбирает команду (становится активным).
export const joinTeam = (host, gameId, team = 'team1') => {
  host.parseVote(gameId, ['teamChange', team]);
};

// Прогоняет n тиков игрового цикла с фиксированным dt.
export const tick = (host, n = 1, dt = 1 / 120) => {
  for (let i = 0; i < n; i += 1) {
    host._onShotTick(dt);
  }
};

// Нажатие/отпускание клавиши игрока (формат wire: 'seq:down:forward').
let inputSeq = 0;

export const pressKey = (host, gameId, name, action = 'down') => {
  inputSeq += 1;
  host.updateKeys(gameId, `${inputSeq}:${action}:${name}`);
};
