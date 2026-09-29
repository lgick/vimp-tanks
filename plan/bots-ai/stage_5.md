# Этап 5 (T). Бой как у человека: реакция, промахи, очереди, манёвр, бомба ✅ выполнен

**Репо:** `/Users/dmitry/Sites/my/vimp-tanks` (локальный движок — README).

**Цель.** Бот целится и стреляет как живой игрок:

- замечает цель с задержкой, сначала мажет, по мере сопровождения точнее;
- рука «дрожит», после выстрела прицел уходит;
- на ходу и по быстрой цели стреляет хуже;
- бьёт очередями с паузами, иногда стреляет «в молоко» по только что скрывшейся цели.

В бою он держит дистанцию, ходит «змейкой» так, чтобы цель оставалась в секторе башни, пятится, если враг
слишком близко, и может в азарте сорваться с края моста. Бомбу (`w2`) применяет с умом.

**Файлы:** `core/src/bots/aim.rs` (новый), `core/src/bots/brain.rs` (режим `Engage`), `core/src/bots/mod.rs`
(`mod aim;`), `core/src/bots/steering.rs` (если нужны хелперы), `core/tests/sim.rs`,
`docs/{en,ru}/gameplay.md`, `docs/{en,ru}/core.md`, `docs/{en,ru}/configuration.md` (уточнить смысл полей
пресета, если текст этапа 2 разошёлся с реализацией), `CHANGELOG.md`.

Старое, что удаляется: `execute_aim_and_shoot`, `calculate_new_combat_position`, `reposition_*`,
`firing_timer`, `bomb_cooldown_timer`, константы `AIM_INACCURACY`, `MIN_FIRING_DELAY`, `RANDOM_FIRING_DELAY`,
`BOMB_USAGE_DISTANCE`, `BOMB_COOLDOWN`, `TARGET_PREDICTION_FACTOR`.

---

## 5.1. Модель прицела (`aim.rs`)

```rust
#[derive(Clone, Default, Serialize, Deserialize)]
pub(crate) struct Aim {
    target: Option<u32>,
    acquired_at: f32,
    /// До этого момента башня не реагирует на новую цель (время реакции).
    react_until: f32,
    /// Начальная ошибка наведения, рад (со знаком).
    error0: f32,
    tremor_phase: f32,
    tremor_freq: f32,     // рад/с
    /// Сбой прицела после выстрела, рад (со знаком), спадает с постоянной 0.3 с.
    recoil: f32,
    burst_left: u8,
    next_shot_at: f32,
    /// Для «стрельбы в молоко»: когда цель пропала из вида.
    lost_at: Option<f32>,
    pub hull_request: Option<f32>, // желаемый поворот корпуса, рад (см. 5.2)
}
```

**Захват цели.** Вызов `Aim::retarget(target, clock, profile, rng, target_lateral_speed)`: цель сменилась или
снова стала видна после невидимости дольше 1 с.

- `react_until = clock + profile.reaction_time · rng.range(0.8, 1.3)`. Если бот держал прицел в сторону
  появления (угол между стволом и направлением на цель < 0.3 рад: «ждал из-за угла»), время реакции ×0.6;
- `error0 = rng.range(−1, 1) · profile.aim_error · (1 + 0.5 · min(1, lateral_speed / 150))`;
- `tremor_phase = rng.range(0, 2π)`, `tremor_freq = rng.range(1.5, 3.0) · 2π`;
- `acquired_at = clock`, `burst_left = rng` целое из `profile.burst_shots` (включительно),
  `next_shot_at = react_until`.

**Текущая ошибка, рад:**

```
settle   = error0 · exp(−(clock − acquired_at) / aim_settle_time)
tremor   = aim_tremor · sin(tremor_phase + clock · tremor_freq)
motion   = 0.15 · aim_error · min(1, |own_forward_speed| / max_speed)
tracking = 0.1 · |угловая скорость цели относительно бота|   // (vel_t × dir) / dist, рад/с
recoil   (спадает: recoil *= exp(−dt / 0.3))
error    = settle + tremor + recoil + sign(settle) · (motion + tracking)
```

Точка прицеливания — угол на цель плюс `error`. Цель берётся **истинная** (`game.tank_position_rounded`) только
у видимой цели. У невидимой — позиция контакта (этап 4). `w1` — hitscan, упреждение не нужно.

