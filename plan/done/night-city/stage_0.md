# Этап 0. Расширения движка ✅ выполнен

**Репозиторий:** `/Users/dmitry/Sites/my/vimp` (крейт `packages/engine/core`, JS `packages/engine/src`).
**Перед началом:** прочитать `plan/night-city/README.md` (раздел «Общий контекст»), `CLAUDE.md` репозитория движка,
его `docs/en/core.md`, `docs/en/plugin-api.md` и `docs/en/publishing.md`. Правила движка (документация, CHANGELOG,
команды тестов) берутся из его собственного `CLAUDE.md`.

## Цель

Дать игре четыре обобщённые возможности, которых сейчас нет:

1. Непрозрачное поле карты `game` (и `physicsDynamic[i].game`) доходит до игрового ядра на хосте, до `ClientCore.set_map`
   на клиенте и до частей карты.
2. Хук `GameSim::on_map_loaded` вызывается при каждой загрузке карты.
3. Игра может сопоставить хэндл тела карты с его индексом, получить хэндл по индексу и отключить тело.
4. Байт состояния тела карты (роль поля `state`) пишется движком в строку `c1/c2`, а игра меняет его через `SimCtx`.

Все четыре — опциональные: игра, которая их не объявляет, работает как раньше.

## 0.1 Поле `game` карты

1. `core/src/map.rs`:
   - `MapConfig` (≈123): `#[serde(default)] pub game: serde_json::Value` (по умолчанию `Null`).
   - `DynamicObjectConfig` (≈32): `#[serde(default)] pub game: serde_json::Value`.
   - `GameMap` хранит `game: serde_json::Value` и `dynamic_game: Vec<serde_json::Value>` (заполняются в конструкторе и
     `create_dynamic` ≈1602). `GameMap` уже `Serialize/Deserialize`, поэтому поля попадают в дамп эстафеты сами;
     проверить тестом.
   - Геттеры: `pub fn game_data(&self) -> &serde_json::Value`,
     `pub fn dynamic_game_data(&self, index: usize) -> Option<&serde_json::Value>`.
   - `MapConfig::validate`: `game` — `Null` или объект; каждый `physicsDynamic[i].game` — `Null` или объект; иначе ошибка
     загрузки карты с понятным текстом.
2. `src/client/main.js`, `applyMapData` (≈577–600): добавить `game: data.game` в JSON для `set_map`.
   `pushLayers` (≈649–676): добавить `game: data.game` в данные каждой статической части.
   Динамические части уже получают `...item`, и `physicsDynamic[i].game` доходит; зафиксировать это тестом.
3. `src/devtools/VirtualClient.js` (≈196): тот же белый список для `set_map` — добавить `game`.
4. Масштаб: движок **не масштабирует** содержимое `game`. Задокументировать: координаты в `game` задаются в клетках сетки
   (или в немасштабированных единицах, и тогда их масштабирует сама игра через `scale`).
5. Правило контракта `src/devtools/contract/rules/e7-map-game-field.js` (+ регистрация в `rules/index.js` и тесты по образцу
   `e4-map-layers.js`): `game` отсутствует или является простым объектом; то же для `physicsDynamic[].game`.
6. Capability: найти, где объявлен `map.layers` (`grep -rn "map.layers" packages/engine/src`), и добавить `map.gameData`.

## 0.2 Хук `on_map_loaded`

1. `core/src/sim.rs`, трейт `GameSim` (≈48): метод
   `fn on_map_loaded(&mut self, _ctx: &mut SimCtx) -> Result<(), String> { Ok(()) }`.
2. `core/src/game.rs`, `EngineSim::load_map` (≈86): вызвать после построения `GameMap` и создания всех тел. Ошибка
   пробрасывается из `load_map`. Отката к прежней карте **нет**: старая карта уничтожается ещё до `GameMap::create`
   (≈102–104), поэтому после ошибки хука мир остаётся без карты. Это **не** то же, что ошибка `MapConfig::validate`:
   та случается до уничтожения старой карты, а здесь новые тела уже в мире. Нужно явно `map.destroy(world)`, обнулить
   `self.map`, `self.nav` и `map_body_state`; тест — после ошибки хука в мире не осталось тел карты, `nav` пуст. На JS-стороне проверить, как `GameCoreAdapter.createMap`
   и `RoundManager` обрабатывают исключение из `load_map` (сейчас оно возможно только от `validate`).
   `SimCtx` собирается так же, как в `step_fixed` (≈260).
