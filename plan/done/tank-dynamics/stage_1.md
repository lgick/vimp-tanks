# Этап 1. Ядро: баллистический полёт ✅ выполнен

Цель: заменить скриптовое падение на интегрируемую вертикальную скорость,
добавить вылет с рампы (прыжок) и сделать урон зависящим от высоты дуги.

Файлы: `core/src/level.rs`, `core/src/config.rs`, `core/src/tanks.rs`,
`core/src/tank.rs`, `src/config/game.js`.

## 1.1. Новые правила в `LevelRules`

`core/src/config.rs:126-151` — структура `LevelRules` (serde
`rename_all = "camelCase"`, все поля с `#[serde(default)]` + `Default`).
Добавить:

```rust
/// Множитель вертикальной скорости на вылете с верхнего торца рампы.
/// 0.0 — прыжка нет вовсе (старое поведение), 1.0 — вся вертикальная
/// составляющая скорости на уклоне уходит в полёт.
pub ramp_launch_factor: f32,      // default 1.0
/// Минимальная вертикальная скорость (уровней/с) на вылете, ниже которой
/// прыжок не начинается: иначе съезд по рампе шагом рождал бы микропрыжки
/// на каждой клетке.
pub min_launch_vz: f32,           // default 0.35
/// Насколько выше уровня взлёта (в уровнях) танк перестаёт видеть стены —
/// то есть перепрыгивает препятствия.
pub jump_clearance: f32,          // default 0.2
```

`fall_time` **остаётся** и продолжает быть единственной ручкой темпа
падения: гравитация выводится из неё, см. 1.2.

`TanksConfig::validate` (`core/src/config.rs:180-220`) — добавить проверки:
`ramp_launch_factor >= 0.0`, `min_launch_vz >= 0.0`,
`jump_clearance >= 0.0`; сообщения в стиле уже существующих.

Зеркало в JS: `src/config/game.js:43-54`, объект `coreParams.levels` —
дописать три ключа с теми же дефолтами. Движок отдаёт этот объект в ядро
целиком, не читая (комментарий `src/config/game.js:41`).

## 1.2. Гравитация из `fallTime`

В `core/src/level.rs`, рядом с `fall_model()` (`:132`):

```rust
/// Гравитация в уровнях/с², выведенная из `fallTime`, чтобы обычное
/// падение с обрыва длилось ровно столько же, сколько раньше.
/// Свободное падение с нулевой вертикальной скоростью: h = g·t²/2, а
/// прежняя модель проходила ОДИН уровень за `fall_time`, значит
/// g = 2 / fall_time².
pub fn gravity(rules: &LevelRules) -> f32 {
    let t = rules.fall_time.max(1e-3);
    2.0 / (t * t)
}
```

> Внимание: старая модель была линейной по времени (`lerp`), новая —
> параболической. Падение с одного уровня займёт то же время, а с двух —
> `fall_time·√2` вместо `fall_time·2`, то есть станет быстрее. Это
> осознанное изменение (так падают тела), его надо описать в
> `docs/*/gameplay.md` на этапе 6 и поправить ожидания тестов, которые
> считают тики падения (`core/tests/sim.rs`, `landing_applies_fall_damage`
> и соседние).

## 1.3. `Transit::Airborne` вместо `Transit::Falling`

`core/src/level.rs:33`. Заменить вариант:

```rust
/// Полёт: свободное падение с обрыва или прыжок с рампы. `vz` —
/// вертикальная скорость в уровнях/с (положительная вверх), `from` —
/// уровень отрыва, `to` — предполагаемый уровень приземления (выбран в
/// момент отрыва, окончательный решает клетка касания), `peak` — высшая
/// точка дуги (по ней считается урон).
Airborne {
    vz: f32,
    from: u8,
    to: u8,
    peak: f32,
},
```

`elapsed` больше не нужен: фаза полёта полностью описывается парой
`(z, vz)`.

Тогда же:

- `LevelState::input_locked()` (`:79`) — `matches!(self.transit, Transit::Airborne { .. })`.
- **Новое** `LevelState::airborne(&self) -> bool` — то же самое, но имя
  честнее; `input_locked` оставить как алиас, потому что его смысл на этапе
  2 сузится (башня в полёте работает).