**Башня.**

- `rel = normalize_angle(aim_angle − heading)` — нужный угол башни относительно корпуса;
- лимит: `lim = game.max_gun_angle(me)` (1.4 у `m1`). Если `|rel| > lim − 0.1`, прицелить в `clamp(rel, ±lim)` и
  выставить `hull_request = Some(rel)`: корпус надо довернуть (выполняет 5.2);
- `diff = rel − tank.gun_rotation`. `|diff| > 0.03` → `GunRight` при `diff > 0`, `GunLeft` при `diff < 0`,
  иначе отпустить обе. Знак сверить с прежним кодом: там `angle_difference > 0 → GunRight`, где
  `angle_difference = target_angle − (body_angle + gun_rotation)` — то же самое;
- до `react_until` клавиши башни **отпущены**: человек ещё не отреагировал.

**Решение «жать огонь»** (каждый тик, все условия сразу):

1. `clock ≥ react_until` и `clock ≥ next_shot_at`;
2. `fire_line == Clear` (этап 4);
3. ствол смотрит на **истинную** цель с точностью `tol`: `|normalize_angle(gun_world_angle −
angle_to_true_target)| < tol`, где `tol = max(0.01, atan(target_half_length / dist) · profile.fire_tolerance)`.
   При `fire_tolerance > 1` бот жмёт огонь, когда прицел ещё «около цели», — отсюда промахи;
4. `game.ammo(me, w1) ≥ 1` и текущее оружие — `w1` (иначе сначала переключение, 5.4).

Выстрел: `keys.press_once(fire)`, `stats.shots_fired += 1`, `recoil += rng.range(0.3, 1.0) · 0.5 · aim_error ·
(±1 от rng)`. Затем `burst_left -= 1`. Если в очереди ещё есть выстрелы — `next_shot_at = clock + shot_interval ·
rng.range(0.9, 1.2)`. Иначе `burst_left` = новое случайное из `burst_shots`, а
`next_shot_at = clock + rng.range(burst_pause[0], burst_pause[1])`.

**«В молоко».** Цель видна **была** меньше 0.4 с назад, а сейчас `fire_line == Wall`. Тогда с вероятностью
`profile.panic_fire` (разыгрывается **один раз** на каждое исчезновение цели) — один выстрел в последнюю
сторону, если ствол туда смотрит (`tol · 2`). Это человеческая ошибка: патрон тратится зря.

**Сброс.** В `Dead` и при потере цели — `Aim::reset()` и `keys.release_gun`.

## 5.2. Манёвр в бою (режим `Engage`, `brain.rs`)

Обозначения: `d` — дистанция до цели, `[pmin, pmax] = profile.preferred_range`, `dir` — единичный вектор на
цель, `tile = game.tile_size()`.

1. **Дистанция.**
   - `d > pmax` — сближение. Цель навигатора — цель (`moving = true`), стрельба разрешена на ходу.
   - `d < pmin`, и бот не «драчун» (`aggression ≤ 0.7`) — отход **задним ходом** лицом к цели: точка
     `me − dir · 2·tile` через `decide_drive` с `allow_reverse = true`.
   - `aggression > 0.7` — не пятиться, а сближаться до бомбы (5.4).
2. **«Змейка» внутри полосы** `[pmin, pmax]`:
   - сторона `side = ±1` меняется каждые `rng.range(1.5, 3.0)` с, при упоре (`blocked_ahead`), и с вероятностью
     0.5, когда `aiming_at_me` цели стал `true`. Это уклонение (у `easy` — никогда: условие
     `profile.skill != Easy`);
   - направление манёвра: `m = rotate(dir, side · (π/2 − 0.5))`, то есть около 61° от линии на цель. При таком
     курсе цель в секторе башни (`|rel| ≤ 1.07 < 1.4`). Чистый поперечный стрейф (90°) вывел бы цель за лимит
     башни;
   - точка манёвра `P = me + m · rng.range(3, 6)·tile`, берётся заново при смене стороны или по достижении;
   - **валидация `P`:** `nav.is_walkable_on(my_level, P)` и `nav.fits_on(my_level, P, hull_width)`. Если нет:
     - если на `P` нет пола своего уровня, но под ним есть проходимый уровень ниже
       (`levels.landing_level(my_level, P.x, P.y) < my_level` и `nav.is_walkable_on(landing, P)`), —
       **срыв с края**: с вероятностью `profile.edge_risk` (разыгрывается на каждый выбор `P`) точку
       принять. Бот в азарте съедет с моста и упадёт (урон — `fallDamage`). Это желаемая «человеческая»
       ошибка;
     - иначе сменить сторону. Если и там нельзя — `P` на линии `± dir` (вперёд/назад).
