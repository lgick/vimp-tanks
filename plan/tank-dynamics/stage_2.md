# Этап 2. Ядро: наклон корпуса (`pitch` / `roll`)

Требует этап 1 (`Transit::Airborne`, `vz`).

Цель: считать наклон корпуса **на хосте** из `slope_vec` и `vz`, а не на
клиенте из разницы высот между кадрами. Именно вторая схема сломалась и
привела к удалению наклона (`docs/ru/gameplay.md:139`): уклон, восстановленный
из высоты, замирал у стоящего танка.

Файлы: `core/src/motion.rs`, `core/src/tank.rs`, `core/src/config.rs`,
`core/src/client/predictor.rs`, `src/config/game.js`.

## 2.1. Ручки в `LevelRules`

`core/src/config.rs:126-151`, зеркало — `src/config/game.js`
(`coreParams.levels`):

```rust
/// Во сколько раз безразмерный уклон превращается в угол наклона
/// корпуса. 1.0 — наклон равен арктангенсу уклона (физически честно и
/// визуально слабо на пологих рампах).
pub tilt_gain: f32,          // default 2.0
/// Наклон носа в полёте: сколько радиан на единицу вертикальной
/// скорости (уровней/с). Нос задран на взлёте, опущен на снижении.
pub tilt_air_gain: f32,      // default 0.12
/// Скорость возврата корпуса к целевому наклону, 1/с. Ноль — наклон
/// мгновенный и дёрганый.
pub tilt_response: f32,      // default 12.0
/// Потолок наклона по модулю, рад.
pub tilt_max: f32,           // default 0.6
```

`validate()`: `tilt_gain >= 0.0`, `tilt_air_gain >= 0.0`,
`tilt_response >= 0.0`, `0.0 <= tilt_max <= 1.5`.

## 2.2. Чистая формула в `motion.rs`

`core/src/motion.rs` — новая функция рядом с `drive_accel` (файл
специально держит только mass-free формулы, общие для хоста и реплики,
см. шапку файла):

```rust
/// Целевой наклон корпуса: продольный (`pitch`, нос вверх положителен) и
/// поперечный (`roll`, правый борт вниз положителен).
///
/// `slope_vec` — вектор уклона из `LevelState` (уровней на мировую
/// единицу, `[0,0]` вне рампы), `heading` — единичный вектор курса
/// корпуса, `vz` — вертикальная скорость (уровней/с, 0 на земле).
/// Вне рампы и вне полёта возвращает `(0.0, 0.0)`: одноуровневая карта
/// наклона не замечает.
pub fn tilt_target(
    slope_vec: [f32; 2],
    heading: (f32, f32),
    vz: f32,
    airborne: bool,
    rules: &LevelRules,
) -> (f32, f32) {
    if airborne {
        // в воздухе уклона под гусеницами нет: нос ведёт вертикальная
        // скорость, крена нет вовсе
        let pitch = (vz * rules.tilt_air_gain).clamp(-rules.tilt_max, rules.tilt_max);

        return (pitch, 0.0);
    }

    // продольный уклон — вдоль курса, поперечный — вдоль левого борта
    let long = slope_vec[0] * heading.0 + slope_vec[1] * heading.1;
    let lat = -slope_vec[0] * heading.1 + slope_vec[1] * heading.0;

    let pitch = (long * rules.tilt_gain).atan().clamp(-rules.tilt_max, rules.tilt_max);
    let roll = (lat * rules.tilt_gain).atan().clamp(-rules.tilt_max, rules.tilt_max);

    (pitch, roll)
}

/// Шаг сглаживания наклона: экспоненциальный подход к цели.
/// Отдельная функция, чтобы хост и реплика гарантированно считали одно и
/// то же (обе стороны зовут её после `tilt_target`).
pub fn approach_tilt(current: f32, target: f32, rules: &LevelRules, dt: f32) -> f32 {
    lerp(current, target, (rules.tilt_response * dt).min(1.0))
}
```

`long` — тот же уклон, что уже считает `LevelState::grade`
(`core/src/level.rs:125`); переиспользовать его нельзя напрямую, потому что
нужен ещё и поперечный, поэтому формулу дублируем в `motion.rs` рядом.
Проверить в тесте, что `tilt_target(...).0` при `tilt_gain = 1.0` и
малом уклоне совпадает с `atan(state.grade(hx, hy))`.

## 2.3. Состояние на хосте

`core/src/tank.rs`, структура `Tank` (`:93-134`) — два поля:

```rust
/// Продольный и поперечный наклон корпуса, рад. Считается на хосте и
/// едет в кадре: клиент восстановить его не может — у чужих танков нет
/// ни `slope_vec`, ни `vz`, а восстановление из разницы высот между
/// кадрами замирает у стоящего танка (эта схема уже была и её убрали).
pub pitch: f32,
pub roll: f32,
```

