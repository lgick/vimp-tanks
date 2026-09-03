# Этап 2 — JS движка: транспорт слоёв до хоста и клиента

**Репозиторий:** `E` = `/Users/dmitry/Sites/my/vimp`
**Пакет:** `packages/engine` (npm `vimp-engine`)

Цель: слои карты доезжают из `gameConfig.maps` до Rust-ядра хоста, до
клиентского ядра и до рендер-партов игры; явный уровень респауна доходит до
ядра; игра может передать в своё ядро собственные параметры, не заставляя
движок знать их имена. Плюс новая возможность `map.layers` и статическая
проверка формата.

Предусловие: этап 1 зелёный.

## 2.1 `packages/engine/src/host/meta/core/RoundManager.js` — `scaleMapData`

Единственная правка — сохранить хвост респауна:

```js
  const respawns = Object.fromEntries(
    Object.entries(mapData.respawns || {}).map(([team, arr]) => [
      team,
      // 4-й элемент точки — уровень 2.5D-карты; масштабируются ТОЛЬКО
      // координаты, всё остальное едет как есть
      arr.map(point => [point[0] * scale, point[1] * scale, ...point.slice(2)]),
    ]),
  );
```

`levels` и `ramps` доезжают сами: функция возвращает `{ ...mapData, … }`.
Гриды слоёв — списки индексов тайлов, масштабировать в них нечего.

`physicsDynamic` уже копируется через `{ ...item }`, значит `level` едет
сам.

## 2.2 `packages/engine/src/host/GameCoreAdapter.js` — уровень участника

`createMap` не меняется (весь объект уходит в `load_map` строкой).

В `createPlayer` после спавна и в методе, который зовёт `reset_actor`
(найти его в файле — он же обрабатывает респаун/смену команды), добавить:

```js
  // явный уровень точки респауна на 2.5D-карте (respawns[i][3]); ядро,
  // собранное до появления метода, его просто не экспортирует — тогда
  // уровень выведется из геометрии внутри ядра
  _applyActorLevel(gameId, data) {
    const level = data[3];

    if (typeof level === 'number' && typeof this._core.set_actor_level === 'function') {
      this._core.set_actor_level(gameId, level);
    }
  }
```

и вызвать её сразу после `spawn_actor`/`spawn_scripted_actor`/`reset_actor`.

> Проверка `typeof … === 'function'` не косметика: `dist` уже
> опубликованных игр содержит glue-код своего поколения ядра, и метода там
> нет. Без проверки движок падал бы на чужой игре.

## 2.3 `packages/engine/src/lib/coreConfig.js` — параметры ядра игры

Сегодня `buildCoreConfig` собирает половину `game` белым списком
(`friendlyFire`, `models`, `weapons`, `playerKeys`, `panel`). Любой новый
параметр игрового ядра требует релиза движка — это архитектурная заноза, и
2.5D упирается в неё первой (`levels.fallTime`, `levels.fallDamage`).

Добавить непрозрачный проброс:

```js
  return {
    engine: { ... },
    game: {
      // собственные параметры ядра игры: движок их не читает и не
      // валидирует — он лишь довозит их до `GameSim::new`. Известные ключи
      // ниже перекрывают одноимённые, чтобы игра не могла подменить
      // движковую часть контракта
      ...(gameConfig.coreParams || {}),
      friendlyFire: flat.friendlyFire,
      models: flat.models,
      weapons: flat.weapons,
      playerKeys: flat.playerKeys,
      panel: flat.panel,
    },
  };
```

Обновить JSDoc функции: описать `gameConfig.coreParams`.

## 2.4 `packages/engine/src/client/main.js` — `applyMapData`

Функция `applyMapData` (около строки 544) меняется в двух местах.

### 2.4.1 Конфиг клиентского ядра

