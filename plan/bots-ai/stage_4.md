# Этап 4 (T). Восприятие, выбор цели, новая машина состояний ✅ выполнен

**Репо:** `/Users/dmitry/Sites/my/vimp-tanks` (локальный движок — README).

**Цель.**

- Бот **знает**, где враги: как игрок по радару, с задержкой и неточностью. **Видит** их по линии видимости.
  Помнит, кто в него целится и кто его ранил.
- Цель выбирается по дистанции маршрута, видимости и угрозе.
- Проверка «можно ли стрелять» учитывает союзников и пропы на линии огня.
- Старая машина `BotState` (`Patrolling/Navigating/Attacking/Searching/…`) заменяется на `BotMode` (`Dead`,
  `Roam`, `Hunt`, `Engage`). Режимы `Retreat`/`Hold`/`Regroup` добавит этап 6.

**Файлы:** `core/src/bots/perception.rs`, `core/src/bots/brain.rs`, `core/src/bots/mod.rs`,
`core/tests/sim.rs`, `docs/{en,ru}/gameplay.md`, `docs/{en,ru}/core.md`, `CHANGELOG.md`.

---

## 4.1. Линия огня: союзники, пропы, дальность (`perception.rs`)

Расширить `FireLine` (этап 2):

```rust
pub(crate) enum FireLine {
    Clear,
    Wall,
    OutOfReach,
    Embankment,
    /// Союзный танк раньше цели: hitscan остановится на нём (`process_hitscan`).
    Ally(u32),
    /// Ящик/бочка/забор раньше цели.
    Prop,
    /// Дальше дальности оружия (`WeaponConfig::range` текущего оружия, для `w1` — 1500).
    OutOfRange,
}
```

Порядок проверок в `fire_line(game, shooter_id, my_level, target_id)`:

1. `dist > range` → `OutOfRange`. Дальность берётся у `w1` (`game.weapon_index("w1")`), а не у текущего оружия:
   бомба дальности не имеет.
2. Прежние проверки этапа 2 (`Wall`, `OutOfReach`, `Embankment`).
3. **Новое — физический луч**, только когда цель на **уровне стрелка** (`game.tank_level(target) == my_level`).
   Межуровневые выстрелы по-прежнему судят только правила уровней: сегменты `air` пролетают над пропами, и
   повторять это здесь незачем.
   - начало — `tank.muzzle_position(body)` (`core/src/tank.rs:422`), направление — к центру цели, длина —
     `dist(дуло, цель) + half_length цели`;
   - фильтр как в `TanksSim::process_hitscan` (`core/src/tanks.rs:1506–1516`): `exclude_sensors`,
     `exclude_rigid_body(тело стрелка)`, на слоёной карте
     `groups(levels_interaction_on_ramp(level_group(my_level)))`;
   - `game.world.cast_ray(&ray, 1.0, true, filter)` → коллайдер → `parent` → тело →
     `BodyTag::decode(body.user_data)` (`crate::body_tag`):
     - `Player { game_id, team_id }`, где `game_id == target` → `Clear`; `team_id == своя команда` →
       `Ally(game_id)`; другой враг → `Clear` (попасть в другого врага не жалко);
     - `vimp_engine_core::physics::is_map_object(body.user_data)` → `Prop`;
     - всё остальное (статика карты) → `Wall`;
   - попаданий нет → `Clear`.

## 4.2. Восприятие (`perception.rs`)

```rust
/// Сведения бота о враге.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub(crate) struct Contact {
    pub id: u32,
    pub pos: [f32; 2],
    pub level: u8,
    /// Скорость известна только у видимого врага; по радару — ноль.
    pub vel: [f32; 2],
    /// Состояние корпуса (3/2/1, `Tank::condition`): его видно на корпусе. У невидимого — последнее увиденное.
    pub condition: u8,
    pub updated_at: f32,
    pub seen_at: Option<f32>,
    pub visible: bool,
    pub fire_line: FireLine,
    pub aiming_at_me: bool,
}

#[derive(Clone, Default, Serialize, Deserialize)]
pub(crate) struct Perception {
    pub contacts: Vec<Contact>,   // отсортированы по id
    radar_timer: f32,
    last_health: f64,
    /// Недавний урон: спадает экспонентой с постоянной 3 с.
    pub damage_recent: f32,
    pub last_damage_at: Option<f32>,
    pub last_attacker: Option<u32>,
}
```

