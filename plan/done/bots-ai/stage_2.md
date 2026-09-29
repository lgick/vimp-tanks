# Этап 2 (T). Каркас ИИ: модули, профиль бота, `coreParams.bots`, отладка ✅ выполнен

**Репо:** `/Users/dmitry/Sites/my/vimp-tanks`. **Поведение ботов на этом этапе НЕ меняется**: только
структура, конфиг, профиль и отладочная база. Все существующие тесты (`core/src/bots/controller.rs`,
`core/tests/sim.rs`, JS) остаются зелёными без изменения сути проверок.

**Затрагиваемые файлы:**

- `core/src/bots/controller.rs` → `core/src/bots/brain.rs` (переименование) + новые модули в `core/src/bots/`;
- `core/src/bots/mod.rs`;
- `core/src/tanks.rs`: `BotView`, `on_ai_tick`, `spawn_scripted_actor`, новые поля `TanksSim`, отладочные
  методы;
- `core/src/tank.rs`: геттер `half_extents()`;
- `core/src/config.rs`: `BotRules`, `BotSkill`, `BotSkillParams`, валидация;
- `src/config/game.js`: `coreParams.bots`;
- `tests/config/game.test.js`, `tests/core/fixtures.test.js`, `tests/core/fixtures/downtown.json` (новый);
- `docs/{en,ru}/configuration.md`, `docs/{en,ru}/core.md`, `CHANGELOG.md`.

---

## 2.1. Локальный движок

Сделать шаги из README, раздел «Работа с локальным движком»: `.cargo/config.toml` с `[patch.crates-io]` и
`.cargo/` в `.git/info/exclude`. Проверка: `cargo test --workspace -q` собирается (API этапа 1 пока не
используется, поэтому сборка просто должна пройти).

## 2.2. Разбиение `controller.rs` на модули

1. `git mv core/src/bots/controller.rs core/src/bots/brain.rs`.
2. `core/src/bots/mod.rs`:
   ```rust
   //! ИИ ботов: мозг (машина состояний) и его части. Ввод бот генерирует
   //! теми же клавишами, что и игрок (`BotView::update_tank_keys`).
   pub mod brain;
   mod geom;
   mod keys;
   mod perception;
   pub mod profile;
   mod steering;
   #[cfg(test)]
   mod test_support;

   pub use brain::BotBrain;
   ```
   Модули `navigator`, `aim` и `team` появятся в этапах 3, 5 и 6.
3. `core/src/tanks.rs`: `use crate::bots::controller::BotBrain;` → `use crate::bots::BotBrain;`. Найти другие
   упоминания через `grep -rn "bots::controller" core docs`.
4. **`geom.rs`** — чистая математика, перенести из `brain.rs`: `dist_sq`, `rotate`, `normalize_angle`. Добавить
   `angle_of(v: [f32; 2]) -> f32` (`atan2(y, x)`), `dist(a, b) -> f32`, `lerp_angle` не нужен. Все `pub(crate)`.
   Юнит-тесты на `normalize_angle` (±π, 3π) и `angle_of`.
5. **`keys.rs`** — клавиши:
   ```rust
   #[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
   pub(crate) enum HeldKey { Forward, Back, Left, Right, GunLeft, GunRight }

   /// Удерживаемые клавиши бота. Событие в ядро уходит только при смене
   /// состояния (как у игрока: один keydown, один keyup).
   #[derive(Clone, Default, Serialize, Deserialize)]
   pub(crate) struct KeyPad {
       states: [bool; 6],
       /// Синхронизирован ли пульт с танком. После `deserialize` false:
       /// первым делом отпускаются ВСЕ клавиши принудительно, иначе клавиша,
       /// зажатая в дампе танка, никогда бы не отпустилась.
       #[serde(skip)]
       synced: bool,
   }
   ```
   Методы (`game: &mut BotView`, `id: u32`): `set(key, down)` (перенос `set_key_state`), `release_all`,
   `release_movement` (Forward/Back/Left/Right), `release_gun` (GunLeft/GunRight), `press_once(bit)` (перенос
   `press_one_shot`), `is_down(key)`, `force_release_all` (шлёт `"up"` всех шести бит без оглядки на `states` и
   ставит `synced = true`). Бит клавиши — перенос `key_bit`.
   В `BotBrain` поле `key_states: [bool; 6]` заменить на `#[serde(default)] keys: KeyPad`. В начале `update()`:
   `if !self.keys.synced { self.keys.force_release_all(game, self.game_id); }`.