```js
  clientCore?.set_map(
    JSON.stringify({
      map,
      step,
      scale,
      setId,
      physicsStatic,
      physicsDynamic: data.physicsDynamic,
      // 2.5D: надземные уровни и переходы. Клиентское ядро строит из них
      // ту же `MapLevels`, что и хост, — иначе предсказание уровня
      // разъедется с авторитетным молча
      levels: data.levels,
      ramps: data.ramps,
    }),
  );
```

### 2.4.2 Статические данные рендера по уровням

Сейчас:

```js
  const staticData = Object.entries(layers).reduce((acc, [layer, tiles], index) => {
    acc[`s${index}`] = { type: 'static', spriteSheet, map, step, layer, tiles, physicsStatic, scale };
    return acc;
  }, {});
```

Заменить на сборку по уровням со сквозной нумерацией ключей:

```js
  // рендер-слои по уровням: уровень 0 — из `layers` над гридом `map`,
  // надземные — из `levels[n].layers` над гридом `levels[n].map`.
  // Ключи `s0..sN` сквозные: парт получает `level`, `solid` и `floor`
  // своего уровня и не обязан ничего знать про соседний
  const staticData = {};
  let staticIndex = 0;

  const pushLayers = (levelLayers, levelMap, level, solid, floor) => {
    for (const [layer, tiles] of Object.entries(levelLayers || {})) {
      staticData[`s${staticIndex}`] = {
        type: 'static',
        spriteSheet,
        map: levelMap,
        step,
        layer,
        tiles,
        level,
        solid,
        floor,
        // прежнее имя оставлено для парта, который его уже читает
        physicsStatic,
        scale,
      };

      staticIndex += 1;
    }
  };

  pushLayers(layers, map, 0, physicsStatic, []);

  for (const [key, levelData] of Object.entries(data.levels || {})) {
    const level = Number(key);

    pushLayers(levelData.layers, levelData.map, level, levelData.walls || [], levelData.floor || []);
  }
```

> **Ловушка нумерации.** Ключи `s0..sN` — это id экземпляров парта в
> `GameModel`. Сквозной счётчик обязателен: два ключа `s0` (по одному на
> уровень) перетёрли бы друг друга, и половина карты просто не появилась бы
> — без единой ошибки.

## 2.5 `packages/engine/src/devtools/VirtualClient.js`

Файл — зеркало `main.js` для headless-раннера (см. его комментарий у
`MAP_DATA`). Повторить обе правки 2.4 один в один. Без этого сценарии
этапа 8 гоняли бы клиентское ядро без слоёв и «доказывали» бы зелёное на
неполных данных.

## 2.6 `packages/engine/src/lib/capabilities.js`

```js
  // слоёные карты: `levels`/`ramps` в формате карты, маски уровней в
  // физике, уровень участника (`set_actor_level`), слоёный нав-граф
  { value: 'map.layers', since: '<версия релиза этапа 8>' },
```

Версию проставить на релизе (этап 8) — до него можно указать ожидаемую
(`0.25.0`) и поправить при бампе.

## 2.7 Правило статической проверки контракта

Новый файл `packages/engine/src/devtools/contract/rules/e3-map-layers.js`
по образцу `e2-map-images.js`:

```
id: 'E3'
name: 'mapLayers'
level: ERROR
title: 'layered maps are structurally sound'
```

Проверяет по `ctx.gameConfig.maps` то же, что `MapConfig::validate` в Rust,
но до сборки и без ядра:

1. ключи `levels` — целые `>= 1`, подряд от 1;
2. размерность `levels[n].map` совпадает с `map`;
3. `levels[n].walls ⊆ levels[n].floor`;
4. каждый `ramps[i].tile` встречается в гриде уровня `ramps[i].from`;
5. `ramps[i].dir` ∈ `north|south|west|east`, `from !== to`;
6. каждый респаун длиной 3 или 4, уровень в диапазоне;
7. каждый `physicsDynamic[i].level` в диапазоне;
8. каждый тайл, названный в `levels[n].layers`, есть в
   `spriteSheet.frames` по индексу.