3. Не вызывается при `deserialize_state`: игра восстанавливает своё состояние сама. Это нужно явно указать в doc-комментарии.
4. Тесты (фикстура-игра в `game.rs`, ≈709): хук вызывается на каждом `load_map`, в том числе на повторной загрузке
   той же карты; ошибка хука делает `load_map` неуспешным.

## 0.3 Доступ к телам карты

1. `core/src/physics.rs` (≈6–17): кодировать индекс тела карты в `user_data` над младшим байтом тега.
   **Публичные сигнатуры не менять**: `vimp-tanks` вызывает `encode_map_object()` (`core/src/body_tag.rs:88`).
   - новая `pub fn encode_map_object_at(index: usize) -> u128`;
   - старая `encode_map_object()` остаётся и возвращает `encode_map_object_at(0)` — то же значение, что сейчас
     (индекс 0 не меняет младший байт); `#[deprecated]` не ставить, чтобы не плодить предупреждения у игр;
   - `is_map_object` по-прежнему смотрит только младший байт;
   - добавить `pub fn map_object_index(user_data: u128) -> Option<usize>`;
   - `create_dynamic` использует `encode_map_object_at(i)`.
2. `GameMap`: `pub fn dynamic_handle(&self, index) -> Option<RigidBodyHandle>`,
   `pub fn dynamic_index_of(&self, world: &PhysicsWorld, handle) -> Option<usize>` (через `user_data`).
3. `step_dynamic_levels` (≈1685): пропускать тела с `!body.is_enabled()`. Иначе движок перезаписывает группы коллизий
   и уровень отключённого тела.
4. `dynamic_map_data` (≈1766): отключённое тело продолжает давать строку (позиция сохраняется), скорости не пишутся.
   Проверить тестом, что `world.bodies.get(handle)` возвращает отключённое тело.
5. Отдельной capability для 0.3 нет: пункты 0.3 и 0.4 объявляются одной — `map.bodyState` (см. 0.4.6).

## 0.4 Байт состояния тела

1. `core/src/config.rs` (≈205–250):
   - `FieldRole::State` (serde `"state"`).
   - Позиция: сразу после головы — `5`, если строка слоёная (`z`/`level` на 3/4), иначе `3`.
   - `BlockSchema::with_state()`.
   - `validate_level_roles` → обобщить до `validate_roles`: поле роли `state` имеет тип `u8`, стоит на ожидаемой позиции,
     `optionalFrom` (если задан) больше его индекса.
2. `core/src/game.rs`, `EngineSim`: поле `map_body_state: Vec<u8>`.
   - `load_map`: заполняется нулями по `dynamic_body_count` **до** вызова `on_map_loaded`.
   - `clear()` (≈373): очищается.
   - `serialize_state`/`deserialize_state` (≈436–457): входит в дамп.
3. `core/src/sim.rs`, `SimCtx` (≈31): `pub map_body_state: &'a mut [u8]`. Обновить все места, где собирается
   `SimCtx { ... }` (`grep -rn "SimCtx {" packages/engine/core`), включая тестовые.
4. **Сигнатуру `dynamic_map_data(world, with_levels, with_velocities)` не менять**: `vimp-tanks` вызывает её в
   `core/tests/sim.rs:709` и `:2310`.
   - новая `pub fn dynamic_map_data_with_state(world, with_levels, with_velocities, states: Option<&[u8]>)` с
     реальной логикой: при `Some` пишет `U8(state)` на позиции роли;
   - старая — тонкая обёртка: вызывает новую с `None` и даёт прежнюю раскладку бит-в-бит (закрепить тестом);
   - `build_snapshot_blocks` (≈329–356) вызывает `dynamic_map_data_with_state` с `Some(&self.map_body_state)`,
     если `schema.with_state()`, иначе с `None`.
