import { describe, it, expect, vi } from 'vitest';
import clientPlugin from '../../src/client/index.js';

// ClientPlugin танков: хуки игровых методов клиентского ядра
// (движок main.js зовёт их, не зная set_model/sync_panel/try_fire).

// имена методов ядра — snake_case ABI (ключи строками из-за ESLint camelcase)
const makeCore = (spawn = null) => ({
  'set_model': vi.fn(),
  'sync_panel': vi.fn(),
  'try_fire': vi.fn(() => spawn),
  'cycle_weapon': vi.fn(),
});

describe('ClientPlugin.hooks', () => {
  it('onAuth передаёт модель в ядро', () => {
    const core = makeCore();

    clientPlugin.hooks.onAuth(core, { name: 'P1', model: 'm1' });

    expect(core.set_model).toHaveBeenCalledWith('m1');
  });

  it('onPanel зеркалит кадр панели JSON-строкой', () => {
    const core = makeCore();

    clientPlugin.hooks.onPanel(core, ['t:100', 'w1:200']);

    expect(core.sync_panel).toHaveBeenCalledWith(
      JSON.stringify(['t:100', 'w1:200']),
    );
  });

  it('onLocalAction: fire → try_fire, возвращает JSON спавна', () => {
    const core = makeCore('{"w1":{}}');

    const spawn = clientPlugin.hooks.onLocalAction(core, 'down', 'fire', 16);

    expect(core.try_fire).toHaveBeenCalledWith(16);
    expect(spawn).toBe('{"w1":{}}');
  });

  it('onLocalAction: смена оружия → cycle_weapon с направлением', () => {
    const core = makeCore();

    clientPlugin.hooks.onLocalAction(core, 'down', 'nextWeapon', 16);
    expect(core.cycle_weapon).toHaveBeenLastCalledWith(false);

    clientPlugin.hooks.onLocalAction(core, 'down', 'prevWeapon', 17);
    expect(core.cycle_weapon).toHaveBeenLastCalledWith(true);
  });

  it('onLocalAction игнорирует keyUp и прочие клавиши', () => {
    const core = makeCore('{"w1":{}}');

    expect(clientPlugin.hooks.onLocalAction(core, 'up', 'fire', 16)).toBeNull();
    expect(
      clientPlugin.hooks.onLocalAction(core, 'down', 'forward', 16),
    ).toBeNull();
    expect(core.try_fire).toHaveBeenCalledTimes(0);
    expect(core.cycle_weapon).toHaveBeenCalledTimes(0);
  });
});

// Сервисы игры для её же партов: движок их не описывает, только раздаёт
// тем, кто объявил их в componentDependencies (src/config/client.js)
describe('ClientPlugin.hooks.services', () => {
  it('отдаёт levelView — где и на каком уровне локальный игрок', () => {
    const services = clientPlugin.hooks.services(makeCore());

    expect(services.levelView).toBeDefined();
    expect(services.levelView.level).toBe(0);

    services.levelView.set(1, 320, 640);

    expect(services.levelView.level).toBe(1);
    expect(services.levelView.x).toBe(320);
    expect(services.levelView.y).toBe(640);
  });
});