3. **Корпус к цели.** Если `aim.hull_request` задан, приоритет у поворота корпуса: вождение получает желаемое
   направление `dir` вместо `m`. На месте (`forward = false`) корпус доворачивается, пока `|rel| ≤ lim − 0.3`.
4. **Союзник на линии огня** (`fire_line == Ally`) — сторону сменить на ту, что уводит от союзника
   (`side = sign(cross(dir, ally − me))` с обратным знаком), `P` взять заново сразу.
5. **`Prop` на линии** — так же сменить позицию. Ящик не расстреливать: он крепкий, пули тратятся зря.
6. Разрыв видимости и выход из `Engage` — по правилам этапа 4.

## 5.3. Стрельба в других режимах

- `Hunt` — огонь разрешён, если цель видна и `fire_line == Clear` (встречный бой на ходу). Ошибка прицела
  вырастет сама через `motion`.
- `Roam` — не стрелять.
- Башня в `Hunt` без видимой цели смотрит на радарную позицию цели («держит угол»), не стреляя. Это даёт
  сокращённую реакцию из 5.1.

## 5.4. Бомба `w2` (мина под себя: 70 урона, радиус 50, взрыв через 300 мс)

Параметры взять из конфига оружия (`game.weapons["w2"]`: `radius`, `damage`), не из констант.

**Когда:**

- **(а) драка вплотную:** цель ближе `0.8 · radius`, `game.ammo(me, w2) ≥ 1`, и одно из двух: `friendly_fire ==
false` (своя бомба не ранит), либо (`aggression > 0.8` и здоровье > `damage + 10`);
- **(б) отход** (этап 6): бот в `Retreat`, враг позади ближе 60 ед. и едет за ним.

**Как:**

1. Переключение оружия: `fn select_weapon(&mut self, game, index)` — если `current_weapon != index`,
   `press_once(next_weapon)` не чаще раза в 0.15 с (таймер `weapon_switch_at`) до совпадения. Оружий два, так что
   хватает одного нажатия. Для общности крутить `next_weapon`, пока не совпадёт, максимум `weapons.len()`
   нажатий.
2. Совпало — `press_once(fire)` один раз, `stats.shots_fired += 1`.
3. Сразу `evade_until = clock + 1.0`: газ **от точки бомбы**. Цель вождения — `me + (me − bomb_pos) · 3·tile`,
   `allow_reverse = true`.
4. На следующем решении вернуть `w1` (`select_weapon(w1)`).

Кулдауна «бомба раз в N с» нет. Бомбы ограничены боезапасом (`w2: 100` в панели), но бот не кладёт вторую, пока
не кончился `evade_until` предыдущей.

**Патроны:** `w1 == 0` → бот не лезет в перестрелку. В этапе 5 это `Hunt` без стрельбы плюс условие (а) для
бомбы. Этап 6 превратит это в `Retreat`.

## 5.5. Тесты

**Юнит** (`aim.rs`, `brain.rs`, через `Fixture`; время двигать через `update(view, dt)` с фиксированным dt):

- `aim_error_settles`: `aim_error = 0.2`, `aim_tremor = 0`, стоим. При захвате `|error| ≈ |error0|`, через
  `3 · aim_settle_time` — меньше 10 % от `|error0|`;
- `no_turret_before_reaction`: до `react_until` клавиши башни не нажимаются, после — нажимаются;
- `turret_limit_requests_hull_turn`: цель под 2.0 рад от оси корпуса → `hull_request.is_some()`, и за 2 с
  апдейтов корпус довернулся так, что `|rel| < lim`;
