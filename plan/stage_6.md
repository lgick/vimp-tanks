# Этап 6 — рендер PixiJS: слои, порядок отрисовки, see-through

**Репозиторий:** `T` = `/Users/dmitry/Sites/my/vimp-tanks`
**Каталог:** `src/client/`

Цель: два уровня видны как два уровня — земля, эстакада над ней, танки на
своём уровне, и мост становится полупрозрачным, когда игрок под ним.

Предусловие: этап 5 зелёный.

## 6.1 Схема порядка отрисовки

Все парты — прямые дети `app.stage` с `sortableChildren = true`
(`packages/engine/src/client/components/view/Game.js`), порядок задаёт
только `zIndex`. Схема:

```
zIndex = базовый zIndex парта + LEVEL_Z_STRIDE * level
LEVEL_Z_STRIDE = 100
```

Базовые значения остаются сегодняшними — одноуровневая карта рисуется
ровно как раньше (level = 0 ⇒ смещение 0):

| Парт | Базовый zIndex |
| --- | --- |
| `Tracks` | 1 |
| `Map` (статический слой) | `data.layer` из карты (сейчас 1 и 4) |
| `Map` (динамическое тело) | `data.layer` из карты (сейчас 3) |
| `ShotEffect`, `ExplosionEffect.funnel` | 2 |
| `Bomb`, `TankRadar`, `MapRadar` | 2 |
| `Tank` | 3 |
| `Smoke`, `ExplosionEffect.explosion` | 4 |

С шагом 100 любой слой уровня 1 (≥ 101) заведомо выше любого слоя уровня 0
(≤ 4…9), что и требуется: плита моста закрывает всё под собой.

Завести общий модуль:

```js
// src/client/levelZ.js
// Шаг zIndex между уровнями 2.5D-карты. Порядок отрисовки внутри уровня
// задают базовые zIndex партов (см. plan/stage_6.md); шаг обязан быть
// больше любого базового, иначе слой моста провалится под наземный навес.
export const LEVEL_Z_STRIDE = 100;

export const levelZ = (base, level) => base + LEVEL_Z_STRIDE * (level || 0);
```

## 6.2 `src/client/parts/Map.js`

### Статический слой

```js
      this._map = data.map;
      this._tiles = data.tiles;
      this._level = data.level || 0;
      this._solid = data.solid || data.physicsStatic || [];
      this._floor = data.floor || [];
      this._spriteSheetData = data.spriteSheet;
      this._step = data.step;
      this.zIndex = levelZ(Number(data.layer) || 1, this._level);
```

### Динамическое тело

```js
      this.zIndex = levelZ(Number(data.layer) || 2, data.level || 0);
```

### See-through (только слои уровня ≥ 1)

```js
// доля непрозрачности плиты, когда локальный игрок под ней
const UNDER_BRIDGE_ALPHA = 0.4;
// скорость перехода прозрачности (доля в секунду): мгновенный скачок
// читается как мигание при каждом въезде под край моста
const ALPHA_FADE_RATE = 6;
```

В конструкторе, для `this._level >= 1` и при наличии сервиса:

```js
      this._levelView = dependencies.levelView || null;
      this._targetAlpha = 1;
```

Реализовать `onRender()` — PixiJS зовёт его каждый кадр у объекта в сцене:

```js
  // прозрачность плиты моста над локальным игроком: в GTA 2 игрок под
  // эстакадой продолжает видеть свою машину. Считается по НАШЕМУ гриду
  // уровня: парт уже знает и карту слоя, и список тайлов пола
  onRender() {
    if (this._level < 1 || !this._levelView || !this.mapSprite) {
      return;
    }

    const under =
      this._levelView.level < this._level && this._hasFloorAt(this._levelView.x, this._levelView.y);

    this._targetAlpha = under ? UNDER_BRIDGE_ALPHA : 1;

    // сглаживание по времени тикера общего приложения
    const dt = Ticker.shared.deltaMS / 1000;

    this.alpha += (this._targetAlpha - this.alpha) * Math.min(1, ALPHA_FADE_RATE * dt);
  }

  _hasFloorAt(worldX, worldY) {
    const col = Math.floor(worldX / this._step);
    const row = Math.floor(worldY / this._step);
    const tile = this._map?.[row]?.[col];

    return tile !== undefined && this._floor.includes(tile);
  }
```

> **Координаты.** `levelView` пишет позицию в тех же единицах, в которых
> парт получил карту: контейнер `Map` масштабируется целиком
> (`this.scale = data.scale`), а `_map`/`_step` немасштабированы. Значит
> позицию танка надо делить на `scale` — ровно как это уже делает
> `Map.update` для динамики (`data[0] / this.scale.x`). Записать деление в
> `_hasFloorAt` или в сам сервис — выбрать ОДНО место и прокомментировать.

