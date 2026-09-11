import { describe, it, expect } from 'vitest';
import clientConfig from '../../src/config/client.js';
import clientPlugin from '../../src/client/index.js';

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
      'MapRadar',
      'Smoke',
      'Bomb',
      'ShotEffect',
      'ExplosionEffect',
      'Tracks',
      'Dust',
    ]);
  });

  // прогоны рамп из ядра: сервис доливает hooks.services(core), и его имя
  // обязаны знать ОБА списка — иначе контрактный чекер (правило C4) не
  // отличит игровой сервис от опечатки, а парт молча получит undefined и
  // перестанет рисовать клин горки
  it('rampRuns объявлен и в componentDependencies, и в serviceNames', () => {
    expect(deps.rampRuns).toEqual(['Map']);
    expect(clientPlugin.serviceNames).toContain('rampRuns');
  });

  // парт, не названный в gameSets и entitiesOnCanvas, просто не будет
  // создан — и ни одной ошибки при этом не появится. Объём слоя рисует сам
  // `Map` (этап 4): отдельного парта `MapVolume` больше нет
  it('карту рисует один парт Map, MapVolume не зарегистрирован', () => {
    expect(clientConfig.parts.gameSets.c1).toEqual(['Map', 'MapRadar']);
    expect(clientConfig.parts.gameSets.c2).toEqual(['Map']);
    expect(clientConfig.parts.entitiesOnCanvas.MapVolume).toBeUndefined();
    expect(deps.renderer).not.toContain('MapVolume');
    expect(deps.assetsBase).toEqual(['Map']);
  });

  // центр камеры парт восстанавливает по рендереру: без сервиса параллакс
  // высоты молча выключится у корпуса танка и у следов на плите
  it('renderer объявлен для всех потребителей проекции 2.5D', () => {
    expect(deps.renderer).toEqual([
      'Map',
      'Tank',
      'Tracks',
      'Smoke',
      'Dust',
      'Bomb',
      'ShotEffect',
      'ExplosionEffect',
    ]);
  });

  // тень — запечённый ассет танка: без регистрации парт получил бы undefined
  // и молча остался бы без главного признака высоты. Бейдж уровня удалён
  // (этап 5 кодревью) вместе со своим бейкером
  it('Tank получает тень среди запечённых ассетов и не просит бейдж', () => {
    const names = clientConfig.parts.bakedAssets.vimp
      .filter(asset => asset.component === 'Tank')
      .map(asset => asset.name);

    expect(names).toContain('tankShadowTexture');
    expect(names).not.toContain('levelBadgeTexture');
  });

  // тень — силуэт корпуса, а не круг (этап 5.2 кодревью): у бейкера свои
  // параметры, и пропорция обязана совпадать с полотном танка (4:3)
  it('тень запекается силуэтом корпуса', () => {
    const asset = clientConfig.parts.bakedAssets.vimp.find(
      item => item.name === 'tankShadowTexture',
    );

    expect(asset.params.width / asset.params.height).toBeCloseTo(4 / 3, 6);
    expect(asset.params.radius).toBeGreaterThan(0);
    expect(asset.params.blur).toBeLessThan(asset.params.height / 4);
  });

  // режимы see-through и объёма читает клиентский код (src/config/render.js);
  // здесь они лежат как часть клиентского конфига игры
  it('parts несёт настройки see-through и объёма', () => {
    expect(clientConfig.parts.seeThrough.mode).toBe('hole');
    expect(clientConfig.parts.volume.enabled).toBe(true);
  });

  // числа тени и проекции высоты переехали из партов в
  // src/config/render.js: реестр держит их на виду вместе с остальным 2.5D
  it('parts несёт настройки тени и проекции высоты', () => {
    expect(clientConfig.parts.shadow.sizeFactor).toBeGreaterThan(0);
    expect(clientConfig.parts.parallax.levelZStride).toBeGreaterThan(0);
    expect(clientConfig.parts.parallax.shear).toBeGreaterThan(0);
    expect(clientConfig.parts.volume.rampSegments).toBeGreaterThan(0);
  });

  // наклона корпуса и пыли из-под гусениц больше нет (этап 5.2 кодревью):
  // высота читается тенью, параллаксом и масштабом
  it('в parts не осталось настроек уклона и пыли', () => {
    expect(clientConfig.parts.grade).toBeUndefined();
    expect(clientConfig.parts.dust).toBeUndefined();
  });

  // только свой танк пишет в levelView; свой танк и свой выстрел вдобавок
  // звучат непространственно (spatial: false) — источник на слушателе HRTF
  // сворачивает в гул
  it('localPlayer объявлен для Tank и ShotEffect', () => {
    expect(deps.localPlayer).toEqual(['Tank', 'ShotEffect']);
  });
});
