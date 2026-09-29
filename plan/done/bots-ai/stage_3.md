# Этап 3 (T). Навигатор и вождение: маршрут, рампы, обрывы, объезд, застревание ✅ выполнен

**Репо:** `/Users/dmitry/Sites/my/vimp-tanks`. Нужен локальный движок с API этапа 1 (README, «Работа с локальным
движком»).

**Цель.** Бот всегда едет **по маршруту**, который проходит корпус: к врагу за стеной, на мост через рампу, вниз
с моста. Упёршись, он сдаёт назад, разворачивается и перестраивает путь, а не стоит. Машина состояний пока
старая (`BotState`), новая появится в этапе 4. Здесь заменяется только «как ехать».

**Файлы:** `core/src/bots/navigator.rs` (новый), `core/src/bots/steering.rs`, `core/src/bots/brain.rs`,
`core/src/bots/mod.rs` (`mod navigator;`), `core/tests/sim.rs`, `docs/{en,ru}/gameplay.md`,
`docs/{en,ru}/core.md`, `CHANGELOG.md`.

Импорты из движка: `vimp_engine_core::nav::navigation::{PathPoint, PathQuery, PenaltyZone, Route, RouteLeg,
LegKind}`.

---

## 3.1. Навигатор (`navigator.rs`)

```rust
/// Временная метка «здесь застревали»: штрафная зона в запросах маршрута
/// этого бота, пока не истечёт `ttl`.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub(crate) struct AvoidMark { level: u8, center: [f32; 2], radius: f32, ttl: f32 }

/// Результат шага навигатора.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum NavStatus { Idle, Moving, Arrived, Waiting, Unreachable }

#[derive(Clone, Default, Serialize, Deserialize)]
pub(crate) struct Navigator {
    goal: Option<PathPoint>,
    /// Цель — движущийся танк: маршрут перестраивается по времени.
    moving_goal: bool,
    legs: Vec<RouteLeg>,
    index: usize,
    route_age: f32,
    /// Лучшая (минимальная) дистанция до текущей точки и сколько она не улучшалась.
    best_dist: f32,
    stall_time: f32,
    lookahead_timer: f32,
    failures: u8,
    retry_timer: f32,
    pending: bool,
    avoid: Vec<AvoidMark>,
}
```

Параметры маршрута, которые мозг передаёт навигатору каждый тик:

```rust
pub(crate) struct NavParams {
    pub hull_width: f32,        // 2 · half_extents.1
    pub hull_half_length: f32,  // half_extents.0
    pub tile: f32,              // game.tile_size()
    pub ledge_cost_scale: f32,  // из мозга (3.5)
}
```

Методы:

1. `set_goal(&mut self, goal: PathPoint, moving: bool)`. Если цели не было, или она сдвинулась больше чем на
   `3·tile`, или сменила уровень, поставить `pending = true` и запомнить цель. Иначе обновить `goal.pos` без
   перестроения: мелкие сдвиги цели маршрут не ломают, последняя точка маршрута всё равно подтягивается к
   цели (п. 5).
2. `clear()` — сброс всего, кроме `avoid`.
3. `tick(&mut self, dt)` — таймеры: `route_age += dt`, `retry_timer -= dt`, `lookahead_timer -= dt`, `ttl`
   меток. Истёкшие метки удалить.
4. `needs_replan(&self, me: PathPoint, grounded: bool) -> bool` — **любое** из условий:
   - `pending`;
   - `moving_goal && route_age > 2.0`;
   - `grounded` и уровень бота не совпадает ни с уровнем текущей точки, ни с уровнем предыдущей (бот
     упал/заехал не туда), а `legs` не пуст;
   - отклонение: бот дальше `3·tile` от отрезка «предыдущая точка → текущая» (для первой точки предыдущая —
     позиция на момент построения, хранить `origin: [f32; 2]`);
   - `stall_time > 1.5` — дистанция до текущей точки 1.5 с не улучшалась хотя бы на 4 ед. Перед перестроением
     добавить `AvoidMark { center: текущая точка, radius: 1.5·tile, ttl: 8.0 }`.
     `retry_timer > 0` подавляет перестроение (кроме `pending` при смене цели).