Часы: в `BotBrain` поле `#[serde(default)] clock: f32`, `+= dt` в начале каждого `update()` (и у мёртвого).

`Perception::update(&mut self, game: &mut BotView, me: &SelfState, profile: &BotProfile, clock, dt)` — раз в
тик решений (0.1 с, как `make_decision`):

1. **Кандидаты** — все танки из `game.tanks` другой команды, живые (`is_alive`) и с телом. Порядок
   детерминирован (`IndexMap`). Контакты танков, которых больше нет или которые мертвы, удалить: гибель видна.
2. **Видимость** (константа `VIEW_RANGE = 900.0`): `visible = dist ≤ VIEW_RANGE && (!nav.has_obstacle_between_on(
my_level, me, them) || !nav.has_obstacle_between_on(their_level, me, them))`. Вторая проверка — «взгляд с
   моста вниз»: у сетки верхнего уровня клетки без пола непроходимы и непрозрачны, и без неё бот на мосту не
   видел бы никого внизу. Сквозь плиту игрок тоже видит (see-through рендер).
3. **Видимый:** `pos` — точная позиция, `vel` — `tank_linvel`, `condition` — точное, `level` — точный,
   `seen_at = updated_at = clock`, `fire_line = fire_line(...)`,
   `aiming_at_me = |normalize_angle(gun_world_angle(врага) − angle_of(me − враг))| < 0.15` и прямая видимость
   на уровне бота.
4. **Радар** (для невидимых): `radar_timer -= dt`. На `≤ 0` таймер ставится в
   `profile.radar_interval · rng.range(0.8, 1.2)`, и **всем** невидимым врагам: `pos = true_pos +
(rng.range(−n, n), rng.range(−n, n))`, где `n = profile.radar_noise`, `level` — истинный, `vel = 0`,
   `updated_at = clock`, `visible = false`, `fire_line = Wall`, `aiming_at_me = false`. Новый враг, которого
   бот ещё не знал, появляется тоже только на радарном тике. Первый тик после рождения мозга —
   `radar_timer = 0`, то есть радар срабатывает сразу.
5. **Урон:** `h = tank_health(me)`. Если `h < last_health`, то `damage_recent += last_health − h`,
   `last_damage_at = clock`, `last_attacker` — ближайший видимый контакт с `aiming_at_me`, иначе ближайший
   видимый, иначе ближайший вообще. Затем `last_health = h`. Если `h > last_health` (респаун) — просто
   `last_health = h`. Спад: `damage_recent *= exp(−dt / 3.0)` (dt — время с прошлого обновления).
6. `rng` дёргается только на радарном тике, строго по контактам в порядке `id`.

Хелперы: `contact(id) -> Option<&Contact>`, `visible_contacts()`, `threats_near(pos, radius)`.

## 4.3. Выбор цели (`brain.rs`, `fn choose_target`)

Вызывать раз в 0.3 с (таймер `target_timer`), а также сразу, если цель умерла или пропала, и в момент нового
урона. Кандидаты — `perception.contacts`.

Оценка (меньше — лучше):

```
d        = дистанция маршрута, если есть в кэше, иначе прямая · 1.3
score    = d
         · (если другой уровень: 1.25)
         · (видим и fire_line == Clear: 0.6; видим, но не Clear: 0.85)
         · (aiming_at_me или last_attacker == id и урон был < 2 с назад: 0.5)
         · (condition 1: 0.8; condition 2: 0.9)
         · (фокус команды: 0.75 — появится в этапе 6)
текущая цель: score · 0.8 (гистерезис)
```

- Держать цель не меньше 1.5 с (`target_since`), кроме случаев: цель умерла или пропала; новый кандидат —
  `last_attacker` с уроном < 1 с назад.