6. **`steering.rs`** — перенести `avoid_obstacles` как есть (тело не менять). `pub(crate)`.
7. **`perception.rs`** — вынести проверку «можно ли стрелять» из `execute_aim_and_shoot`
   (`brain.rs`, бывшие стр. 570–643) в функцию:
   ```rust
   /// Что стоит на линии выстрела бота по цели. Правила — те же, что у хоста
   /// (`shot_height`, `shot_levels`): видимость по сетке уровня стрелка,
   /// пол под пулей на дистанции цели, «дорастает» ли цель до пули, насыпь рампы.
   #[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
   pub(crate) enum FireLine {
       Clear,
       /// Стена на сетке уровня стрелка (`has_obstacle_between_on`).
       Wall,
       /// Цель на уровне, которого пуля не касается, или пуля проходит над/под ней.
       OutOfReach,
       /// Насыпь рампы выше пули раньше цели.
       Embankment,
   }

   pub(crate) fn fire_line(game: &BotView<'_>, shooter_id: u32, my_level: u8, target_id: u32) -> FireLine
   ```
   Логика ровно прежняя: `!visible` → `Wall`; при слоях `!covered || !tank_reaches` → `OutOfReach`;
   `first_embankment_hit(..).t < dist` → `Embankment`; иначе `Clear`. В `execute_aim_and_shoot` заменить
   блок на `if fire_line(game, self.game_id, self.my_level, target) != FireLine::Clear { return; }`, оставив
   порядок остального кода. Этап 4 добавит варианты `Ally`, `Prop`, `OutOfRange`.
8. **`test_support.rs`** (`#[cfg(test)]`) — перенести из `mod tests` бывшего `controller.rs` (стр. 861–1041)
   фикстуру и фабрики: `TILE`, `levels()`, `model()`, `weapons()`, `panel()`, `key_bits()`, `Fixture`
   (`new`, `add_tank`, `view`), `brain_at`, `fires_within`. Всё `pub(crate)`. Тесты остаются в `brain.rs`
   (`mod tests` → `use crate::bots::test_support::*;`), тесты стрельбы через слои можно перенести в
   `perception.rs`. **Тела тестов не менять.**

## 2.3. Расширение `BotView` (`core/src/tanks.rs`, стр. ≈148)

Добавить поля (и заполнить их в `on_ai_tick` и в `Fixture::view()`):

```rust
/// Огонь по своим включён: своя бомба ранит и бота (`TanksSim::explode`).
pub friendly_fire: bool,
/// Модели танков (лимит башни `max_gun_angle`, размеры).
pub models: &'a IndexMap<String, ModelConfig>,
/// Правила ботов (`coreParams.bots`).
pub rules: &'a BotRules,
/// Правила уровней (урон падения — цена прыжка с обрыва).
pub level_rules: &'a LevelRules,
/// Сколько поисков маршрута ещё можно сделать на этом тике ИИ (общий на всех ботов).
pub route_budget: &'a mut u32,
```

Константа в `tanks.rs`: `const BOT_ROUTE_BUDGET_PER_TICK: u32 = 2;`. В `on_ai_tick` перед циклом завести
`let mut route_budget = BOT_ROUTE_BUDGET_PER_TICK;` и передавать `&mut route_budget` в каждый `BotView`. Бюджет
общий на тик: при 120 тиках/с это до 240 поисков в секунду на весь матч.

Методы `impl BotView` (все через `self.tanks` + `self.world.bodies`, `None`/нейтраль при отсутствии тела):

- `tank_half_extents(id) -> (f32, f32)` — через новый `Tank::half_extents()`;
- `tank_heading(id) -> f32` — `body.rotation().angle()`;
- `tank_linvel(id) -> [f32; 2]`;
- `tank_forward_speed(id) -> f32` — `linvel · (cos h, sin h)`;
- `gun_world_angle(id) -> f32` — `heading + tank.gun_rotation`;
- `max_gun_angle(id) -> f32` — `models[tank.model].max_gun_angle`, при отсутствии модели `1.4`;
- `tank_health(id) -> f64`, `tank_condition(id) -> u8`, `tank_team(id) -> Option<u8>`;
- `ammo(id, weapon_index) -> f64`;
- `tank_airborne(id) -> bool` (`level_state.airborne()`), `tank_on_ramp(id) -> bool` (`level_state.on_ramp()`);
- `tile_size() -> f32` — `levels.map(tile_size)`, иначе `nav.grid_step()`, иначе `32.0`.