Инициализация нулями в `Tank::new`; сброс нулями в `reset_vitals`
(`:572`) — при респауне наклон обязан обнулиться.

`Tank::update` (`:398-508`) — расчёт вставить **после** шага башни и
**до** ранних выходов по вводу, потому что наклон обязан считаться и у
падающего танка. Практически это значит переписать начало:

```rust
// 1. клавиши
let keys = self.keys_for_processing();

// 2. башня — работает ВСЕГДА, в том числе в полёте (изменение правил:
//    раньше `input_locked` глушил и её)
let (gun, centering) = motion::step_turret(/* ... */);
self.gun_rotation = gun;
self.centering_gun = centering;

// 3. наклон корпуса — тоже всегда
let (cos, sin) = (angle.cos(), angle.sin());
let vz = match self.level_state.transit {
    Transit::Airborne { vz, .. } => vz,
    _ => 0.0,
};
let (tp, tr) = motion::tilt_target(
    self.level_state.slope_vec,
    (cos, sin),
    vz,
    self.level_state.airborne(),
    rules,
);
self.pitch = motion::approach_tilt(self.pitch, tp, rules, dt);
self.roll = motion::approach_tilt(self.roll, tr, rules, dt);

// 4. полёт: ввод движения заблокирован, но кулдауны идут (как было)
if self.level_state.input_locked() {
    self.engine_load = 0.0;
    /* существующий блок core/src/tank.rs:411-418, БЕЗ шага башни */
    return;
}
```

> Выстрел в полёте разрешён вместе с башней (выбор пользователя). Блок
> стрельбы (`core/src/tank.rs`, шаг 4 старого порядка) поднять выше
> раннего выхода вместе с башней. Проверить, что `create_weapon_action`
> для бомбы уже умеет уровень падающего танка — умеет,
> `level::bomb_level(..., input_locked)` (`core/src/level.rs:162`).

Порядок оставшихся шагов (дроссель → боковое сцепление → тяга → нагрузка →
поворот → смена оружия) **не менять**: он закреплён паритетом.

## 2.4. Та же логика в реплике

`core/src/client/predictor.rs`:

- `Predictor` — поля `pitch: f32`, `roll: f32` (не в `TankState`:
  `TankState` позиционно связан с `PLAYER_STATE_LEN = 8`, менять его
  нельзя).
- `step_inner` (`:724-806`) — вставить те же три блока (башня, наклон,
  ранний выход) в том же порядке, что в `Tank::update`.
- `RenderState` (`:115-131`) — добавить `pub pitch: f32`, `pub roll: f32`,
  `pub vz: f32`; заполнять в `render_state()` (`:680`).
- `reset` (`:414`) — обнулять `pitch`/`roll`.
- Снапшот истории уровня (`push_level_snapshot`, `:828`) — наклон в неё
  **не** класть: после реконсиляции он корректируется авторитетным
  значением из кадра (этап 3), а между кадрами доигрывается сглаживанием.
  Расхождение здесь не влияет на позицию и потому не ломает паритет.

## 2.5. Тесты этапа

`core/src/motion.rs` (`#[cfg(test)] mod tests`):

1. `flat_ground_has_no_tilt` — `tilt_target([0,0], .., false)` → `(0,0)`.
2. `uphill_lifts_the_nose` — уклон вдоль курса даёт `pitch > 0`,
   встречный — `pitch < 0`.
3. `side_slope_rolls_the_hull` — уклон поперёк курса даёт `roll != 0` при
   `pitch ≈ 0`.
4. `tilt_is_capped` — большой уклон не превышает `tilt_max`.
5. `airborne_pitch_follows_vz` — в полёте знак `pitch` совпадает со знаком
   `vz`, `roll == 0`.
6. `approach_tilt_converges` — 100 шагов по 1/60 с приводят к цели с
   точностью 1e-3.

`core/src/client/predictor.rs` (модуль паритета):

7. `parked_tank_keeps_its_tilt` — регрессия на исторический баг: танк,
   остановленный на середине прогона, сохраняет ненулевой `pitch` сколько
   угодно шагов (сглаживание сходится к цели, а не к нулю).
8. Существующие тесты паритета (`replay_matches_continuous_simulation` и
   соседи) обязаны проходить без изменения порогов.

`core/tests/sim.rs`:

9. `turret_works_while_falling` — новое правило: у падающего танка
   `gunRotation` меняется по вводу.

## Готовность этапа

- [ ] `npm run core:test` зелёный, пороги паритета не тронуты
- [ ] `npx eslint .` зелёный (`src/config/game.js`)