- `LevelState::collision_mask()` (`:88`) — ветка `Airborne`:

```rust
Transit::Airborne { from, .. } => {
    // выше уровня отрыва танк не видит вообще ничего: он перелетает
    // стены — ровно то, ради чего прыжок и делается. Ниже возвращается
    // прежняя маска статики: без стен танк проходил бы сквозь здание и
    // приземлялся внутри него
    if self.z >= from as f32 + clearance {
        Group::empty()
    } else {
        STATIC_LEVEL_GROUP
    }
}
```

`clearance` — это `rules.jump_clearance`, а `collision_mask()` правил не
видит. Решение: положить порог в само состояние на шаге — добавить
`LevelState::clear_walls: bool`, который выставляет `step_layered` (он
`rules` видит), а `collision_mask` только читает. Поле идёт в
`#[serde(default)]`, потому что `LevelState` сериализуется в дампах ядра.

- `fall_model` / `fall_elapsed` (`:132-151`) — **удалить**. Единственный
  вызывающий `fall_elapsed` — `Predictor::on_server_state`
  (`core/src/client/predictor.rs:604`), он переписывается на этапе 3.
  `FallModel` из движкового крейта остаётся в употреблении у **тел карты**
  (`step_body_level` на стороне движка) — их модель падения не трогаем.

## 1.4. Событие приземления

`core/src/level.rs:70-75`:

```rust
pub enum LevelEvent {
    None,
    /// Танк коснулся опоры. `height` — высота падения в уровнях от вершины
    /// дуги до точки касания (дробная: прыжок вверх и обратно на свой же
    /// уровень даёт 0.0). `impact` — модуль вертикальной скорости в момент
    /// касания, уровней/с: по нему клиент рисует просадку и пыль.
    Landed { height: f32, impact: f32 },
}
```

`height` становится `f32` вместо `u8` — правит `TanksSim::apply_fall_damage`
(`core/src/tanks.rs:890`):

```rust
let damage = (rules.fall_damage * height as f64).min(rules.max_fall_damage);
```

Формула та же, но высота теперь дробная и считается от вершины.

## 1.5. Переписать `step_layered`

`core/src/level.rs:207` и далее. Три изменения.

### а) Ветка полёта

```rust
if let Transit::Airborne { vz, from, to, peak } = state.transit {
    let g = gravity(rules);
    // полушаговая (симплектическая) схема: скорость обновляется до
    // позиции — та же схема, что использует реплика, иначе высоты
    // разъедутся на дроблении dt
    let vz = vz - g * dt;
    let z = state.z + vz * dt;
    let peak = peak.max(z);

    state.slope_vec = [0.0, 0.0];
    state.z = z;
    state.clear_walls = z >= from as f32 + rules.jump_clearance;

    // цель `to` выбрана в момент отрыва, а тело всё это время летело
    // горизонтально: на длинном сносе плиты `to` под ним уже может не
    // быть. Приземление судит КЛЕТКА КАСАНИЯ (сохранённый комментарий
    // из старой ветки, core/src/level.rs:228)
    let target = if levels.has_floor(to, x, y) {
        to
    } else {
        levels.landing_level(to, x, y)
    };

    // ВВЕРХ дуги приземления быть не может: пока vz > 0, проверять
    // касание бессмысленно и вредно (танк, прыгнувший со своей же
    // плиты, коснулся бы её на первом же шаге)
    if vz <= 0.0 && z <= target as f32 {
        state.level = target;
        state.z = target as f32;
        state.transit = Transit::Grounded;
        state.clear_walls = false;

        return LevelEvent::Landed {
            height: (peak - target as f32).max(0.0),
            impact: vz.abs(),
        };
    }

    // приземление на плиту ВЫШЕ уровня отрыва: прыжок закинул танк на
    // соседний ярус. Проверяется отдельно, потому что `to` считался
    // вниз
    if vz <= 0.0 {
        let above = state.z.floor().max(0.0) as u8;
        if above > target && levels.has_floor(above, x, y) && state.z <= above as f32 {
            /* тот же блок с level = above */
        }
    }

    state.transit = Transit::Airborne { vz, from, to, peak };

    return LevelEvent::None;
}
```

