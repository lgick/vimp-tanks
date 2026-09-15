# Этап 1. Переход плагина на новый движок и каркас `game` ✅ выполнен

**Репозиторий:** `vimp-tanks`. **Зависит от:** этапа 0 (релиз или локальная связка движка).
**Перед началом:** `plan/night-city/README.md` → «Общий контекст».

## Цель

Плагин работает на движке с этапа 0, объявляет новые capabilities, передаёт байт `state` в строке тел
(пока всегда `0`) и разбирает поле `game` карты на обеих сторонах ядра. Поведение игры не меняется.

## 1.1 Зависимости

- `package.json`: `vimp-engine` → `^0.34.0` (обновить `package-lock.json` через `npm install`).
- `core/Cargo.toml`: `vimp-engine-core = "0.20.0"`; `Cargo.lock` обновится при сборке.
- Для локальной разработки до публикации — `npm link` и path-patch из `docs/en/getting-started.md`.
- Исправить компиляцию по изменениям API движка: новое поле `SimCtx.map_body_state` (плагин сам `SimCtx` не создаёт,
  но проверить тесты в `core/src/client/predictor.rs` и `core/tests/sim.rs`).

## 1.2 Capabilities

- `src/host/index.js` и `src/client/index.js`: к текущему списку добавить новые возможности, ничего не удаляя —
  `requires: ['map.layers', 'map.levelsN', 'map.gameData', 'map.bodyState']`.
  `scripts/build-game-manifest.js` копирует список из `src/host/index.js`, так что достаточно одного места — проверить.

## 1.3 Байт `state` в строке тел

1. `src/config/snapshot.js` (≈112–145), ключи `c1` и `c2`: вставить после `level` поле
   `{ name: 'state', ty: 'u8', role: 'state' }` (индекс 5); `optionalFrom: 6`.
   Итоговая строка: `[x, y, angle, z, level, state, vx, vy, angvel]`.
2. `src/client/snapshotFields.js` (≈55–59): добавить `C_STATE = 5`, сдвинуть индексы скоростей, если они объявлены.
3. `core/src/client/map_dynamics.rs`: константы `FIELD_*` (≈58–65) сдвинуть (`FIELD_STATE = 5`, `FIELD_VX = 6`, …);
   `render_data` (≈432–476) пишет строку новой ширины со `state` из последнего кадра. Тестовая схема `c1` в
   `core/src/client/mod.rs` (≈629) **плоская** (`optionalFrom: 3`, без `z`/`level`): по правилу этапа 0 `state` в ней
   встаёт на позицию `3`, `optionalFrom: 4`. Сначала проверить, какие тесты её используют и читают ли они строку
   через `FIELD_*` (слоёные позиции); если да — перевести схему на слоёную, а не сдвигать молча.
4. Везде, где строки тел читаются по индексам (`grep -rn "C_Z\|C_LEVEL\|FIELD_VX" src core/src tests`), проверить сдвиг.
5. Тесты: `tests/config/snapshot.test.js`, `tests/core/core.test.js` и `tests/core/clientCore.test.js` (декод строки тела
   с `state`), `tests/client/parts/map/MapObject.test.js`.

## 1.4 Каркас разбора `game` в ядре

1. Новый модуль `core/src/map_game.rs` (подключить в `lib.rs`):
   ```rust
   #[derive(Deserialize, Default, Clone)]
   #[serde(rename_all = "camelCase", default)]
   pub struct MapGame {
       /// уровень ("0", "1", …) → id тайла ("41") → описание поверхности (этап 2)
       pub surfaces: BTreeMap<String, BTreeMap<String, SurfaceTileDef>>,
   }
   // lighting / animatedTiles / signs / decals — клиентские, ядро их не разбирает (serde отбросит)

   #[derive(Deserialize, Default, Clone)]
   #[serde(rename_all = "camelCase", default)]
   pub struct PropGame { pub prop: Option<String> } // physicsDynamic[i].game (этап 5)
   ```
   `SurfaceTileDef` пока объявить заглушкой: `#[serde(untagged)] enum { Name(String), Full { r#type: String, dir: Option<String> } }`.
   Сама логика появится на этапе 2.