## 6.3 `src/client/levelView.js` — сервис игры (новый файл)

```js
// Сервис пула зависимостей `levelView`: где и на каком уровне находится
// локальный игрок. Движок такого сервиса не даёт и не должен — это игровое
// понятие; плагин отдаёт его своим же партам через
// ClientPlugin.hooks.services (src/client/index.js).
//
// Пишет локальный `Tank` (он единственный знает и свой уровень, и свою
// позицию, и что он локальный — по сервису `localPlayer`), читают
// слои `Map` уровня >= 1, чтобы стать полупрозрачными над игроком.
export function createLevelView() {
  const state = { level: 0, x: 0, y: 0 };

  return {
    set(level, x, y) {
      state.level = level;
      state.x = x;
      state.y = y;
    },
    get level() {
      return state.level;
    },
    get x() {
      return state.x;
    },
    get y() {
      return state.y;
    },
  };
}
```

Регистрация в `src/client/index.js`:

```js
import { createLevelView } from './levelView.js';

// один экземпляр на клиента: создаётся при сборке сервисов, живёт столько
// же, сколько ядро
const levelView = createLevelView();

...
    services(core) {
      return {
        mapDynamics: { ... },
        levelView,
      };
    },
```

`src/config/client.js` → `componentDependencies`:

```js
      // 2.5D: где локальный игрок и на каком он уровне. Пишет Tank, читает
      // Map (плита моста над игроком становится полупрозрачной)
      levelView: ['Tank', 'Map'],
      // «свой ли это танк» — движковый сервис; локальный танк единственный,
      // кто вправе писать в levelView
      localPlayer: ['Tank'],
```

## 6.4 `src/client/parts/Tank.js`

Строка данных `m1`: `[x, y, rotation, gunRotation, vX, vY, engineLoad,
condition, size, teamId, angvel, z, level]`.

```js
import { levelZ } from '../levelZ.js';

// подъём спрайта при высоте z: масштаб и смещение тени дают читаемую
// разницу «внизу / наверху» без 3D
const Z_SCALE_GAIN = 0.06;
const Z_SHADOW_OFFSET = 6;
```

В конструкторе:

```js
    this._z = data[11] || 0;
    this._level = data[12] || 0;
    this.zIndex = levelZ(3, this._level);

    this._isLocal = dependencies.localPlayer?.is(context.id) === true;
    this._levelView = dependencies.levelView || null;
```

> Четвёртый аргумент конструктора парта — `{ id }` (см. `GameModel.create`).
> `Tank` его сейчас не принимает — добавить в сигнатуру
> `constructor(data, assets, dependencies, context)`.

В `update(data)`:

```js
    const level = data[12] || 0;

    this._z = data[11] || 0;

    if (level !== this._level) {
      this._level = level;
      this.zIndex = levelZ(3, level);
    }

    // высота читается масштабом корпуса и отлётом тени
    const zScale = 1 + this._z * Z_SCALE_GAIN;

    this.body.scale.set(this._scaleFactor * zScale);
    this.gun.scale.set(this._scaleFactor * zScale);

    if (this._isLocal && this._levelView) {
      this._levelView.set(level, this.x, this.y);
    }
```

`this._scaleFactor` — вынести уже вычисляемый в конструкторе
`scaleFactor` в поле (сейчас он локальная переменная).

> **Проверка sortableChildren.** Запись `zIndex` уже добавленному в сцену
> объекту поднимает `sortDirty`, и PixiJS пересортирует детей на ближайшем
> рендере — `GameView.add` включает `sortableChildren`. Отдельный
> `sortChildren()` при смене уровня не нужен; если в реальном запуске
> порядок не обновляется, добавить его в `Tank.update` через сервис
> `renderer` — но сначала проверить.

## 6.5 Остальные парты