`core/src/tank.rs`: `pub fn half_extents(&self) -> (f32, f32) { (self.width / 2.0, self.height / 2.0) }`
(ширина по оси корпуса — длина, высота — поперёк).

## 2.4. `coreParams.bots` и профиль бота

### 2.4.1. Rust (`core/src/config.rs`)

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BotSkill { Easy, #[default] Normal, Hard }

/// Параметры одного пресета сложности. Единицы — в комментариях полей.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BotSkillParams { /* поля — таблица ниже */ }

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BotPresets { pub easy: BotSkillParams, pub normal: BotSkillParams, pub hard: BotSkillParams }

/// Правила ботов (game.js coreParams.bots). Секция необязательна: без неё — `normal`.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BotRules {
    #[serde(default)]
    pub skill: BotSkill,
    /// Разброс «характера» между ботами: 0 — все одинаковые, 1 — ±50 % от пресета.
    #[serde(default = "default_bot_variance")]
    pub variance: f32,
    #[serde(default = "default_bot_presets")]
    pub presets: BotPresets,
}
```

`TanksConfig`: `#[serde(default)] pub bots: BotRules` (для `Default` у `BotRules` — `impl Default` через
`default_bot_variance()`/`default_bot_presets()`). `BotRules::params(&self) -> &BotSkillParams` выбирает пресет
по `skill`. `TanksConfig::validate()` вызывает `self.bots.validate()?`.

Поля `BotSkillParams` и значения пресетов. Одни и те же числа — в `default_bot_presets()` (Rust) и в `game.js`:

| Поле (JS)          | Rust                        | Ед.         | easy       | normal      | hard        | Где используется |
| ------------------ | --------------------------- | ----------- | ---------- | ----------- | ----------- | ---------------- |
| `reactionTime`     | `reaction_time: f32`        | с           | 0.55       | 0.35        | 0.2         | этап 5           |
| `aimError`         | `aim_error: f32`            | рад         | 0.3        | 0.18        | 0.09        | этап 5           |
| `aimSettleTime`    | `aim_settle_time: f32`      | с           | 1.1        | 0.7         | 0.4         | этап 5           |
| `aimTremor`        | `aim_tremor: f32`           | рад         | 0.05       | 0.03        | 0.012       | этап 5           |
| `fireTolerance`    | `fire_tolerance: f32`       | ×           | 1.8        | 1.25        | 0.9         | этап 5           |
| `burstShots`       | `burst_shots: [u8; 2]`      | шт          | [1, 2]     | [1, 3]      | [2, 3]      | этап 5           |
| `burstPause`       | `burst_pause: [f32; 2]`     | с           | [0.9, 1.6] | [0.55, 1.1] | [0.35, 0.7] | этап 5           |
| `shotInterval`     | `shot_interval: f32`        | с           | 0.4        | 0.3         | 0.22        | этап 5           |
| `radarInterval`    | `radar_interval: f32`       | с           | 2.0        | 1.4         | 0.9         | этап 4           |
| `radarNoise`       | `radar_noise: f32`          | ед.         | 40         | 25          | 12          | этап 4           |
| `preferredRange`   | `preferred_range: [f32; 2]` | ед.         | [140, 340] | [170, 420]  | [200, 480]  | этап 5           |
| `aggression`       | `aggression: f32`           | 0..1        | 0.35       | 0.5         | 0.65        | этапы 3, 5, 6    |
| `retreatHealth`    | `retreat_health: f32`       | HP          | 45         | 35          | 25          | этап 6           |
| `retreatAdvantage` | `retreat_advantage: f32`    | отношение   | 0.6        | 0.5         | 0.4         | этап 6           |
| `steerNoise`       | `steer_noise: f32`          | рад         | 0.1        | 0.05        | 0.02        | этап 3           |
| `edgeRisk`         | `edge_risk: f32`            | вероятность | 0.25       | 0.12        | 0.04        | этап 5           |
| `hesitation`       | `hesitation: f32`           | 1/с         | 0.08       | 0.04        | 0.01        | этап 4           |
| `panicFire`        | `panic_fire: f32`           | вероятность | 0.3        | 0.15        | 0.05        | этап 5           |