2. Хост: `impl GameSim for TanksSim` → `on_map_loaded(ctx)` (`core/src/tanks.rs`) сам ничего не разбирает: он
   вызывает `rebuild_map_derived(ctx)?`, затем `reset_round_state(ctx)?`. Разбор
   `ctx.map.as_ref().map(|m| m.game_data())` в `TanksSim.map_game: MapGame` (ошибка серде → `Err` с именем поля)
   живёт **только** в `rebuild_map_derived` — одно место на хук и на путь после `deserialize`.
   Смена карты обслуживается **двумя** функциями с разным назначением — их нельзя сводить в одну:
   - `rebuild_map_derived(ctx)` — пересобирает данные, выводимые из карты и конфига: `map_game`, `SurfaceMap`
     (этап 2). Вызывается ровно в двух местах: из хука `on_map_loaded` и в начале `on_fixed_step` по собственному
     флагу `map_derived_dirty`. Флаг ставит `deserialize` (хук при восстановлении не вызывается), снимает сама
     `rebuild_map_derived`. **К `sync_levels` не привязывать:** его отпечаток (`tanks.rs` ≈811–829) строится только
     для слоёной карты (`filter(|map| map.is_layered())`), на плоской он всегда `None`. Флаг `levels_dirty` на плоской
     карте не снимается (`update_levels` выходит раньше), и пересборка шла бы каждый шаг. А на слоёной карте смена
     отпечатка дала бы вторую пересборку сразу после хука.
     **Ошибка по флагу.** `on_fixed_step` ничего не возвращает (`sim.rs:103`), поэтому `Err` из пересборки по флагу
     вернуть некуда. Ошибка там не ожидается: та же карта уже прошла хук. Отладочного лога у ядра нет (в `debug.rs`
     движка — только дамп `engine_json`), поэтому канал — существующее событие `CoreEvent::Custom { data }`
     (`events.rs:31`), которое движок отдаёт в `HostPlugin.onCoreEvent`:
     - снять флаг, оставить производные данные пустыми (`surfaces = None` → нейтральный путь);
     - `ctx.events.push(CoreEvent::Custom { data: json!({ "type": "mapDerivedError", "message": err }) })`;
     - ни `unwrap`/паники, ни молчаливого проглатывания.
     Сейчас `onCoreEvent` в `src/host/index.js` не задан (там комментарий ≈22), поэтому на этом этапе завести его:
     событие `type: 'mapDerivedError'` → `console.warn` с сообщением; прочие `custom` — игнорировать, как раньше.
     Обработчик должен остаться Worker-safe. Документация: в `docs/en|ru/core.md` фраза «this game doesn't use it —
     `onCoreEvent` is left unset» заменяется описанием `mapDerivedError`.
     Форма события: `CoreEvent` сериализуется с `#[serde(tag = "type")]`, поэтому на проводе оно
     `{ "type": "custom", "data": { "type": "mapDerivedError", "message": … } }`, а `GameCoreAdapter._drainEvents`
     передаёт в `onCoreEvent` **только** `event.data`. Обработчик проверяет `data.type`.
     Тесты:
     - Rust (`core/tests/sim.rs`) — повреждённый `game` после `deserialize` не роняет шаг, движение нейтральное; события
       читать тем же вызовом, что существующие тесты (`serde_json::from_str(&core.take_events())`, ≈349), и проверять
       оба уровня: внешний `type == "custom"` и `data.type == "mapDerivedError"`. (`take_events_json()` — имя метода
       в ядре движка, `game.rs:201`; в тестах плагина его не использовать.)
     - JS (`tests/host/hostPlugin.test.js`) — вызывать обработчик с уже развёрнутыми данными:
       `onCoreEvent({ type: 'mapDerivedError', message: '…' }, services)` → один `console.warn`; `onCoreEvent({ type: 'other' }, services)` → ни одного;
   - `reset_round_state(ctx)` — сбрасывает состояние, живущее внутри раунда: пропы (этап 5). Вызывается **только**
     из `on_map_loaded`. Не из отпечатка: при рестарте раунда карта та же и отпечаток не меняется, а сброс нужен.
     Не после `deserialize`: там это состояние восстановлено из дампа, и сброс стёр бы разрушения при эстафете.
   На этапе 1 `reset_round_state` пустая. Тесты: хук вызывает обе функции; после `deserialize` первый шаг вызывает
   только `rebuild_map_derived`, и ровно один раз (второй шаг — ни одной), в том числе на плоской карте.
3. Клиент: `ClientMapConfig` (`core/src/client/mod.rs` ≈34) получает `#[serde(default)] game: MapGame`, а элементы
   `physicsDynamic` — `#[serde(default)] game: PropGame`. `TanksClient::set_map` (≈469) сохраняет разобранное.
4. Тесты: Rust unit — `MapGame` разбирает пустой, отсутствующий и полный объект, неизвестные ключи игнорируются;
   `on_map_loaded` на карте без `game` не падает. JS harness — существующие карты грузятся.

## 1.5 Документация и журнал

- `docs/en|ru/configuration.md`: строка `c1/c2` теперь `[x, y, angle, z, level, state, vx, vy, angvel]`, смысл `state`
  (пока всегда `0`), новые capabilities; упоминание поля карты `game` (заполняется на следующих этапах).
- `docs/en|ru/architecture.md`: capabilities.
- `CHANGELOG.md` → `### ⚠️ Breaking`: строка `c1/c2` выросла на 1 байт, хост и клиент разных версий несовместимы;
  `### Migration`: пересобрать ядро, выпускать хост и клиент вместе, требуется `vimp-engine >= 0.34.0`.

## Критерии готовности

`npx eslint .`, `npm run core:build`, `npm run core:test`, `npm test -- --silent`, `npm run build`, `npx vimp-contract`,
`npm run sim:scenarios` — зелёные. В `npm run dev` игра визуально не изменилась.