- **Кэш стоимости маршрута:** `route_costs: Vec<(u32, f32, f32)>` (id, стоимость, clock). Обновлять только для
  трёх ближайших по прямой кандидатов, если запись старше 2 с. Каждый запрос `find_route` — 1 единица
  `route_budget`; нет бюджета — оценка по прямой. Запрос тот же, что у навигатора (`NavParams`), `start` — бот,
  `end` — `PathPoint` контакта.
- Равные оценки → меньший `id`.
- Существующий тест `bot_prefers_the_enemy_on_its_level` обязан пройти: множитель 1.25 это даёт. Если в его
  раскладе не даёт, поправить раскладку теста так, чтобы проверялась та же суть.

## 4.4. Новая машина состояний (`brain.rs`)

```rust
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum BotMode { Dead, #[default] Roam, Hunt, Engage }
```

- В `BotBrain` поле `state: BotState` заменить на `#[serde(default)] pub mode: BotMode`. `BotState` удалить.
  Неизвестное поле `state` старого дампа serde пропустит (`deny_unknown_fields` у `BotBrain` нет: проверить).
- Удалить `find_closest_enemy`, `last_known_position`/`last_known_level`, `set_new_patrol_target`, константы
  `MIN_TARGET_DISTANCE`/`MAX_FIRING_DISTANCE`/`TARGET_SCAN_INTERVAL`, если они больше нигде не нужны.
  `TanksSim::rebuild_spatial_grid` остаётся: сетка нужна «расступиться с союзником» (этап 3) и движку.
- Поля: `mode_since: f32`, `target: Option<u32>`, `target_since: f32`, `target_timer: f32`,
  `home: Option<PathPoint>`, `hesitate_until: f32`, `lost_sight_since: Option<f32>`,
  `unclear_since: Option<f32>`, все `#[serde(default)]`.
- `fn set_mode(&mut self, m, clock)`: при смене — `mode_since = clock`, `stats.mode_changes += 1`. Минимальная
  выдержка 0.5 с, кроме переходов в `Dead` и из `Dead`.

Переходы (тик решений 0.1 с):

| Из              | Условие                                                              | В                                                                               |
| --------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| любой           | нет тела или танк мёртв                                              | `Dead` (отпустить все клавиши, `nav.clear()`, `unstuck = None`)                 |
| `Dead`          | танк жив                                                             | `Roam`, `home = PathPoint { позиция, уровень }`, все контакты `visible = false` |
| `Roam`          | есть контакты                                                        | `Hunt`                                                                          |
| `Hunt`          | цель видима, `fire_line == Clear`, `dist ≤ preferred_range[1] · 1.3` | `Engage`                                                                        |
| `Hunt`/`Engage` | контактов нет                                                        | `Roam`                                                                          |
| `Engage`        | цель не видна дольше 1.0 с **или** `fire_line != Clear` дольше 1.5 с | `Hunt`                                                                          |

Поведение режимов:

- **`Roam`** — цель навигатора `random_point_where(rng, None, hull_width)`. Прибыл или недостижимо — новая.
  (С радаром `Roam` бывает, только когда живых врагов нет.)
- **`Hunt`** — цель навигатора — контакт цели (`moving = true`). Для невидимого это радарная позиция с шумом:
  бот едет «туда, где видел на радаре», как человек. **Колебание:** если цель не видна и
  `rng.next_f32() < profile.hesitation · 0.1` (вероятность за тик решений), то
  `hesitate_until = clock + rng.range(0.3, 0.8)`: газ отпущен, бот «осматривается». Башню поворачивать к
  радарной позиции цели (без стрельбы) — так делает и человек.
- **`Engage`** (упрощённо; полный бой — этап 5): прежнее поведение `Attacking` на новых кирпичах. Дальше
  `preferred_range[1]` — навигатор к цели. Ближе `preferred_range[0]` — стоп. Между ними — прежний стрейф после
  выстрела (`calculate_new_combat_position` через вождение этапа 3). Стрельба — прежний
  `execute_aim_and_shoot`, но стреляет только при `fire_line == Clear`. `Ally` и `Prop` огонь запрещают.
