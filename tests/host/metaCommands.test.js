import { describe, it, expect, vi } from 'vitest';
import {
  mapNameCommand,
  nameCommand,
  newRoundCommand,
  rankCommand,
  timeLeftCommand,
} from '../../src/host/metaCommands.js';

// Бывшие движковые команды: движок их больше не разбирает, набор объявляет
// игра (src/host/index.js -> chatCommands).
const makeCtx = (overrides = {}) => ({
  chat: { pushSystem: vi.fn(), pushSystemByUser: vi.fn() },
  roundManager: {
    changeName: vi.fn(),
    initiateNewRound: vi.fn(),
    currentMap: 'pool mini',
  },
  timerManager: { getMapTimeLeft: vi.fn(() => 65000) },
  playerDataSync: { getRank: vi.fn(() => 12) },
  isDevMode: false,
  ...overrides,
});

describe('metaCommands', () => {
  it('/name отдаёт весь остаток строки движку', () => {
    const ctx = makeCtx();

    nameCommand.handler(ctx, 'u', ['New', 'Name']);

    expect(ctx.roundManager.changeName).toHaveBeenCalledWith('u', 'New Name');
  });

  it('/nr перезапускает раунд только в dev-режиме', () => {
    const dev = makeCtx({ isDevMode: true });
    const prod = makeCtx();

    newRoundCommand.handler(dev, 'u', []);
    newRoundCommand.handler(prod, 'u', []);

    expect(dev.roundManager.initiateNewRound).toHaveBeenCalled();
    expect(prod.roundManager.initiateNewRound).not.toHaveBeenCalled();
    expect(prod.chat.pushSystemByUser).toHaveBeenCalledWith(
      'u',
      'COMMANDS_NOT_FOUND',
    );
  });

  it('/timeleft форматирует остаток времени карты как mm:ss', () => {
    const ctx = makeCtx();

    timeLeftCommand.handler(ctx, 'u', []);

    expect(ctx.chat.pushSystemByUser).toHaveBeenCalledWith('u', ['01:05']);
  });

  it('/mapname отдаёт текущую карту', () => {
    const ctx = makeCtx();

    mapNameCommand.handler(ctx, 'u', []);

    expect(ctx.chat.pushSystemByUser).toHaveBeenCalledWith('u', ['pool mini']);
  });

  it('/rank отвечает лично игроку движковым кодом', () => {
    const ctx = makeCtx();

    rankCommand.handler(ctx, 'u', []);

    expect(ctx.playerDataSync.getRank).toHaveBeenCalledWith('u');
    expect(ctx.chat.pushSystemByUser).toHaveBeenCalledWith('u', 'RANK', [12]);
  });
});