`debug_assert!(from > to)` из старой ветки **снять**: у прыжка `from`
может равняться `to`.

### б) Вылет с верхнего торца рампы (прыжок)

Сейчас конец подъёма — это просто следующий шаг, на котором `ramp_at`
вернул `None`, и танк оказывается `Grounded` на верхнем уровне. Нужно на
этом переходе оценить, был ли вылет.

`step_layered` не знает скорости танка. Значит, сигнатуру нужно расширить:

```rust
pub fn step_level(
    state: &mut LevelState,
    x: f32,
    y: f32,
    vel: [f32; 2],        // НОВОЕ: мировая скорость тела, ед./с
    levels: &MapLevels,
    rules: &LevelRules,
    dt: f32,
) -> LevelEvent
```

Вызывающие: `TanksSim::update_levels` (`core/src/tanks.rs:830`, брать
`body.linvel()`) и `Predictor::step_level`
(`core/src/client/predictor.rs:858`, брать `self.state.vx/vy`).

В ветке «плоская клетка» (`core/src/level.rs:299`, после `ramp_at` →
`None`), перед проверкой обрыва:

```rust
// вылет с рампы: тело только что сошло с прогона, по которому законно
// поднималось. Вертикальная скорость на прогоне — это уклон, умноженный
// на скорость вдоль него; в момент схода она никуда не девается, и танк
// продолжает лететь вверх
let launched = matches!(state.transit, Transit::Ramp { climbing: true, .. });
let prev_slope = state.slope_vec;

state.transit = Transit::Grounded;
state.slope_vec = [0.0, 0.0];
state.clear_walls = false;

if launched {
    let vz = (prev_slope[0] * vel[0] + prev_slope[1] * vel[1])
        * rules.ramp_launch_factor;

    if vz >= rules.min_launch_vz {
        state.transit = Transit::Airborne {
            vz,
            from: state.level,
            to: levels.landing_level(state.level, x, y),
            peak: state.z,
        };
        state.clear_walls = false;   // на старте z == уровень отрыва

        return LevelEvent::None;
    }
}
```

Единицы сходятся: `slope_vec` — уровней на мировую единицу, `vel` —
мировых единиц в секунду, произведение — уровней в секунду.

Порядок веток важен: вылет проверяется **до** проверки обрыва, иначе танк,
слетевший с рампы над пустотой, начал бы падение с `vz = 0` и потерял бы
прыжок.

### в) Ветка обрыва

`core/src/level.rs:314` — та же, но новый вариант:

```rust
state.transit = Transit::Airborne {
    vz: 0.0,
    from: state.level,
    to: levels.landing_level(state.level, x, y),
    peak: state.level as f32,
};
```

Съезд с обрыва по спускающейся рампе получает отрицательный `vz` из
ветки (б) — это желаемое поведение, танк ныряет.

## 1.6. Порядок вызовов на хосте

`TanksSim::update_levels` (`core/src/tanks.rs:830-885`) — менять только
сигнатуру вызова `step_level` (добавился `vel`) и сопоставление события:

```rust
if let LevelEvent::Landed { height, impact } = event {
    landed.push((*id, height, impact));
}
```

Пересинхронизация групп коллизий (`tank.sync_collision_groups`) сейчас
срабатывает при смене `collision_mask()` или `on_ramp()`. Так как маска в
полёте теперь зависит от `z` (порог `jump_clearance`), сравнение
`collision_mask() != before.collision_mask()` продолжает работать —
менять условие не нужно.

`apply_fall_damage` (`:890`) — принимает `height: f32`, `impact: f32`
(второй пока не используется; передавать его нужно, чтобы на этапе 3 не
менять сигнатуру повторно).

## 1.7. Тесты этапа

Юнит-тесты в `core/src/level.rs` (`#[cfg(test)] mod tests`, `:426`) —
дописать рядом с существующими тестами падения:

1. `fall_from_one_level_keeps_old_duration` — падение с уровня 1 занимает
   `ceil(fall_time / dt)` шагов ±1 тик.