- Сторож (этап 3): «намеренная остановка» — это `Engage` с видимой целью или `hesitate_until > clock`.

## 4.5. Тесты

**Юнит** (`perception.rs`, `brain.rs`; `Fixture` из `test_support.rs`; мир Fixture можно двигать
`body.set_translation`):

- `radar_updates_on_interval_with_noise`: враг за стеной (невидим), профиль `radar_interval = 1.0`,
  `radar_noise = 20`. Сразу после первого обновления контакт есть и `|pos − true| ≤ 20·√2`. Враг сдвинут на
  100 ед.: через 0.5 с позиция контакта прежняя, через 1.2 с новая.
- `visible_contact_is_exact`: враг в прямой видимости — позиция точная, `seen_at == clock`.
- `dead_enemy_is_forgotten`: убитый (`condition = 0`) пропадает из контактов на следующем тике.
- `fire_line_reports_ally`: бот, союзник и враг на одной линии и уровне → `Ally(id союзника)`, и
  `fires_within` за 60 тиков возвращает false.
- `fire_line_out_of_range`: враг дальше 1500 → `OutOfRange`.
- `target_prefers_the_attacker`, `target_prefers_visible_over_closer_hidden`, `target_hysteresis_keeps_current`.
- `damage_sets_last_attacker`: уменьшить `health` своего танка, и на следующем тике `last_attacker` — видимый
  враг, целящийся в бота.
- Старые тесты стрельбы через уровни (`bot_holds_fire_through_the_slab`, `…_on_the_open_edge`,
  `bot_fires_at_a_ground_enemy_under_the_edge`, `…_high_on_the_ramp`, `…_below_its_bullet`,
  `bot_fires_at_a_tank_at_the_foot_of_the_ramp`) переписать через `BotMode`/`Engage`. Суть «стреляет /
  не стреляет» сохраняется, плюс добавить проверку ожидаемого `FireLine`.

**Интеграционные** (`core/tests/sim.rs`):

- `bot_finds_an_enemy_across_the_map`: арена 60×20 тайлов (`step` 32, `scale` 1, ширина 1920), пара стенок
  посередине. Враг (`spawn_actor`, без ИИ) у дальнего края, дальше 1500 от бота. За 40 с враг ранен. Старый бот
  его вообще не «знал».
- `bot_does_not_waste_shots_into_a_crate`: `map_with_box_json(x, y)` (есть в `sim.rs`). Ящик ровно между ботом
  и врагом на одной прямой, вплотную к врагу. Бот в 300 ед. от врага, это внутри `preferredRange`, так что
  наезжать на ящик ему незачем. За 3 с ящик не сдвинулся: `dynamic_box_x` до и после, допуск 0.5. Импульс
  hitscan сдвинул бы его, значит пули в ящик не летели.
- `bot_moves_on_map` и `bots_fight_each_other` — зелёные.
- `bots_do_not_stall_on_downtown` (этап 3) — заменить `"Attacking"` на `"Engage"`.

## 4.6. Документация и журнал

- `docs/en/gameplay.md` (+ ru), «Bots». Как бот узнаёт о врагах:
  - как игрок по радару: позиции всех врагов с задержкой (`radarInterval`) и ошибкой (`radarNoise`);
  - точно — только видимых;
  - помнит, кто в него целится и кто его ранил.

  Как выбирает цель: маршрут, видимость, угроза, повреждённость, свой уровень. Не стреляет, если на линии
  огня союзник или ящик.

- `docs/en/core.md` (+ ru): `perception.rs` (`FireLine`, `Contact`, радар), `BotMode` и таблица переходов.
- `CHANGELOG.md`, `## [Unreleased]`:
  - `### Changed` — «Bots know where enemies are the way a player does from the radar — with a delay and an
    error — instead of only seeing enemies within about 600 units; they pick a target by route distance,
    visibility and threat.»
  - `### Fixed` — «Bots no longer fire into a teammate or a crate standing in the line of fire.»

## 4.7. Проверка

```bash
cargo test --workspace -q
npx eslint . --quiet
npm run core:build:node && npm test -- --silent
npm run build && npm run sim:scenarios
```