5. `plan(&mut self, game: &mut BotView, me: PathPoint, params: &NavParams, extra: &[PenaltyZone],
stats: &mut BotStats) -> NavStatus`:
   - нет `goal` → `Idle`;
   - `*game.route_budget == 0` → оставить старый маршрут, `pending = true`, вернуть `Waiting`. Иначе
     уменьшить бюджет на 1;
   - запрос: `PathQuery { min_width: params.hull_width, comfort_clearance: params.hull_half_length +
0.5·tile, narrow_cost: 1.5, ledge_cost_scale: params.ledge_cost_scale, penalties: &zones }`, где `zones`
     — `avoid` (стоимость `6.0` за единицу) плюс `extra` (зоны мозга, этап 6);
   - цепочка попыток, **каждая** стоит 1 бюджета (если бюджета нет — `Waiting`, продолжить на следующем тике):
     (а) полный запрос; (б) `min_width = 0`; (в) цель прижать к проходимой клетке:
     `nearest_walkable_on(goal.level, goal.pos, hull_width, 4·tile)` и повторить (а); (г) прижать и
     **старт**: `s = nearest_walkable_on(me.level, me.pos, hull_width, 4·tile)`, маршрут `s → цель`, а в его
     начало добавить участок `RouteLeg { point: s, kind: Walk }`. `find_route` возвращает `None`, если у
     точки нет видимого узла (этап 1, 1.9 п. 3): например, бота затолкало в угол или карман;
   - успех: `legs = route.legs`, `index = 0`, `route_age = 0`, `failures = 0`, `pending = false`,
     `origin = me.pos`, `best_dist = ∞`, `stall_time = 0`, `stats.replans += 1` → `Moving`;
   - провал: `failures += 1`, `stats.route_failures += 1`, `retry_timer = 1.0`, `pending = false` →
     `Unreachable`.
6. `follow(&mut self, game: &BotView, me: PathPoint, params: &NavParams, dt) -> Option<Waypoint>`, где
   ```rust
   pub(crate) struct Waypoint { pub pos: [f32; 2], pub level: u8, pub kind: LegKind,
                                /// Точка, откуда бот въезжает в этот участок (для рамп).
                                pub from: [f32; 2], pub is_last: bool }
   ```
   - `index ≥ legs.len()` → `None`, статус `Arrived` (метод `arrived()`);
   - **прогресс:** `d = dist(me, текущая точка)`; если `d < best_dist − 4` → `best_dist = d`, `stall_time = 0`,
     иначе `stall_time += dt`;
   - **радиус «дошёл»**: `Walk`, за которым идёт `Ramp` (это подножие) — `0.5·tile`; сам `Ramp` (вершина) —
     `1.0·tile`; `Ledge` — точка считается пройденной, когда уровень бота равен уровню точки и он на опоре;
     прочие `Walk` — `max(0.6·tile, 10.0)`; последняя точка — `max(0.8·tile, 12.0)`;
   - дошёл → `index += 1`, сброс `best_dist`/`stall_time`;
   - **сглаживание** (срезать лишние узлы) раз в 0.2 с (`lookahead_timer`): для `j` от `index + 4` вниз до
     `index + 1` (в пределах маршрута), если все участки `index..=j` — `Walk` на уровне бота и
     `nav.has_clear_corridor_on(level, me.pos, legs[j].point.pos, hull_width / 2 + 1.0)`, то `index = j` и
     выйти. Участки `Ramp` и `Ledge` и точку перед `Ramp` **никогда** не пропускать;
   - вернуть `Waypoint` текущей точки (`from` — предыдущая точка или `origin`).
7. `fail_goal(&mut self)` — забыть цель и маршрут (мозг выберет новую).

