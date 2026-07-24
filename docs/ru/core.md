# Rust-ядро игры (core/)

`vimp-tanks-core` (cdylib+rlib, `core/`) реализует симуляцию этой игры
поверх обобщённого движкового crate,
[`vimp-engine-core`](https://github.com/lgick/vimp-engine/blob/main/docs/ru/core.md)
(rlib, без wasm-bindgen): танки, оружие, боты и wasm-bindgen ABI
(`GameCore`/`ClientCore`) живут здесь. Это единственное место во всём
стеке, которое знает про танки, бомбы или hitscan — движковый crate
остаётся обобщённым. Ядро работает у браузерного хоста (`GameCore`, см.
движковый
[host.md](https://github.com/lgick/vimp-engine/blob/main/docs/ru/host.md))
**и у каждого клиента** (`ClientCore` — клиентская математика:
интерполяция, предикт, визуальный спавн выстрелов, распаковка кадров).

Обязательный набор методов обоих экспортируемых классов зафиксирован
движком как часть `ENGINE_API_VERSION` — см. движковый
[plugin-api.md](https://github.com/lgick/vimp-engine/blob/main/docs/ru/plugin-api.md#wasm-host-abi-v1).

**Граница ядра — симуляция, а не мета**: чат, голосования, статистика,
панель, оркестрация раундов, реестр участников и auth остаются на JS
движка. Мета управляет ядром командами и питается его событиями.

## Структура

```
Cargo.toml                        # + wasm-bindgen, зависимость на vimp-engine-core
src/
├── lib.rs                    # публичный ABI (wasm-bindgen): GameCore + ClientCore
├── body_tag.rs                # BodyTag (user_data тел игрока/выстрела) — только игра;
│                              #   резервирует байт тега 1 под тег статики карты движка
├── tanks.rs                   # TanksSim (impl GameSim), TanksGame, алиас GameState
├── tank.rs                    # Tank — движение, башня, здоровье/боезапас/кулдауны
├── motion.rs                  # общие mass-free формулы движения: один код для
│                              #   авторитетного пути (импульсы Rapier) и реплики предикта
├── bomb.rs                    # Bomb — тело снаряда (детонация живёт в tanks.rs)
├── config.rs                  # ModelConfig/WeaponConfig/TanksConfig/TanksClientConfig
├── bots/
│   └── controller.rs         # BotBrain — ИИ бота (ввод генерируется внутри ядра)
└── client/                    # клиентский режим ядра: TanksClient (impl GameClientDef)
    ├── mod.rs                 # TanksClient — связывает Predictor/ShotPredictor с
    │                          #   движковым generic ClientState<TanksClient>
    ├── predictor.rs           # реплика движения на motion.rs
    └── shot.rs                # гейты, дедуп, мир raycast
tests/
└── sim.rs                     # интеграционные сценарии симуляции (cargo test)
pkg-web/                       # сборка для браузера/Worker (генерируется, не в git)
pkg-node/                      # сборка для Node.js/Vitest (генерируется, не в git)
```

## Сборка

Требуется Rust-тулчейн (`rustup` + `wasm-pack`):

```bash
npm run core:build        # оба таргета (web + nodejs)
npm run core:build:web    # браузер/Worker → core/pkg-web/
npm run core:build:node   # Node.js (тесты) → core/pkg-node/
npm run core:test         # cargo test --workspace (crate этого репозитория)
```

`npm run build` включает `core:build:web`: WASM-бинарь нужен и Worker'у
хоста, и клиенту (единый ассет в сборке этого плагина, на который
указывает `GameManifest.entries.wasm`).

## ABI: команды, события, кадры

Экспортируются два класса: **`GameCore`** (авторитетная симуляция хоста)
и **`ClientCore`** (клиентский режим, см. ниже). Данные при инициализации
передаются JSON-строками формы `{engine: {...}, game: {...}}` — движковая
половина (`vimp_engine_core::config::EngineConfig`) обобщённая, игровая
(`TanksConfig`) парсится этим crate. Конфиг `GameCore` собирает
движковый `packages/engine/src/lib/coreConfig.js` (`buildCoreConfig()`),
карты экспортируются в JSON скриптом `npm run maps:export` (общий шаг с
раздачей карт без пересборки клиента).

Обвязка wasm-bindgen для обоих классов (механические 1:1-делегации в
движковый generic `EngineSim<G>`/`ClientState<G>`) генерируется двумя
макросами из `vimp-engine-core` — `export_game_core_abi!` и
`export_client_core_abi!` — единственным источником истины обязательного
набора методов. Этот crate зовёт каждый макрос рядом со своими
дополнительными методами (`try_fire`, `set_model`, `sync_panel`, кастомные
аргументы `spawn_actor`); `new` (парсинг конфига) и не-`#[wasm_bindgen]`
тестовые аксессоры остаются рукописными.

```js
import { buildCoreConfig } from '@vimp/engine/lib/coreConfig.js';
const { GameCore } = require('../core/pkg-node/vimp_tanks_core.js'); // nodejs-таргет

const core = new GameCore(JSON.stringify(buildCoreConfig({ seed: 42 })));
core.load_map(JSON.stringify(mapData)); // масштабирование происходит внутри ядра
```

### Команды

| Метод | Назначение |
| --- | --- |
| `new GameCore(config_json)` | мир Rapier, оружие, модели, клавиши, реестр снапшот-ключей |
| `load_map(map_json)` | тела карты + нав-граф ботов; масштаб — `scale` карты или `mapScale` конфига |
| `map_info()` | JSON: `setId`, `step`, размеры, масштабированные `respawns` |
| `spawn_actor(id, model, teamId, x, y, angle°)` | танк; эмитит `panelActive` + `panelSet(health)` |
| `remove_actor(id)` | удаление + null-маркер в следующем кадре |
| `reset_actor(id, teamId, x, y, angle°)` | респаун/смена команды (клавиши/газ сброшены, здоровье не тронуто) |
| `reset_all_vitals()` | здоровье/боезапас к дефолтам (новый раунд) |
| `spawn_scripted_actor(id, model, teamId, x, y, angle°)` / `remove_scripted_actor(id)` | танк + ИИ-контроллер внутри ядра |
| `apply_input(id, seq, action, name)` | ввод `'down'/'up'` + имя клавиши; `seq` подтверждается в player-блоке |
| `step(dt)` | фикс-шаги физики + ИИ ботов + пространственная сетка |
| `clear()` | полная очистка мира (смена карты) |
| `remove_players_and_shots()` | JSON-массив имён для очистки полотна клиентов |
| `players_data()` | JSON `{ model: { id: [x,y,angle,gun,vx,vy,engineLoad,condition,size,team] } }` для первого кадра (`FIRST_SHOT_DATA`); читает кеш, накопители не дренирует |
| `body_has_events()` | содержал ли последний `pack_body()` событийные блоки (трассеры/бомбы/взрывы/удаления); Worker хоста классифицирует канал WebRTC (события → meta, позиции → state) без изменения сигнатуры `pack_body` |
| `serialize_state()` / `deserialize_state(dump)` | дамп/восстановление симуляции для Worker handoff; перед дампом дренировать `pack_body()` |

### События (`take_events()`)

JSON-массив; буфер очищается при чтении. Стандартный движковый словарь
(Wasm Host ABI, `vimp_engine_core::events`) — `GameCoreAdapter._drainEvents`
(на стороне движка) роутит его в мету сам, без игрового посредника:
`panelSet`/`panelActive` → Panel (`field` — ключ схемы панели этой игры,
не завязан на конкретное оружие), `death` → RoundManager.reportKill,
`shake` → тряска камеры per-user в мете кадра. `custom` — единственный тип
вне словаря, несущий игровой смысл: адаптер дренирует его как есть в
`HostPlugin.onCoreEvent(data, services)` (эта игра его не использует —
`onCoreEvent` не задан):

```json
[
  { "type": "death", "victim": 2, "killer": 1 },
  { "type": "panelSet", "id": 2, "field": "health", "value": 60.0 },
  { "type": "panelSet", "id": 1, "field": "w1", "value": 199.0 },
  { "type": "panelActive", "id": 1, "field": "w2" },
  { "type": "shake", "id": 2, "intensity": 20, "duration": 200 }
]
```

Здоровье и боезапас — **источник истины в ядре**: JS-панель — лишь
проекция этих событий.

### Кадры (v3, байт-в-байт с распаковкой)

- `pack_body()` — broadcast-тело кадра, один раз на отправку; **дренирует**
  накопители событий снапшота (выстрелы/взрывы/удаления копятся в ядре
  между отправками — throttle частоты отправки, `SnapshotThrottle`,
  остаётся на стороне JS движка);
- `pack_frame(serverTime, seq, hasCamera, camX, camY, forceReset, shake, playerId)`
  — per-user кадр: заголовок + камера + player-блок (если `playerId >= 0`
  и танк существует) + копия тела; возвращает свою длину;
- `frame_ptr()` — указатель для zero-copy чтения в браузере:
  `new Uint8Array(wasm.memory.buffer, ptr, len)` (память отдаёт `init()`
  web-таргета);
- `frame_bytes()` — копия кадра (nodejs-таргет свою память наружу не
  отдаёт).

Кадры распаковывает клиентское ядро этого crate (`src/client/mod.rs` через
`vimp_engine_core::client::unpack`) — упаковщик и распаковщик живут в
движковом crate, поэтому расхождение раскладок исключено по построению;
формы закреплены round-trip-тестами (`#[cfg(test)]` в движковом
`unpack.rs`, а также `tests/core/core.test.js` и
`tests/core/clientCore.test.js` этого репозитория).

### Запросы состояния

`is_alive(id)`, `position_of(id)` (округлено до 2 знаков),
`last_input_seq(id)`, `alive_players()` (плоский массив `[id, teamId, x, y, ...]`).

## ClientCore — клиентский режим ядра

Второй wasm-bindgen класс из того же бинаря; живёт в главном потоке
вкладки клиента (у хоста-игрока рядом с Worker'ом работает второй инстанс
WASM). `ClientCore` оборачивает
`vimp_engine_core::client::game::ClientState<TanksClient>`: движковый
crate владеет сетевым буфером (`Interpolator`), очередью событийных
кадров и записью hot-буфера (`ClientState<G>`); `TanksClient`
(`src/client/mod.rs`) реализует трейт `GameClientDef` — оркестрацию
`Predictor`/`ShotPredictor`, отслеживание своего танка и predicted-хвост
рендер-оверлея. `export_client_core_abi!` генерирует движковый минимум
методов ниже (все, кроме
`set_model`/`try_fire`/`cycle_weapon`/`sync_panel`, которые остаются
рукописными в `src/lib.rs`, поскольку их форма игровая; внутри трейта эти
хуки носят нейтральные имена — `try_action`/`cycle_item`). Форма трейта
проверена фикстурным вторым клиентом (`TestClient`, тесты в движковом
`packages/engine/core/src/client/game.rs`) ещё до появления настоящей
второй игры. Его конфиг собирает движковый
`packages/engine/src/lib/clientCoreConfig.js` из секций
`prediction`/`interpolation` CONFIG_DATA плюс бандловый реестр
`opcodes.js`; поле `timeStepMs` фиксирует единицы (мс — в отличие от
`CoreConfig.timeStep` в секундах).

| Метод | Назначение |
| --- | --- |
| `new ClientCore(config_json)` | модели/оружие/клавиши + реестр снапшот-ключей + интерполяция |
| `push_frame(bytes, localNow)` | распаковывает кадр, вставляет в буфер по `seq` (+дедуп/опоздавшие), реконсилирует предикт по player-блоку; `false` — кадр отброшен (порт/версия/повреждён) |
| `my_game_id()` / `offset()` | свой id из player-блока (−1) / EMA-оценка `serverTime − localNow` (NaN) |
| `sample(localNow)` | весь рендер-тик: выдача пересечённых кадров (фильтр дублей → JSON-очередь), интерполяция, шаг предикта; возвращает длину hot-буфера |
| `hot_ptr()` / `hot_values()` | zero-copy указатель на hot-буфер (web) / копия (nodejs) |
| `take_frames()` | событийные кадры JSON-строкой `[{game, camera}, …]` (форма `applyShot`); очередь очищается |
| `apply_input(action, key, localNow)` | записывает ввод в историю предикта |
| `try_fire(localNow)` | локальный визуальный выстрел; гейты (кулдаун/патроны/pending-бомба/жив/активен) внутри; возвращает JSON спавна либо `undefined` |
| `cycle_weapon(back)` | локальное переключение оружия (авторитетное подтверждение приходит через панель) |
| `set_model(name)` / `set_active(bool)` / `set_map(json)` / `sync_panel(json)` / `reset()` | зеркала портов клиента: авторизация, KEYSET, MAP_DATA, PANEL_DATA, CLEAR |
| `decode_frame(bytes)` | чистая распаковка v3 → JSON-форма кадра (тесты/харнесс); `'null'` при расхождении версии |

**Раскладка hot-буфера** (плоский, переиспользуемый Float32):
`[0]` — флаги (`HOT_FLAGS` в движковом `opcodes.js`: game/camera/
predicted/frames), `[1..2]` — камера x/y (уже разрешённая ядром:
предсказанная позиция либо интерполированная), `[3]` — количество танков
N, далее N×12 (`keyId, gameId, x, y, angle, gun, vx, vy, engineLoad,
condition, size, teamId`), затем M динамики × 5 (`keyId, index, x, y,
angle`); predicted-запись своего танка идёт последней. Этот хвост движок
пишет дословно из `RenderOverlay.tail`, которую собирает
`GameClientDef::render_overlay` — движку известны только камера
(`RenderOverlay.camera`) и флаг наличия, но не раскладка полей хвоста
(`TanksClient::render_overlay` собирает её как ту же форму из 12
значений). `keyId` — числовые id из снапшот-схемы этой игры
(`src/config/snapshot.js`); клиентский JS читает записи generic-разбором
по той же схеме (ширина записи = 2 служебных поля + количество `fields`
ключа).

**motion.rs** — общие mass-free формулы тика движения (башня, дроссель,
боковое сцепление, тяга/торможение, нагрузка двигателя, поворот):
авторитетный путь (`Tank::update`) домножает их на массу/инерцию для
импульсов Rapier, а реплика предикта интегрирует вручную (позиция
скоростью *до* демпфирования → `v *= 1/(1+dt·d)` — эмпирически подобранный
порядок Rapier). Реплика не может разойтись с авторитетным путём по
формулам; паритет интеграции закрепляют cargo-тесты
`client::predictor::parity` (6 сценариев).
⚠️ **Любая правка движения в ядре или `models.js` требует прогона
`npm run core:test`.**

## Детерминизм

- `rapier2d` собирается с `enhanced-determinism` (бит-в-бит на всех
  платформах при одинаковом вводе);
- вся случайность (разброс оружия, решения ботов) идёт через встроенный
  движковый SplitMix64 PRNG с сидом из конфига (`seed`), без
  `Math.random`;
- handoff-дамп восстанавливает симуляцию бит-в-бит (закреплено тестами
  `state_dump_restores_identical_simulation` и в Rust, и в JS).

## Тесты

| Слой | Где | Что покрывает |
| --- | --- | --- |
| Rust unit | `core/src/*` (`#[cfg(test)]`) | BodyTag, раскладка кадра; предикт (replay/visualError/freeze), выстрелы (гейты/дедуп/RTT) |
| Паритет предикта | `core/src/client/predictor.rs` (`mod parity`) | реплика движения предикта против Rapier-мира (6 сценариев) — **обязателен к прогону при любой правке движения в ядре или `models.js`** |
| Rust интеграция | `core/tests/sim.rs` | сценарии симуляции: вождение, стены, hitscan-килы, friendly fire, бомба, смена оружия, боты (патруль и бой), очистки, handoff |
| JS↔WASM харнесс | `tests/core/core.test.js` + `tests/core/clientCore.test.js` | ABI на реальном конфиге/картах, round-trip кадров через `decode_frame`; e2e клиентского ядра: интерполяция, реордер seq, сходимость предикта с ядром на реальном конфиге, try_fire и подавление дублей |

Тесты `tests/core/` входят в `npm test` и **пропускаются**, если
`core/pkg-node/` не собран (JS-разработка возможна без Rust-тулчейна). CI
собирает ядро и гоняет оба слоя тестов.

## Известные технические особенности

- **Свежесозданное тело попадает в broad phase только на первом шаге
  мира**: выстрел в тот же тик, что и спавн, «промахивается» мимо цели
  (тесты используют прогревочный `step`). В реальных сценариях (спавн в
  начале раунда) не проявляется.
- `remove_actor` сам ставит null-маркер удаления в следующем кадре.

---

[← Предыдущая: Конфигурация](configuration.md) · [Следующая: Расширение →](extending.md)
