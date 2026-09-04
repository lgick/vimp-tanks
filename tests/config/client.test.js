import { describe, it, expect } from 'vitest';
import clientConfig from '../../src/config/client.js';

// componentDependencies: движок раздаёт сервис только тем партам, которые
// названы здесь. Пропуск имени не ломает сборку — парт молча получает
// undefined, поэтому связка «сервис → парт» закреплена тестом.
describe('clientConfig.componentDependencies (src/config/client.js)', () => {
  const deps = clientConfig.parts.componentDependencies;

  // писатель один (свой Tank), читателей много: по одной и той же формуле
  // levelView.alphaFor гаснет всё, что оказалось НАД игроком
  it('levelView объявлен для Tank (пишет) и всех читателей see-through', () => {
    expect(deps.levelView).toEqual([
      'Tank',
      'Map',
      'MapVolume',
      'MapRadar',
      'Smoke',
      'Bomb',
      'ShotEffect',
      'ExplosionEffect',
    ]);
  });

  // парт, не названный в gameSets и entitiesOnCanvas, просто не будет
  // создан — и ни одной ошибки при этом не появится
  it('MapVolume зарегистрирован в обоих наборах карты и на полотне vimp', () => {
    expect(clientConfig.parts.gameSets.c1).toContain('MapVolume');
    expect(clientConfig.parts.gameSets.c2).toContain('MapVolume');
    expect(clientConfig.parts.entitiesOnCanvas.MapVolume).toBe('vimp');
    expect(deps.renderer).toContain('MapVolume');
    expect(deps.assetsBase).toContain('MapVolume');
  });

  // тень и бейдж уровня — запечённые ассеты танка: без регистрации парт
  // получил бы undefined и молча остался бы без признаков высоты
  it('Tank получает тень и бейдж уровня среди запечённых ассетов', () => {
    const names = clientConfig.parts.bakedAssets.vimp
      .filter(asset => asset.component === 'Tank')
      .map(asset => asset.name);

    expect(names).toContain('tankShadowTexture');
    expect(names).toContain('levelBadgeTexture');
  });

  // режимы see-through и объёма читает клиентский код (src/config/render.js);
  // здесь они лежат как часть клиентского конфига игры
  it('parts несёт настройки see-through и объёма', () => {
    expect(clientConfig.parts.seeThrough.mode).toBe('hole');
    expect(clientConfig.parts.volume.enabled).toBe(true);
  });

  it('localPlayer объявлен для Tank: только свой танк пишет в levelView', () => {
    expect(deps.localPlayer).toEqual(['Tank']);
  });
});