Навигатор хранится в `BotBrain` как `#[serde(default)] nav: Navigator` (он едет в дамп, чтобы после миграции
хоста бот продолжил путь).

## 3.2. Вождение (`steering.rs`)

### 3.2.1. Чистое решение «какие клавиши» — тестируемая функция без мира

```rust
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct DriveCommand { pub forward: bool, pub back: bool, pub left: bool, pub right: bool }

pub(crate) struct DriveInput {
    /// Знаковый угол от оси корпуса до желаемого направления, рад:
    /// `atan2(fwd.perp_dot(dir), fwd.dot(dir))`, как в прежнем `move_to`.
    /// Знак: `> 0` — нажимать Right (соглашение прежнего кода).
    pub angle: f32,
    pub distance: f32,
    pub forward_speed: f32,
    pub max_speed: f32,          // модель: maxForwardSpeed (260 у m1)
    pub allow_reverse: bool,
    pub reverse_distance: f32,   // задний ход разрешён ближе этой дистанции (4·tile)
    pub arrive_radius: f32,
    pub blocked_ahead: bool,
}

pub(crate) fn decide_drive(input: &DriveInput, prev: DriveCommand) -> DriveCommand
```

Правила по порядку:

1. `distance ≤ arrive_radius` → всё отпущено.
2. **Задний ход:** `allow_reverse && |angle| > 2.2 && distance < reverse_distance` → `back = true`, а
   рулить по `err = normalize_angle(angle − π)` (ошибка «кормы»), по тем же правилам руля, что в п. 3.
3. **Руль с гистерезисом:** `|err| > 0.08` → `right = err > 0`, `left = err < 0`. Если `prev` уже крутил в
   ту же сторону, держать до `|err| < 0.04`.
4. **Газ вперёд:** `|angle| < 0.35` → `forward`; `0.35 ≤ |angle| ≤ 1.2` → `forward` только при
   `forward_speed < 0.6·max_speed` (притормозить перед поворотом); `|angle| > 1.2` → без газа (разворот на
   месте). При `blocked_ahead` газ вперёд не жать совсем, только рулить (разворот к просвету).

`max_speed` взять из модели танка: `ModelConfig::max_forward_speed`, через `game.models`. Проверить точное
имя поля в `core/src/config.rs`.

### 3.2.2. Лучи объезда (замена `avoid_obstacles`)

```rust
pub(crate) struct Avoidance {
    pub dir: Vector,               // скорректированное направление
    pub blocked_ahead: bool,
    /// Дистанция до пропа (ящик/забор/бочка) прямо по курсу, если он первый на центральном луче.
    pub prop_ahead: Option<f32>,
    /// Доля свободной длины диагональных лучей слева/справа (1 — чисто).
    pub left_free: f32,
    pub right_free: f32,
}

pub(crate) fn probe_obstacles(game: &BotView, me: &SelfState, desired: Vector, layered: bool) -> Avoidance
```

`SelfState { id, body: RigidBodyHandle, pos: Vector, heading: f32, forward_speed: f32, level: u8,
half_length: f32, half_width: f32 }` собирается в мозге один раз за тик.

- Длина `L = clamp(24 + 0.25·|forward_speed|, 24, 70)`.
- Лучи (`Ray::new(origin, dir · len)`, `max_toi = 1.0`):
  - `C` — из центра по `desired`, длина `L`;
  - `FL`/`FR` — из передних углов корпуса (`pos + fwd·0.8·half_length ± right·half_width`) параллельно
    `desired`, длина `0.8·L`;
  - `DL`/`DR` — из центра по `rotate(desired, ∓0.6)`, длина `0.6·L`.
