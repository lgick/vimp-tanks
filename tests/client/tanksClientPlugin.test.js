import { describe, it, expect, vi } from 'vitest';

// шпион на фабрику освещения: тест связки сервисов смотрит, ЧТО ей
// передал hooks.services. Поведение фабрики — настоящее
vi.mock('../../src/client/lighting/createLighting.js', async importOriginal => {
  const actual = await importOriginal();

  return { ...actual, createLighting: vi.fn(actual.createLighting) };
});

import clientPlugin from '../../src/client/index.js';
import { createLighting } from '../../src/client/lighting/createLighting.js';

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

  it('освещение получает те же levelView и volumes, что и части', () => {
    const services = clientPlugin.hooks.services(makeCore());
    const [, deps] = createLighting.mock.calls.at(-1);

    // один реестр на свет и выстрел: иначе фары светят сквозь стены,
    // в которые попадает выстрел (src/client/volumes.js)
    expect(deps.volumes).toBe(services.volumes);
    expect(deps.levelView).toBe(services.levelView);
    expect(createLighting.mock.results.at(-1).value).toBe(services.lighting);
  });
});

describe('ClientPlugin: сервис surfaces', () => {
  it('serviceNames содержит surfaces', () => {
    expect(clientPlugin.serviceNames).toContain('surfaces');
  });

  const makeSurfaceCore = () => ({
    'map_generation': vi.fn(() => 1),
    'surface_types': vi.fn(() => '["boost","sand"]'),
    'surface_at': vi.fn((x) => (x < 0 ? -1 : Math.floor(x))),
    'surface_dir_at': vi.fn((x) => (x < 0 ? -1 : 3)),
  });

  it('kindAt переводит индекс ядра в имя, -1 — в null', () => {
    const core = makeSurfaceCore();
    const { surfaces } = clientPlugin.hooks.services(core);

    expect(surfaces.kindAt(0, 0, 0)).toBe('boost');
    expect(surfaces.kindAt(1, 5, 1)).toBe('sand');
    expect(surfaces.kindAt(-1, 0, 0)).toBe(null);
    expect(core.surface_at).toHaveBeenCalledWith(1, 5, 1);
  });

  it('имена типов кешируются до смены карты', () => {
    const core = makeSurfaceCore();
    const { surfaces } = clientPlugin.hooks.services(core);

    surfaces.kindAt(0, 0, 0);
    surfaces.kindAt(1, 0, 0);
    expect(core.surface_types).toHaveBeenCalledTimes(1);

    core.map_generation.mockReturnValue(2);
    surfaces.kindAt(0, 0, 0);
    expect(core.surface_types).toHaveBeenCalledTimes(2);
  });

  it('dirAt переводит индекс стрелки в единичный вектор', () => {
    const core = makeSurfaceCore();
    const { surfaces } = clientPlugin.hooks.services(core);

    expect(surfaces.dirAt(0, 0, 0)).toEqual([1, 0]);
    expect(surfaces.dirAt(-1, 0, 0)).toBe(null);

    core.surface_dir_at.mockReturnValue(0);
    expect(surfaces.dirAt(0, 0, 0)).toEqual([0, -1]);
  });
});

describe('ClientPlugin: сервис rampRuns', () => {
  const runs = [
    {
      axis: 0,
      sign: 1,
      from: 0,
      to: 1,
      min: 64,
      max: 128,
      crossMin: 0,
      crossMax: 64,
      block: 0,
      railMin: 76.8,
      railMax: 128,
    },
  ];

  const makeRampCore = () => ({
    'map_generation': vi.fn(() => 1),
    'ramp_runs': vi.fn(() => JSON.stringify(runs)),
    'floor_level': vi.fn(() => 0),
  });

  it('heightAt даёт высоту склона под мировой точкой, вне рампы — null', () => {
    const { rampRuns } = clientPlugin.hooks.services(makeRampCore());

    expect(rampRuns.heightAt(0, 96, 32)).toBe(0.5);
    expect(rampRuns.heightAt(0, 40, 32)).toBe(null);
    expect(rampRuns.heightAt(2, 96, 32)).toBe(null);
  });

  it('slopeAt даёт высоту и ось склона, вне рампы — null', () => {
    const { rampRuns } = clientPlugin.hooks.services(makeRampCore());

    expect(rampRuns.slopeAt(0, 96, 32)).toEqual({ height: 0.5, axis: 0 });
    expect(rampRuns.slopeAt(0, 40, 32)).toBe(null);
  });

  it('faceAt даёт грань насыпи под концом луча', () => {
    const { rampRuns } = clientPlugin.hooks.services(makeRampCore());
    const hit = rampRuns.faceAt(0, 96, 64, 0, -1, 0.15);

    expect(hit.face).toEqual({ axis: 'y', coord: 64, nx: 0, ny: 1 });
    expect(hit.volume).toBeCloseTo(0.5);
    expect(rampRuns.faceAt(0, 96, 32, 0, -1, 0.15)).toBe(null);
  });

  it('floorAt спрашивает пол у ядра', () => {
    const core = makeRampCore();
    const { rampRuns } = clientPlugin.hooks.services(core);

    expect(rampRuns.floorAt(1, 96, 32)).toBe(0);
    expect(core.floor_level).toHaveBeenCalledWith(1, 96, 32);
  });

  it('forLevel, heightAt, slopeAt и faceAt делят один разбор до смены карты', () => {
    const core = makeRampCore();
    const { rampRuns } = clientPlugin.hooks.services(core);

    rampRuns.forLevel(0);
    rampRuns.heightAt(0, 96, 32);
    rampRuns.slopeAt(0, 96, 32);
    rampRuns.faceAt(0, 96, 64, 0, -1, 0.15);
    expect(core.ramp_runs).toHaveBeenCalledTimes(1);

    core.map_generation.mockReturnValue(2);
    rampRuns.heightAt(0, 96, 32);
    expect(core.ramp_runs).toHaveBeenCalledTimes(2);
  });
});