`skip('no layered maps')`, если ни одна карта не объявила `levels` —
правило обязано быть безвредным для одноуровневых игр.

Зарегистрировать правило в реестре правил (найти файл, который собирает
группу `E`, рядом с `e2-map-images.js`).

## 2.8 `packages/engine/src/standalone/index.js`

Проверить, что `startStandaloneGame` не фильтрует поля карты по белому
списку на пути к `RoundManager`/`SocketManager`. Если фильтрует — добавить
`levels`/`ramps`. Если карта проходит целиком — правок нет.

## 2.9 Тесты движка (Vitest, `packages/engine/tests/…`)

| Файл | Тест | Что проверяет |
| --- | --- | --- |
| `host/RoundManager.test.js` (или где живут тесты `scaleMapData`) | `scaleMapData keeps the respawn level` | точка `[100, 200, 0, 1]` при `scale = 0.5` → `[50, 100, 0, 1]` |
| `host/RoundManager.test.js` | `scaleMapData passes layers and ramps through` | `levels`/`ramps` в результате идентичны входу |
| `host/GameCoreAdapter.test.js` | `createPlayer sends the explicit actor level` | фейковое ядро получает `set_actor_level(gameId, 1)` для точки с уровнем |
| `host/GameCoreAdapter.test.js` | `createPlayer skips the level on an old core` | ядро без метода — вызова нет, исключения нет |
| `lib/coreConfig.test.js` | `coreParams reach the game half` | `gameConfig.coreParams = { levels: { fallTime: 0.35 } }` → в `config.game.levels` |
| `lib/coreConfig.test.js` | `coreParams cannot override engine keys` | `coreParams.models` не перетирает `parts.models` |
| `client/applyMapData.test.js` (или существующий тест `main.js`) | `static layers are numbered across levels` | 2 слоя на L0 + 2 на L1 → ключи `s0..s3`, у каждого свой `level` |
| `devtools/contract/e3-map-layers.test.js` | по одному кейсу на каждую проверку 2.7 | |

Если для `applyMapData` в репозитории нет точки тестирования — не изобретать
её: покрыть сборку `staticData` через `VirtualClient` в сценарном тесте
этапа 8 и явно записать это здесь как осознанный пропуск.

## 2.10 Changelog и документация движка

* `packages/engine/CHANGELOG.md` → `### Added`: слои карты в `MAP_DATA` и
  `set_map`, `staticData` по уровням, `gameConfig.coreParams`, уровень
  респауна через `set_actor_level`, capability `map.layers`, правило
  контракта E3.
* `docs/en|ru/client.md`: раздел про `applyMapData` и поля `level`/`solid`/
  `floor`, приезжающие в парт карты.
* `docs/en|ru/host.md`: `set_actor_level` в описании `GameCoreAdapter`.
* `docs/en|ru/configuration.md`: `gameConfig.coreParams`.
* `docs/en|ru/plugin-api.md`: формат карты со слоями, `requires:
  ['map.layers']`, поля, приезжающие в парты.
* `docs/en|ru/debugging.md`: правило контракта E3 в списке группы E.
* `docs/ai/03-host-plugin.md`: `coreParams` в справочнике `gameConfig`.
* `docs/ai/04-client-plugin.md`: новые поля данных статического слоя карты.
* `docs/ai/07-maps-and-assets.md`: доработать после этапа 1 — добавить,
  что именно доезжает до клиента.

## Критерии готовности этапа

```bash
cd /Users/dmitry/Sites/my/vimp
cargo test --workspace --quiet
npx eslint .
npm test -- --silent
```

Плюс дымовая проверка связки: собрать танки на локальном движке и убедиться,
что одноуровневая карта работает как раньше.

```bash
cd /Users/dmitry/Sites/my/vimp-tanks
npm run core:build && npm run build && npm run sim:scenarios
```

Все 4 существующих сценария зелёные — значит транспорт слоёв ничего не
сломал на одноуровневых картах.

Отметить `✅ выполнен` здесь и в `plan/README.md`.