- Запрос: `game.world.cast_ray_and_get_normal(&ray, 1.0, true, filter)`. Сигнатуру сверить в
  `~/.cargo/registry/src/*/rapier2d-0.34.0/src/pipeline/physics_world.rs:426`. Фильтр — **как в прежнем
  `avoid_obstacles`**: `exclude_sensors`, `exclude_rigid_body(own)`, предикат, пропускающий объекты карты
  (`is_map_object`), и на слоёной карте `groups(levels_interaction_on_ramp(level_group(level)))` — стражи рамп
  остаются невидимыми. Для луча `C` дополнительно запомнить, был ли первым пропущенным телом объект карты:
  тогда `prop_ahead = Some(toi · len)`.
- Коррекция: для каждого попадания с долей `f = toi`: `w = (1 − f)²`, `repulse += normal · w · k`, где `k`
  равен 1.2 для `C`, 1.0 для `FL`/`FR` и 0.6 для `DL`/`DR`. Если `C` попал при `f < 0.6`, добавить
  «скольжение вдоль стены»: `t = perp(normal)` со знаком, при котором `t · desired ≥ 0`, умноженное на `(1 − f)`.
- `dir = normalize(desired + repulse + slide)`, при нулевом векторе — `desired`.
- `blocked_ahead = C.f < 0.4 && FL.f < 0.6 && FR.f < 0.6`. `left_free`/`right_free` — `f` лучей `DL`/`DR`
  (1.0 без попадания).
- **Расступиться с союзником** (в мозге, после `probe_obstacles`): союзник (любой танк своей команды,
  `game.spatial.query_nearby`) ближе 25 ед. даёт `dir += normalize(me − ally) · 0.8 · (1 − d/25)`.

### 3.2.3. Шум руля (человеческая неточность)

В мозге: `steer_bias: f32` и `steer_bias_timer: f32` (serde default). Каждые `rng.range(0.5, 1.0)` с
`steer_bias = rng.range(−1, 1) · profile.steer_noise`. Смещение добавляется к `angle` перед `decide_drive`,
**кроме** режимов точного руления (выравнивание на рампу, дистанция до точки меньше `tile`).

### 3.2.4. Точное руление на рампу

Если текущий участок маршрута `Ramp { axis, sign }` (бот едет к вершине от подножия `from`), или бот стоит у
подножия и следующий участок — `Ramp`:

- направление прогона `u`: `axis 0` → `(±1, 0)`, `axis 1` → `(0, ±1)`. Знак — по направлению движения
  `from → pos` (подъём и спуск обрабатываются одинаково);
- точка захода `A = from − u·1.0·tile`, «перед торцом». Пока бот дальше `0.4·tile` от линии оси прогона
  (поперечная ошибка) или угол корпуса к `u` больше 0.3, ехать сначала в `A`;
- в `A` (ближе `0.5·tile`) развернуться на месте (`forward = false`), пока `|angle(u)| > 0.12`;
- затем газ прямо по `u` с малой поправкой к оси: `angle += clamp(0.02 · поперечная_ошибка, −0.2, 0.2)`
  (знак — к центру полосы);
- на самом прогоне (`game.tank_on_ramp(id)`) — без заднего хода, без сглаживания, без шума руля.

Зачем: гейт входа на рампу (`core/src/level.rs`, `entry_is_legal`, `maxSideEntryRise`) пускает только с
торца. Если бот подъезжает под углом, его не поднимет, и он будет тереться о стражей.

### 3.2.5. Обрыв

Участок `Ledge`: ехать к точке приземления обычным рулением на полном газе (кромку бот пересечёт сам). В полёте
ввод заблокирован, и мозг уже выходит раньше (`tank_input_locked`). После приземления уровень не совпадёт с
ожидаемым, если бот упал «не туда», и `needs_replan` перестроит маршрут.

## 3.3. Застревание, выход из него, сторож

В `steering.rs`:

```rust
#[derive(Clone, Default, Serialize, Deserialize)]
pub(crate) struct StuckMonitor {
    low_speed_time: f32,
    window_time: f32,
    window_start: Option<[f32; 2]>,
    window_drive_time: f32,
    recent_attempts: Vec<f32>, // моменты попыток выхода (часы бота) за последние 6 с
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
pub(crate) enum UnstuckPhase { Reverse { left: f32, turn_right: bool }, Turn { left: f32 },
                               ShootProp { left: f32 }, Detour { left: f32 } }
```