5. JS-сторона: декодер и интерполятор управляются схемой, поэтому правок не требуют. Проверить:
   - `grep -rn "role" packages/engine/src/lib packages/engine/src/devtools` — нет ли JS-валидации ролей, которую нужно расширить;
   - правило контракта `d2`/`d3` — добавить проверку роли `state` (тип `u8`, позиция);
   - headless-раннер (`docs/en/debugging.md`, проверки инвариантов) — нет ли проверки, читающей раскладку строки тел.
6. Capability `map.bodyState`.

## 0.5 Тесты движка

- Rust: `game` проходит через `load_map` → `game_data()`; `validate` отклоняет массив; дамп сохраняет `game` и
  `map_body_state`; кодирование индекса в `user_data`; отключённое тело не меняет уровень и остаётся в строке;
  упаковка/распаковка строки с `state` на плоской и слоёной схемах; строка покоящегося тела содержит `state`;
  фикстура-игра меняет `ctx.map_body_state[i]`, и значение доходит до кадра.
- Горячий буфер клиента (`core/src/client/game.rs` ≈583–613): ширина записи тела по-прежнему `2 + fields.len()` из схемы.
  Сейчас это уже так, но нужен тест: схема `c1` с `state` (9 полей), покоящееся и движущееся тело, строки
  `render_rows` игры дополняются до ширины схемы. Там же проверить JS-чтение (`src/lib/reconstructHot.js`) на схеме с `state`.
- JS: `applyMapData` передаёт `game` в `set_map` и статическим частям; правило `e7`; роль `state` в правиле снапшота.
- Команды — из `CLAUDE.md` движка (тихие флаги).

## 0.6 Документация и релиз

- `docs/en|ru`: `core.md` (хук, доступ к телам, `map_body_state`), `network.md` (строка тела карты с `state`),
  `plugin-api.md` (поле `game`, роль `state`, capabilities), `configuration.md`, если затронута.
- `docs/ai/`: `05-wasm-core.md` (хук, `SimCtx`), `06-snapshot-protocol.md` (роль `state`), `07-maps-and-assets.md`
  (поле `game`), `10-pitfalls.md` (`game` не масштабируется; удалять тела карты нельзя — только отключать;
  лимит 255 тел).
- CHANGELOG движка: `Added` (поле `game`, хук, доступ к телам, роль `state`). Раздела `⚠️ Breaking` нет (см. «Правило
  совместимости API»). Единственная оговорка — новое публичное поле `SimCtx`: оно ломает только код, собирающий
  `SimCtx` литералом вне движка. Таких игр нет, но строку об этом записать в `Changed`.
- Версии: `vimp-engine` 0.34.0, `vimp-engine-core` 0.20.0 (0.x — минорное повышение при breaking).
  `ENGINE_API_VERSION` менять только если этого требует `docs/en/plugin-api.md#versioning`; ожидаемо не нужно,
  так как всё включается объявлением.
- Релиз по `docs/en/publishing.md` движка **выполняет пользователь** (скрипт коммитит). Исполнитель готовит изменения
  и сообщает, что нужен релиз.

## Правило совместимости API

Этап 0 только **добавляет** публичный API и не меняет существующие сигнатуры: `vimp-tanks` 0.20.3 должен собираться
против нового движка без правок. Уже проверены вызовы из плагина: `encode_map_object()`, `dynamic_map_data(...)`,
`is_map_object`. Новое поле `SimCtx` и метод `on_map_loaded` с реализацией по умолчанию плагин не ломают:
`SimCtx` плагин не собирает, а трейт он реализует без этого метода. Перед финалом прогнать
`grep -rn "vimp_engine_core::" core/src core/tests` в плагине и сверить каждую изменённую функцию движка.
Если изменение сигнатуры всё же неизбежно, это отдельное решение пользователя, а не молчаливое отступление от критерия.
Переход тестов плагина на новые функции (`encode_map_object_at`, `dynamic_map_data_with_state`) — этап 1, по желанию.

## Критерии готовности

- Все тесты и линт движка зелёные; `vimp-tanks` на текущей версии плагина собирается и проходит тесты против
  локального движка без изменений в плагине (обратная совместимость).
- Документация и CHANGELOG движка обновлены.