2. `fall_from_two_levels_is_faster_than_linear` — падение с уровня 2
   занимает меньше `2 · fall_time`.
3. `ramp_exit_launches_the_tank` — на верхнем торце прогона при скорости
   вдоль уклона состояние становится `Airborne` с `vz > 0`, а `z`
   поднимается выше уровня отрыва хотя бы на одном шаге.
4. `slow_ramp_exit_does_not_launch` — та же геометрия при скорости ниже
   порога даёт `Grounded`.
5. `jump_back_to_the_same_level_deals_no_damage` — `LevelEvent::Landed`
   с `height == 0.0` (в пределах 1e-3).
6. `jump_clears_walls_above_take_off` — при `z > from + jump_clearance`
   `collision_mask()` пустая, при снижении обратно — `STATIC_LEVEL_GROUP`.
7. `drift_during_a_fall_moves_the_landing_level` — существующий тест
   (`:919`), обязан продолжать проходить.

Интеграционные в `core/tests/sim.rs`:

- `landing_applies_fall_damage` (`:912`) — поправить количество шагов под
  новую (параболическую) длительность; ожидание `health == 85.0` остаётся.
- `falling_tank_is_not_hit` (`:1184`) — обязан проходить без изменений.
- Новый `terraces_ramp_launches_the_tank`: на карте `terraces_map_json`
  разогнать танк по крутому прогону `0 → 2` и убедиться, что после схода
  `level_of` какое-то время равен 2, а высота `z` превышала 2.0.

## Готовность этапа

- [x] `npm run core:test` зелёный (272 + 47 тестов)
- [x] `npm run core:build` проходит (оба таргета)
- [x] `npx eslint .` зелёный (менялся `src/config/game.js`)

## Отклонения от плана (решены по ходу)

1. **`vz` переводится в уровни/с делением на `levelHeight`.** `slope_vec`
   безразмерен (`rise * levelHeight / span`, см. `RampSample::slope`), а не
   «уровней на мировую единицу»: без деления вылет давал бы сотни
   уровней/с.
2. **Интегратор — трапеция, а не полушаговая схема.** Только усреднение
   скорости по шагу даёт ТОЧНУЮ выборку параболы (`v² = v0² - 2g·Δz` на
   каждом шаге), а с ней — корректное восстановление скорости полёта
   репликой по высоте кадра.
3. **`fall_model` оставлен**: его зовёт `map_dynamics` для тел карты
   (`step_body_level` движка) — их линейную модель падения этап не трогает.
   Удалён только `fall_elapsed`, на его месте `fall_speed_at`.
4. **Приземление на свою же плиту.** У прыжка `to` — СВОЙ уровень (если
   плита под телом есть), поэтому возврат на неё ловит обычная проверка
   цели; отдельная ветка ловит только плиту ВЫШЕ уровня отрыва и по
   пересечению целого уровня сверху вниз (иначе не долетевший до плиты танк
   телепортировался бы на неё). Полёт стартует с высоты плиты
   (`z = level`), а не с последней высоты прогона.
5. **`height` считается от вершины дуги** (решение из `README.md`), поэтому
   прыжок на свой же уровень стоит ровно высоты дуги над плитой: тест
   `jump_back_to_the_same_level_deals_no_damage` проверяет, что у порогового
   вылета это меньше половины очка, а не ноль бит-в-бит.
6. **`Predictor` пришлось тронуть уже здесь** (план откладывал его на этап
   3): без этого крейт не собирается. Сделан минимум — восстановление
   скорости полёта по высоте кадра и защита прыжка над своей плитой от
   отмены кадром.

## Известное последствие (снимается этапом 3)

`npm run sim:scenarios` даёт `predictionDrift` по компоненте `throttle`
(0.083 при пороге 0.06) на 5 слоёных сценариях: прыжок реплики длится на
несколько тиков дольше хостового, потому что стартовая `vz` берётся из
слегка разошедшихся скоростей, а кадр вертикального состояния пока не
везёт. Остальные компоненты (x, y, vx, vy, angle, angvel) в допусках.
Чинится этапом 3 — проводом вертикального состояния в кадре.