Константы (в `steering.rs`, с комментариями):
`STUCK_SPEED = 6.0`, `STUCK_LOW_SPEED_TIME = 0.6`, `STUCK_WINDOW = 1.0`, `STUCK_WINDOW_MIN_MOVE = 5.0`,
`UNSTUCK_TURN_MAX = 0.6`, `RESOLVE_MOVE = 12.0`, `RESOLVE_TIME = 2.0`, `WATCHDOG_TIME = 5.0`,
`WATCHDOG_MOVE = 8.0`, `ATTEMPT_WINDOW = 6.0`.

**Детектор** (каждый тик, если бот не в полёте). Срабатывает, если газ (`forward` или `back`) зажат и
выполняется одно из условий:

- `|forward_speed| < STUCK_SPEED` дольше `STUCK_LOW_SPEED_TIME` подряд;
- за окно `STUCK_WINDOW`, в котором газ был зажат ≥ 70 % времени, бот сдвинулся меньше `STUCK_WINDOW_MIN_MOVE`;
- `blocked_ahead` и `|forward_speed| < 10` дольше 0.3 с.

Намеренная остановка (дошёл до точки, стоит и целится, режим удержания в этапе 6) газа не держит, поэтому не
считается. `stats.stuck_events += 1`.

**Выход** (`BotBrain::unstuck: Option<UnstuckPhase>`, пока `Some` — перекрывает обычное вождение). Эскалация
по числу попыток в `recent_attempts` за `ATTEMPT_WINDOW`:

1. **1-я попытка:** `Reverse { left: rng.range(0.45, 0.8), turn_right }`: `back` + руль в сторону, где
   свободнее (`turn_right = right_free > left_free`, при равенстве — `rng`). Если через 0.3 с
   `|forward_speed| < 4` (сзади тоже стена), перейти на `forward` + тот же руль. Затем
   `Turn { left: UNSTUCK_TURN_MAX }`: разворот на месте к текущей точке маршрута до `|angle| < 0.3`.
2. **2-я:** то же, плюс `AvoidMark` в точке упора (`pos + fwd·half_length`) на 10 с и `nav.pending = true`.
3. **3-я:** если `prop_ahead ≤ 20` → `ShootProp { left: 1.5 }`: башню к оси корпуса (как прежний
   `handle_clearing_obstacle`), по совпадению ±0.1 — `fire` (забор и ящик ломаются, `gameplay.md` «Destructible
   objects»). Иначе `Detour { left: 3.0 }`: временная цель `nearest_walkable_on(level, pos + rotate(fwd,
±2.0)·5·tile, hull_width, 8·tile)` (сторона — где свободнее), ехать туда навигатором.
4. **5-я и дальше:** `nav.fail_goal()`: мозг выберет другую цель или точку.

**Успех:** за `RESOLVE_TIME` после конца манёвра бот сместился больше `RESOLVE_MOVE` → `stats.unstuck_resolved
+= 1`.

**Сторож** (последняя страховка от «завис и стоит»). Мозг хранит `watchdog_pos` и `watchdog_time`. Если бот
жив, не в полёте, не держит намеренную остановку (в этапе 3 это `Attacking` со стрельбой по видимой цели), а
смещение за `WATCHDOG_TIME` меньше `WATCHDOG_MOVE`, то `stats.watchdog_resets += 1`, `nav.clear()`,
`unstuck = None`, отпустить все клавиши. В `Patrolling` выбрать новую точку, в погоне перестроить маршрут к
цели.

Удалить из `brain.rs` старый детектор (`stuck_timer`, `last_position`, блок «обнаружение застревания») и
`handle_clearing_obstacle` (его суть переехала в `ShootProp`). Варианты `BotState::ClearingObstacle`/`Idle`
пока **оставить** в enum (ради чтения старых дампов), но больше не выставлять. Enum целиком заменит этап 4.