`default_bot_variance() = 0.3`.

`BotRules::validate()` — ошибки в стиле соседних `validate` (`"bots.presets.normal.aimError must be >= 0, got …"`):

- `variance ∈ [0, 1]`;
- для каждого пресета: времена (`reactionTime`, `aimSettleTime`, `shotInterval`, `radarInterval`) `> 0` и
  конечны; `aimError`, `aimTremor`, `radarNoise`, `steerNoise`, `hesitation` `≥ 0`; `fireTolerance > 0`;
  вероятности (`edgeRisk`, `panicFire`) и `aggression` ∈ `[0, 1]`; `retreatHealth ∈ [0, 100]`;
  `retreatAdvantage > 0`; у диапазонов `[a, b]` `0 ≤ a ≤ b`, у `burstShots` ещё `a ≥ 1`.

Rust-тесты в `config.rs` (модуль `tests`, по образцу соседних):

- `bots_section_is_optional`: конфиг без `bots` → `skill == Normal`, `variance == 0.3`;
- `bots_validate_rejects_bad_values`: по одному случаю на `variance 1.5`, `burstShots [0, 1]`,
  `preferredRange [300, 100]`, `edgeRisk 2`, `reactionTime 0`.

### 2.4.2. Профиль (`core/src/bots/profile.rs`, новый)

```rust
/// «Характер» конкретного бота: пресет сложности + индивидуальный разброс.
/// Разыгрывается один раз при создании бота и едет в дамп.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct BotProfile {
    pub skill: BotSkill,
    // те же поля, что у BotSkillParams, но уже конкретные числа
    ...
}

impl BotProfile {
    pub fn roll(rules: &BotRules, rng: &mut Rng) -> Self
}
```

Правила броска. Порядок полей фиксирован, как в таблице, и `rng` дёргается строго по нему, иначе рушится
детерминизм:

- скаляр `s` (времена, ошибки, шум, `fireTolerance`, `radarNoise`, `retreatAdvantage`):
  `s · (1 + variance · rng.range(−0.5, 0.5))`;
- `aggression`: `clamp(a + variance · rng.range(−0.3, 0.3), 0, 1)`;
- вероятности (`edgeRisk`, `panicFire`) и `hesitation`: множитель как у скаляра, затем `clamp(0, 1)`;
- диапазоны `[a, b]` (`preferredRange`, `burstPause`): оба конца на **один** общий множитель;
- `burstShots` не варьируется; `retreatHealth` — множитель, затем `clamp(5, 90)`.

Тесты в `profile.rs`: `variance 0` → профиль равен пресету; одинаковый seed → одинаковый профиль; при
`variance 1` все поля в допустимых границах на 200 бросках.

### 2.4.3. Подключение

- `TanksSim`: поле `bot_rules: BotRules` из `cfg.bots` (в `new`), передаётся в `BotView.rules`.
- `BotBrain::new(game_id, rng, rules: &BotRules)` → поле `profile: BotProfile::roll(rules, rng)`. Поле помечено
  `#[serde(default)]`, а `impl Default for BotProfile` даёт пресет `normal` без разброса: старый дамп без профиля
  обязан читаться (решение 6 README).
- `spawn_scripted_actor` (`tanks.rs:411`): `BotBrain::new(game_id, rng, &self.bot_rules)`.
- `Fixture` в `test_support.rs`: `BotRules::default()` + `brain_at` строит мозг с ним.

### 2.4.4. JS (`src/config/game.js`, внутри `coreParams`, после `props`)

```js
    // боты: пресет сложности + разброс «характера» между ботами. Числа —
    // стартовые, подбираются руками (docs/*/configuration.md → Bots)
    bots: {
      skill: 'normal', // 'easy' | 'normal' | 'hard'
      variance: 0.3, // 0 — все боты одинаковые, 1 — ±50 % от пресета
      presets: {
        easy: { reactionTime: 0.55, aimError: 0.3, /* … вся строка таблицы … */ },
        normal: { /* … */ },
        hard: { /* … */ },
      },
    },
```

Каждое поле — с коротким русским комментарием единицы (как в соседних секциях). Форматировать Prettier.

`tests/config/game.test.js` — новый `describe('gameConfig.coreParams.bots', …)`:

