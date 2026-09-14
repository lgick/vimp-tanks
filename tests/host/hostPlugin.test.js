import { describe, it, expect, vi } from 'vitest';
import hostPlugin from '../../src/host/index.js';

// HostPlugin танков — статическая сборка игровой половины хоста (этап 3);
// фиксируем поверхность, которую дергает движок (HostGame/host.worker).

describe('HostPlugin танков: поверхность', () => {
  it('несёт id и игровой конфиг', () => {
    expect(hostPlugin.id).toBe('tanks');
    expect(hostPlugin.gameConfig.teams).toBeDefined();
    expect(hostPlugin.gameConfig.panel.activeKey).toBe('wa');
    expect(hostPlugin.gameConfig.scripted).toEqual({
      namePrefix: 'Bot',
      defaultModel: 'm1',
    });
    expect(hostPlugin.gameConfig.roomDefaults.maxPlayers).toBe(8);
  });

  it('authSchema: params + игровые валидаторы', () => {
    expect(Array.isArray(hostPlugin.authSchema.params)).toBe(true);
    expect(hostPlugin.authSchema.validators.isValidModel('m1')).toBe(true);
  });

  it('chatCommands регистрируемы (пары name/handler)', () => {
    for (const command of hostPlugin.chatCommands) {
      expect(command.name.startsWith('/')).toBe(true);
      expect(typeof command.handler).toBe('function');
    }

    const names = hostPlugin.chatCommands.map(c => c.name);

    // движок своих команд не разбирает — весь набор объявляет игра
    expect(names).toContain('/bot');
    expect(names).toEqual(
      expect.arrayContaining(['/name', '/nr', '/timeleft', '/mapname', '/rank']),
    );
    expect(new Set(names).size).toBe(names.length);
  });

  it('systemMessages — игровая группа кодов b:*', () => {
    for (const code of Object.values(hostPlugin.systemMessages)) {
      expect(code.startsWith('b:')).toBe(true);
    }
  });

  it('onCoreEvent: mapDerivedError уходит в console.warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const services = {};

    hostPlugin.onCoreEvent(
      { type: 'mapDerivedError', message: 'surfaces: invalid type' },
      services,
    );

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('surfaces: invalid type');

    warn.mockRestore();
  });

  it('onCoreEvent: прочие custom-события игнорируются', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    hostPlugin.onCoreEvent({ type: 'other' }, {});

    expect(warn).not.toHaveBeenCalled();

    warn.mockRestore();
  });

  it('объявляет возможности движка для полей game и state карты', () => {
    expect(hostPlugin.requires).toEqual([
      'map.layers',
      'map.levelsN',
      'map.gameData',
      'map.bodyState',
    ]);
  });

  it('createModules возвращает scripted-модуль с контрактом движка', () => {
    const ctx = {
      participants: {},
      coreAdapter: { removePlayer: vi.fn() },
      panel: {},
      stat: {},
      scripted: hostPlugin.gameConfig.scripted,
    };
    const { scripted } = hostPlugin.createModules(ctx);

    for (const method of [
      'createMap',
      'createScripted',
      'removeScripted',
      'removeOneForHuman',
      'getCount',
      'getCountsPerTeam',
    ]) {
      expect(typeof scripted[method]).toBe('function');
    }
  });

  it('buildClientGameConfig отдаёт игровую половину CONFIG_DATA', () => {
    const clientConfig = hostPlugin.buildClientGameConfig();

    expect(clientConfig.parts.gameSets).toBeDefined();
    expect(clientConfig.modules.panel.keys).toBeDefined();
    expect(clientConfig.modules.stat.params.columns).toHaveLength(5);
    expect(clientConfig.initIdList).toContain('vimp');
  });
});