## 3.4. Подключение к старой машине состояний (`brain.rs`)

Общий порядок тика после проверок «мёртв/в полёте»:
`собрать SelfState` → таймеры (`nav.tick`, шум руля, сторож) → решения раз в 0.1 с (`make_decision`, как было)
→ цель навигатора по состоянию → `nav.plan(...)`, если `needs_replan` → `nav.follow(...)` → вождение (или
манёвр выхода) → прицел/огонь (как было).

- `Patrolling`: если у навигатора нет цели или `Arrived`/`Unreachable`, цель — `nav.random_point_where(rng,
None, hull_width)`, `moving = false`.
- `Navigating` (враг есть, прямой видимости нет): цель — `PathPoint { pos: позиция врага, level:
game.tank_level(враг) }`, `moving = true`.
- `Searching`: цель — `last_known_position` с его уровнем. Добавить поле `last_known_level: u8` (serde
  default) и заполнять его вместе с позицией.
- `Attacking`:
  - та же сторона и `fire_line == Clear` → как раньше едем на врага напрямую, но через `decide_drive` +
    `probe_obstacles` (`allow_reverse = true`, `arrive_radius = MIN_TARGET_DISTANCE`). Стрейф после выстрела
    (`reposition_target`) тоже через них;
  - иначе (цель за плитой, вне досягаемости) → цель навигатора — враг. Это исправляет расхождение с
    комментарием «путь пойдёт через рампу».
- **Баг башни:** в `execute_aim_and_shoot` при `fire_line != Clear` сначала отпустить `GunLeft`/`GunRight`
  (`keys.release_gun`), потом `return`.
- Удалить мёртвое поле `repath_timer` и константу `REPATH_INTERVAL`.
- Цена обрыва для навигатора (`NavParams.ledge_cost_scale`): в `Navigating`/`Searching`, когда здоровье бота
  больше `fall_cost(1) + 20`, — `1.0 − 0.6·profile.aggression`, иначе `1.0`. Здесь
  `fall_cost(h) = min(max_fall_damage, fall_damage · max(0, h − fall_damage_free_height))` из
  `game.level_rules` (имена полей сверить в `LevelRules`, `core/src/config.rs:164`). Агрессивный здоровый бот
  охотнее прыгает вниз, чтобы догнать.

## 3.5. Тесты

**Юнит** (`steering.rs`, `navigator.rs`, через `test_support::Fixture`):

- `decide_drive`: цель прямо (газ, без руля); под 90° (разворот на месте, без газа); сзади и близко при
  `allow_reverse` (`back` + руль по корме); сзади и далеко (разворот); гистерезис руля (при `|err| = 0.06`
  после поворота вправо руль держится); `blocked_ahead` (нет газа вперёд); внутри `arrive_radius` (всё
  отпущено);
- навигатор: `set_goal` с малым сдвигом не ставит `pending`, с большим ставит; при `route_budget = 0` `plan`
  возвращает `Waiting` и маршрут не меняется; `stall_time > 1.5` добавляет метку и требует перестроения; метка
  истекает по `ttl`; сглаживание не пропускает участок `Ramp` (маршрут на `levels()` фикстуры через рампу);
- все 9 старых тестов (`bot_path_crosses_the_ramp`, `falling_bot_releases_keys_and_does_not_get_stuck`,
  `combat_reposition_stays_on_the_level`, …) зелёные.

**Интеграционные** (`core/tests/sim.rs`, `DT` и `steps` там уже есть):

1. `bot_drives_around_a_wall_to_the_enemy`. Новая карта `walled_arena_json()`: 30×20 тайлов, `step` 32,
   `scale` 1, периметр плюс внутренняя стена в колонке 15, строки 0..=13 (проход внизу, строки 14..18). Бот
   (`spawn_scripted_actor`, team 1) в `(5·32, 3·32)`, враг (`spawn_actor`, team 2, без ИИ) в `(25·32, 3·32)`.
   За 45 с (5400 шагов) здоровье врага (`health_of` по событиям) падает ниже 100. Старый бот упирался бы в
   стену.