- `skill` ∈ `['easy', 'normal', 'hard']`, ключи `presets` — ровно эти три;
- у всех пресетов одинаковый набор ключей;
- диапазоны: `min ≤ max`, `burstShots` — целые `≥ 1`, вероятности и `aggression` в `[0, 1]`, `variance` в
  `[0, 1]`;
- монотонность сложности: `reactionTime` и `aimError` у `hard < normal < easy`.

## 2.5. Отладка и тестовая база

1. **Счётчики** (`brain.rs`):
   ```rust
   /// Счётчики поведения для тестов и дампов (едут в дамп вместе с мозгом).
   #[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
   pub struct BotStats {
       pub stuck_events: u32,
       pub unstuck_resolved: u32,
       pub replans: u32,
       pub route_failures: u32,
       pub shots_fired: u32,
       pub watchdog_resets: u32,
       pub mode_changes: u32,
   }
   ```
   Поле `#[serde(default)] pub stats: BotStats` в `BotBrain`. На этом этапе заполняется только `shots_fired`
   (там, где бот жмёт `fire`); остальные — в этапах 3–6.
2. **Снимок для тестов:**
   ```rust
   #[derive(Clone, Debug, Serialize)]
   pub struct BotDebug { pub mode: &'static str, pub target: Option<u32>, pub route_len: usize,
                         pub stats: BotStats, pub skill: BotSkill }
   ```
   `BotBrain::debug(&self) -> BotDebug` (`mode` — имя текущего `BotState`, в этапе 4 — `BotMode`) и
   `TanksSim::bot_debug(&self, game_id: u32) -> Option<BotDebug>` (`pub`, с комментарием «для тестов и
   отладки»). В интеграционных тестах доступен как `core.state().sim.bot_debug(id)`.
3. **Хук здоровья для тестов:** `#[doc(hidden)] pub fn debug_set_health(&mut self, game_id: u32, health: f64)`
   на `TanksSim`. Он ставит `tank.health` и пересчитывает `condition` по тем же порогам, что `take_damage`
   (`< 35` → 1, `< 70` → 2, иначе 3; `0` — не трогать, для смерти есть урон). Пригодится в этапе 6.
4. **Фикстура `downtown`.** `tests/core/fixtures/downtown.json` сериализуется тем же способом, что остальные
   фикстуры:
   ```bash
   node --input-type=module -e "import g from './src/config/game.js'; import { writeFileSync } from 'node:fs'; writeFileSync('tests/core/fixtures/downtown.json', JSON.stringify(g.maps.downtown));"
   ```
   В `tests/core/fixtures.test.js` дописать `'downtown'` в `it.each([...])`. В `core/tests/sim.rs` рядом с
   `overpass_map_json()` добавить `downtown_map_json()` через `include_str!`. Проверить, что
   `GameCore::load_map(downtown_map_json())` проходит, одним тестом `downtown_fixture_loads`.

## 2.6. Документация и журнал

- `docs/en/configuration.md` (+ `docs/ru/`): в таблицу «Core parameters» — строка `coreParams.bots` (кратко и
  ссылка на подраздел); новый подраздел **«Bots (`coreParams.bots`)»** с таблицей полей из 2.4.1 (поле,
  единица, easy/normal/hard, смысл одной фразой) и правилом разброса `variance`.
- `docs/en/core.md` (+ ru): дерево `bots/` в разделе Layout (стр. ≈44). Упоминания
  `bots::controller::avoid_obstacles` (стр. ≈731–734) → `bots::steering::avoid_obstacles`, упоминание
  `bots::controller` (стр. ≈981) → `bots::perception::fire_line`. Найти всё: `grep -rn "controller" docs/`.
- `CHANGELOG.md`, `## [Unreleased]` → `### Added`: «`coreParams.bots`: bot skill presets
  (`easy`/`normal`/`hard`) and a per-bot variance of reaction, aim, aggression and retreat thresholds.»

## 2.7. Проверка

```bash
cargo test --workspace -q
npx eslint . --quiet
npm run core:build:node && npm test -- --silent
```

Поведение не менялось, поэтому `bot_moves_on_map`, `bots_fight_each_other`, `scripted_bot_drives_onto_the_bridge`
и все 9 тестов бывшего `controller.rs` проходят без правок проверок. В отчёте напомнить про временный
`Cargo.lock`.