| Парт | Данные | Правка |
| --- | --- | --- |
| `TankRadar.js` | строка `m1` | `zIndex = levelZ(2, data[12])`; чужой танк на другом уровне рисуется полым маркером (см. 6.6) |
| `Smoke.js` | строка `m1` | `zIndex = levelZ(4, data[12])`, обновлять при смене уровня |
| `tracks/Tracks.js` | строка `m1` | `zIndex = levelZ(1, data[12])`; след, оставленный на уровне 1, остаётся на уровне 1 — фиксировать уровень у КАЖДОЙ отметки `TrackMark`, а не у контейнера, если контейнер один на танк. Если контейнер один — при смене уровня заводить новый контейнер отметок, старый оставлять дорисовываться на прежнем zIndex |
| `Bomb.js` | строка `w2`, индекс 6 = `level` | `zIndex = levelZ(2, data[6])` |
| `effects/shot/ShotEffectController.js` | строка `w1`, индексы 8/9 = `startLevel`/`endLevel` | `zIndex = levelZ(2, startLevel)`; трассер рисуется в двух частях, если `startLevel !== endLevel`: отрезок до кромки на уровне старта и остаток на уровне конца. Точку кромки взять из сервиса не получится — считать в парте по своей копии слоёв нечем, поэтому **упрощение**: рисовать весь трассер на `endLevel`, а `ImpactEffect` — на `endLevel`. Полноценный «падающий» трассер отложить (см. 6.7) |
| `effects/explosion/ExplosionEffectController.js` | строка `w2e`, индекс 3 = `level` | `explosion.zIndex = levelZ(4, level)`, `funnel.zIndex = levelZ(2, level)` |

## 6.6 `src/client/parts/MapRadar.js`

Сегодня парт создаётся по одному экземпляру на КАЖДЫЙ статический слой и
каждый рисует одни и те же стены. Со слоями это стало бы N×M одинаковых
график. Правка одновременно чинит старую избыточность:

```js
    this._level = data.level || 0;
    this._solid = data.solid || data.physicsStatic || [];
    this._tiles = data.tiles || [];
    this.zIndex = levelZ(2, this._level);

    // рисуем стены только тем слоем, который эти стены и показывает:
    // иначе каждый рендер-слой карты дублировал бы одну и ту же графику
    this._draws = this._tiles.some(tile => this._solid.includes(tile));
```

`createRadarMap` выходит сразу, если `!this._draws`. Цвет: уровень 0 —
`0xffffff`, уровень 1 — `0x8fb7ff` (мост читается отдельно от земли).

`TankRadar.js`: если `data[12]` (уровень танка) отличается от уровня
локального игрока (`levelView.level`) — рисовать маркер контуром, а не
заливкой. Это требует зависимости `levelView` и для `TankRadar` — добавить
в `componentDependencies`. Если объём великоват — вынести в 6.7.

## 6.7 Отложенные улучшения (не блокируют этап)

Записать в `plan/README.md` отдельным списком «после первой итерации», не
делать сейчас:

* радиальная маска прозрачности вокруг игрока вместо alpha на весь слой;
* трассер, ломающийся на кромке плиты (две линии вместо одной);
* тень танка отдельным спрайтом вместо смещения;
* маркер уровня на радаре.

## 6.8 Тесты

Каталог `tests/client/parts/`. Парты тестируются с `happy-dom` и реальным
PixiJS (см. существующие тесты).

| Файл | Тест |
| --- | --- |
| `tests/client/parts/Map.test.js` | `static layer of level 1 gets the stride offset` |
| | `bridge layer fades when the local player is under it` (подставить фейковый `levelView`, дёрнуть `onRender`) |
| | `bridge layer stays opaque when the player is beside it` |
| `tests/client/parts/Tank.test.js` | `zIndex follows the level` |
| | `local tank publishes its level to levelView` |
| | `foreign tank does not write to levelView` |
| `tests/client/parts/MapRadar.test.js` | `only the layer that owns the solid tiles draws` |
| `tests/client/tanksClientPlugin.test.js` | `services expose levelView` |
| `tests/config/client.test.js` (создать, если нет) | `componentDependencies объявляет levelView и localPlayer` |

## 6.9 Changelog и документация

* `CHANGELOG.md` → `### Added`: рендер по уровням, полупрозрачность моста
  над игроком, сервис `levelView`. `### Fixed`: `MapRadar` больше не
  дублирует графику на каждый рендер-слой.
* `docs/en|ru/architecture.md`: схема zIndex и `LEVEL_Z_STRIDE`, сервис
  `levelView` рядом с `mapDynamics`.
* `docs/en|ru/extending.md`: как задавать `layers` уровня и какие zIndex
  свободны; правило «перила не вплотную к низу рампы».
* `docs/en|ru/configuration.md`: `componentDependencies` пополнился.

## Критерии готовности этапа

```bash
cd /Users/dmitry/Sites/my/vimp-tanks
npx eslint . && npm test -- --silent && npm run build
```

Плюс глазами: `npm run dev` на одноуровневой карте (`pool mini`) — картинка
не отличается от базовой линии.

Отметить `✅ выполнен` здесь и в `plan/README.md`.