2. `stuck_bot_backs_off_the_wall`: та же карта, бот вплотную к внутренней стене лицом к ней (x = 15·32 − 7,
   угол 0°), враг за стеной. За 10 с бот сместился от старта больше чем на 60 ед. Если `stats.stuck_events >
0`, то и `unstuck_resolved > 0` (`core.state().sim.bot_debug(1)`).
3. `bot_climbs_the_ramp_after_a_side_approach`: `layered_map_json()` (рампа — строка 9, колонки 6..9,
   подъём на восток). Бот стоит **сбоку** от прогона: центр клетки (колонка 7, строка 11) =
   `(7.5·32, 11.5·32)`, угол 270° (нос на север, в борт рампы). Цель на плите, как в
   `scripted_bot_drives_onto_the_bridge`. За 30 с бот на уровне 1.
4. `bot_on_the_bridge_gets_down_to_a_ground_enemy`: `overpass_map_json()`, бот на плите (`set_actor_level(1,
1)`, координаты плиты взять из `src/data/maps/overpass.js`), враг на земле далеко. За 60 с бот на уровне 0 и
   враг ранен.
5. `bots_do_not_stall_on_downtown`: `downtown_map_json()`, по 4 бота в команду на первых 4 точках
   `respawns.team1/team2` из той же фикстуры (`serde_json::from_str` → точки уже в немасштабированных единицах,
   умножить на `scale` карты). 90 с. Каждые 0.5 с снимать позицию, `alive` и `bot_debug.mode`. Для каждого бота
   самое длинное окно «жив и сместился меньше 8 ед.» — не больше 6 с. Выборки с `mode == "Attacking"` окно
   прерывают (стояние со стрельбой — норма). Плюс `stats.watchdog_resets ≤ 3` на бота.

## 3.6. Документация и журнал

- `docs/en/gameplay.md` (+ ru), раздел «Bots». Переписать пункты о навигации:
  - маршрут идёт по графу движка и учитывает ширину корпуса;
  - на рампу бот заезжает с торца, предварительно выровнявшись;
  - с обрыва прыгает, когда это короче, а агрессивный и здоровый бот — охотнее в погоне;
  - упёршись, сдаёт назад, разворачивается и перестраивает путь; мешающий забор или ящик простреливает;
  - «сторож» перестраивает бота, который 5 с стоит на месте.

  Абзац «What it does not do» поправить по факту: бот теперь взвешивает здоровье против `fallDamage`.

- `docs/en/core.md` (+ ru): описание `bots/navigator.rs` и `bots/steering.rs` (5–10 строк); ссылка на
  `find_route` в `core.md` движка
  (`https://github.com/lgick/vimp-engine/blob/main/docs/en/core.md`).
- `CHANGELOG.md`, `## [Unreleased]` → `### Fixed`:
  - «Bots no longer drive straight at an enemy behind a wall or under a bridge: chasing, searching and
    patrolling follow a route that fits the hull, over ramps (entered head-on) and ledges.»
  - «A bot stuck against a wall backs off, turns and re-plans (shooting a fence or crate in its way) instead of
    freezing; a watchdog re-plans a bot that has not moved for 5 s.»
  - «The turret of a bot no longer keeps spinning after its target goes out of sight.»

## 3.7. Проверка

```bash
cargo test --workspace -q
npx eslint . --quiet
npm run core:build:node && npm test -- --silent
npm run build && npm run sim -- --scenario tests/scenarios/bots_downtown.json
npm run sim -- --scenario tests/scenarios/bots_bridge.json
```

Сценарии правил игры не проверяют. Смотреть, что нет нарушенных инвариантов (код выхода 0), и глазами
пролистать `bots` в дампах (`.debug/`, поля `nav`, `stats`).