- `fires_only_inside_tolerance`: `fire_tolerance = 1.0`, цель в 300 ед. Если ствол увести от цели на `3 · tol`,
  выстрела нет;
- `bursts_have_pauses`: 10 с по неподвижной видимой цели. Число выстрелов между `10 / (shot_interval +
burst_pause[1])` и `10 / shot_interval` (грубые границы), и в последовательности есть интервалы ≥
  `burst_pause[0]`;
- `no_fire_through_ally` (этап 4) — зелёный;
- `strafe_point_respects_edges`: `levels()` фикстуры, бот на краю плиты без перил. При `edge_risk = 0` точка
  манёвра за краем не выбирается, при `edge_risk = 1` выбирается;
- `bomb_only_at_close_range`: враг в 30 ед. → бот переключается на `w2` и кладёт бомбу; враг в 100 ед. — нет.
  При `friendly_fire = true` и `aggression = 0.5` — нет даже в 30 ед.

**Интеграционные** (`core/tests/sim.rs`):

- `bots_duel_ends_with_a_kill`: `map_json()`, два бота разных команд в прямой видимости в 300 ед. За 60 с один
  погибает (событие `Death`/`health 0`). Комментарий в `bots_fight_each_other` про «залипает у стены» снять.
- `bot_accuracy_is_human_like`: бот против неподвижного `spawn_actor` в 300 ед., 30 с, в конфиге теста
  `skill: normal`. Доля попаданий = (события урона цели, `health_of` по событиям `PanelSet`, до смерти цели) /
  `shots_fired` — в `[0.2, 0.9]`: и мажет, и попадает. Чтобы цель не умерла за 3 попадания, перед каждой
  порцией шагов ей возвращать здоровье: `debug_set_health(target, 100)` (хук этапа 2). Каждое попадание — это
  событие `PanelSet health` со значением меньше 100.
- `hard_bots_beat_easy_bots_more_often`: 6 дуэлей `hard` против `easy` на `map_json()`. Шесть разных раскладок
  стартовых позиций и углов, стороны меняются местами, так что каждая сложность стартует с каждой стороны.
  `hard` побеждает не меньше 4 раз. Сложность задаётся на бота: добавить
  `#[doc(hidden)] pub fn debug_set_bot_skill(&mut self, id, skill)` на `TanksSim`, он перебрасывает профиль
  через `BotProfile::roll` с `variance = 0`. Результат детерминирован, поэтому тест не «мигает». Если он
  упал — это сигнал к подстройке пресетов, а не к ослаблению порога.

## 5.6. Документация и журнал

- `docs/en/gameplay.md` (+ ru), «Bots» → новый подпункт **«Combat»**:
  - реакция и сходящаяся ошибка прицела, дрожь, сбой после выстрела, хуже на ходу;
  - очереди с паузами; держит дистанцию; «змейка» в секторе башни; пятится от близкого врага;
  - может сорваться с края в бою (`edgeRisk`);
  - бомба — только вплотную и чтобы уехать от неё (или на отходе);
  - по видимой цели стреляет и на ходу.
- `docs/en/configuration.md` (+ ru): сверить описание полей пресета с реализацией (`fireTolerance`,
  `burstShots`, `burstPause`, `shotInterval`, `panicFire`, `edgeRisk`, `preferredRange`).
- `docs/en/core.md` (+ ru): `aim.rs` — модель ошибки (формула из 5.1), лимит башни и `hull_request`.
- `CHANGELOG.md`, `## [Unreleased]`:
  - `### Changed` — «Bots aim like a player: a reaction delay, an aim error that settles while tracking, a
    tremor, a flinch after each shot, worse accuracy on the move; they fire in bursts, keep their preferred
    range, weave within the turret's arc and back off from an enemy that is too close.»
  - `### Fixed` — «Bots drop a bomb only when the enemy is inside its blast radius and drive away from it (before,
    they dropped it at up to 100 units, where it could not reach).»

## 5.7. Проверка

```bash
cargo test --workspace -q
npx eslint . --quiet
npm run core:build:node && npm test -- --silent
npm run build && npm run sim:scenarios
```

Глазами (`npm run dev`, `/bot 4` на `pool mini` и `downtown`): боты мажут, но убивают, стреляют очередями, не
кружат на месте, не стреляют в своих.
