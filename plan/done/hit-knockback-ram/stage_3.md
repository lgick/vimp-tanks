# Этап 3. Ядро: механизм `hitResponse` — попадание по танку в осях корпуса ✅ выполнен

## Цель

Ввести в ядро механизм из раздела «Решение» README. **Игровые значения на этом этапе не меняются**: в
`src/data/models.js` блока `hitResponse` ещё нет, поэтому игра, фикстуры, parity и все сценарии ведут себя
бит-в-бит как раньше. Калибровка — этап 4.

## 3.1 Конфиг (`core/src/config.rs`)

1. Новая структура рядом с `Damping`/`Fixture`:
   ```rust
   /// Реакция корпуса на попадание hitscan (`models.js → hitResponse`):
   /// множители импульса в осях корпуса (`motion::hit_impulse`). Нет блока —
   /// импульс в точке попадания, как у любого тела.
   #[derive(Clone, Copy, Debug, Deserialize)]
   #[serde(rename_all = "camelCase")]
   pub struct HitResponse {
       /// боковая часть на асфальте; на другой поверхности и в полёте —
       /// пропорционально сопротивлению вбок
       pub lateral_factor: f32,
       /// продольная часть, когда двигатель не работает (нет клавиш хода,
       /// полёт)
       pub idle_factor: f32,
       /// доворот корпуса от плеча точки попадания
       pub spin_factor: f32,
   }
   ```
2. В `ModelConfig` — поле с комментарием:
   ```rust
   #[serde(default)]
   pub hit_response: Option<HitResponse>,
   ```
   Все модели в тестах собираются из JSON (`serde_json::from_value`), литералов `ModelConfig { … }` нет — фикстуры
   не меняются.
3. **Валидация** в `TanksConfig::validate` — перед `self.surfaces.validate(&self.models)?`: цикл по
   `self.models`; для `Some(hit)`:
   - `lateralFactor` конечен и `> 0`;
   - `idleFactor` конечен и `> 0`;
   - `spinFactor` конечен и в `[0, 1]`.

   Текст ошибки: `models.{name}.hitResponse.{field} must be …, got {value}`.
4. **Тесты** (модуль тестов `config.rs`): модель из JSON (поля — как у фикстуры `flat_config_json()` в
   `core/tests/sim.rs`; можно взять за основу `surface_model()` в `config.rs`), вставить в `cfg.models` конфига
   `config_with_panel_keys(&["health"])`:
   - без блока — `hit_response` равен `None`, `validate()` проходит;
   - с блоком — значения прочитаны, `validate()` проходит;
   - отказ на `lateralFactor` 0, `idleFactor` −1, `spinFactor` 1.5 и −0.1 (текст ошибки содержит имя поля).

## 3.2 Чистая функция (`core/src/motion.rs`)

Формулы движения, общие для хоста и реплики, живут в `motion.rs`; функция чистая, на кортежах, без Rapier:

```rust
/// Состояние корпуса в момент попадания (`Tank::hit_state`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HitState {
    /// сцепление под гусеницами (`SurfaceMix::grip` с остатком масла);
    /// в полёте 0
    pub grip: f32,
    /// зажата клавиша хода и танк не в полёте: продольный толчок гасит
    /// двигатель сам
    pub drives: bool,
}

/// Импульс попадания по танку в осях корпуса: `(линейный, вращения)`.
/// (док-комментарий: зачем каждая ось — числа из раздела «Физика» README)
pub fn hit_impulse(
    impulse: (f32, f32),
    lever: (f32, f32),
    heading: (f32, f32),
    model: &ModelConfig,
    response: &HitResponse,
    state: HitState,
) -> ((f32, f32), f32) {
    let (fx, fy) = heading;
    let (rx, ry) = (-fy, fx);
    let along = impulse.0 * fx + impulse.1 * fy;
    let across = impulse.0 * rx + impulse.1 * ry;
    let along = along * if state.drives { 1.0 } else { response.idle_factor };
    // сопротивление вбок относительно асфальта: сцепление × grip плюс
    // демпфирование; в полёте остаётся одно демпфирование
    let damping = model.damping.linear;
    let full = damping + model.lateral_grip;
    let resistance = if full > 0.0 {
        (damping + model.lateral_grip * state.grip) / full
    } else {
        1.0
    };
    let across = across * response.lateral_factor * resistance;
    let torque = (lever.0 * impulse.1 - lever.1 * impulse.0) * response.spin_factor;

    ((fx * along + rx * across, fy * along + ry * across), torque)
}
```

**Юнит-тесты** (модуль тестов `motion.rs`, хелпер `model()` ~стр. 342: `damping.linear` 3, `lateralGrip` 20):
- лоб: `heading (1, 0)`, `J (−1000, 0)`, `lever (4, 0)` — без хода линейный `(−1000·idle, 0)`, с ходом
  `(−1000, 0)`, вращения нет;
- борт: `J (0, 1000)` — при `grip` 1 боковая часть `1000·lateral`, при `grip` 0 — `1000·lateral·3/23`;
- косой `J (1000, 1000)` — оси независимы: `(1000·idle, 1000·lateral)` при `grip` 1;
- вращение `= (lever × J)·spin`; `spin` 0 → 0; плечо вдоль `J` → 0.

Сравнение — с допуском `1e-3`.

## 3.3 Состояние корпуса (`core/src/tank.rs`, `impl Tank`)

```rust
/// Состояние корпуса для `motion::hit_impulse`: сцепление под гусеницами
/// и работает ли двигатель. В полёте — ни того, ни другого. Состояние
/// уровня не меняется: остаток масла считается на копии (`LevelState` —
/// `Copy`) с `dt` 0.
pub fn hit_state(
    &self,
    body: &RigidBody,
    bits: &PlayerKeyBits,
    surfaces: Option<&SurfaceMap>,
    surface_rules: &SurfaceRules,
) -> motion::HitState
```

- `self.level_state.input_locked()` → `HitState { grip: 0.0, drives: false }`.
- `drives` = `self.current_keys & (bits.forward | bits.back) != 0` — зажатые клавиши, **не**
  `keys_for_processing()` (тот сбрасывает разовые события).
- `grip`: те же вызовы, что в `Tank::update` (искать `surface::tank_mix(`): `tank_mix(map, surface_rules,
  &self.level_state, x, y, angle, width / 2, height / 2)`, затем `apply_slick` на копии
  `let mut state = self.level_state;` с `dt` 0.0; результат — `.grip`. Без карты поверхностей —
  `SurfaceMix::NEUTRAL.grip`.

## 3.4 `TanksSim::process_hitscan` (`core/src/tanks.rs`)

Блок (искать `body.apply_impulse_at_point(dir * impulse_magnitude, impact, true)`):

```rust
if impulse_magnitude > 0.0 && body.is_dynamic() {
    let impulse = dir * impulse_magnitude;
    // танк с `hitResponse` принимает удар в осях корпуса; остальные тела
    // (и танк без блока) — в точке попадания
    let response = match BodyTag::decode(body.user_data) {
        Some(BodyTag::Player { game_id, .. }) => self.tanks.get(&game_id).and_then(|tank| {
            let model = self.models.get(&tank.model)?;

            model.hit_response.map(|response| (tank, model, response))
        }),
        _ => None,
    };

    if let Some((tank, model, response)) = response {
        let state = tank.hit_state(body, &self.key_bits, self.surfaces.as_ref(), &self.surface_rules);
        let heading = body.rotation().transform_vector(Vector::new(1.0, 0.0));
        let lever = impact - body.center_of_mass();
        let (linear, torque) = motion::hit_impulse(
            (impulse.x, impulse.y),
            (lever.x, lever.y),
            (heading.x, heading.y),
            model,
            &response,
            state,
        );

        body.apply_impulse(Vector::new(linear.0, linear.1), true);
        body.apply_torque_impulse(torque, true);
    } else {
        body.apply_impulse_at_point(impulse, impact, true);
    }
}
```

- `body` заимствован из `ctx.world.bodies`, `self.tanks`/`self.models` — неизменяемо: конфликта нет.
- Rapier 0.34: `center_of_mass()` — центр масс в мире; `apply_impulse_at_point` внутри делает то же:
  `(point − world_com).gcross(impulse)`, затем `apply_impulse` и `apply_torque_impulse`.
- Союзники толкаются как сейчас (решение пользователя); код `hit_player`/`apply_damage` ниже не менять.
- Реплику (`core/src/client/predictor.rs`) и снапшот не трогать.

## 3.5 Rust-тесты механизма (`core/tests/sim.rs`, фикстура не меняется)

Хелпер рядом с `config_json_with_bullet`:

```rust
fn config_json_with_hit_response(response: serde_json::Value) -> String {
    let mut flat = flat_config_json();

    flat["models"]["m1"]["hitResponse"] = response;

    wrap_config(flat)
}
```

Расстановка — как в `hitscan_shot_kills_after_three_hits`, без карты: стрелок `1` (команда 1) в (0, 0), курс 0;
цель `2` (команда 2) в (60, плечо): курс 180° — лоб к стрелку, 90° — борт к стрелку. Корпус фикстуры `size` 2 →
8 × 6 (полудлина 4, полуширина 3). Прогрев `core.step(DT)`; строка цели до (`tank_row_of`: x, y, angle);
`apply_input(1, …, "down", "fire")`; `steps(…, 180)`; строка после.

Тесты:
1. `hit_without_response_keeps_point_impulse` — без блока попадание в борт у кормы (цель в (60, 3), курс 90°)
   доворачивает корпус заметно (> 2°): работает прежний путь.
2. `hit_response_scales_hull_axes` — блок `{ lateralFactor 2, idleFactor 0.5, spinFactor 0 }`, стоящая цель:
   лоб — сдвиг ≈ 0.5 × сдвига без блока (±5 %); борт через центр — ≈ 2 × (±10 %); борт у кормы — поворот < 0.05°.
3. `hit_response_idle_factor_skips_driving_tank` — цель в (400, 0), курс 180°, держит `forward`; выстрел на шаге
   150 в обоих прогонах; `idleFactor` 0.5 и 1.0 дают одинаковую позицию через 180 шагов (допуск `1e-4`).
4. `hit_response_on_oil_matches_asphalt` — карта `surface_map_json(80, |_, _| 44, game)` (2560 × 640, без стен):
   масло `{ "surfaces": { "0": { "44": "oil" } } }` против `serde_json::Value::Null`; стрелок в (100, 320), курс 0;
   цель в (160, 320), курс 90° — борт через центр. Без блока сдвиг на масле > 3 × асфальта; с блоком
   `{ lateralFactor 1, idleFactor 1, spinFactor 0 }` — в пределах ±25 % друг от друга.
5. `hit_response_leaves_props_alone` — ящик из `map_with_box_json` (как в `hitscan_impulse_independent_of_weapon_range`):
   сдвиг от выстрела с блоком и без совпадает (`< 1e-6`).

## 3.6 Docs и журнал

- **`docs/en/core.md`** — в конец раздела `## Tank body` (перед `## 2.5D levels`) подраздел
  `### Hit response (hitResponse)`; **`docs/ru/core.md`** — в конец `## Тело танка` подраздел
  `### Реакция корпуса на попадание (hitResponse)`. Содержание: только хост; формула; три состояния (`drives`,
  `grip`, полёт); почему (числа из раздела «Физика» README: Δv/3.3, Δv/23, тяга за ~0.07 с, доворот едущего танка
  уводит путь); без блока — `apply_impulse_at_point` бит-в-бит; пропы всегда в точке попадания; реплика и снапшот не
  меняются — свой танк получает скорость в авторитетном кадре.
- **Таблица тестов** `## Tests` / `## Тесты`: строка Rust unit — «hit response in hull axes
  (`motion::hit_impulse`)»; строка Rust integration — «hit response: the point impulse without the block, hull axes
  with it, no idle factor while driving, oil equal to asphalt, props untouched».
- **`docs/*/configuration.md`**, раздел `### models.js`: абзац про необязательный блок `hitResponse`
  (`lateralFactor`, `idleFactor`, `spinFactor`) — смысл, диапазоны проверки, «нет блока — импульс в точке
  попадания». Числа появятся на этапе 4.
- **`CHANGELOG.md → [Unreleased] → ### Added`**:
  ```
  - `hitResponse` model block (`lateralFactor`, `idleFactor`, `spinFactor`):
    a hitscan hit on a tank is applied in the hull's axes — the lateral part
    follows the grip under the tracks (only the damping in flight), the
    longitudinal one is scaled while the engine is idle, and the spin is scaled
    on its own; without the block a hit pushes at the hit point as before
    (`core/src/motion.rs`, `TanksSim::process_hitscan`).
  ```

## 3.7 Проверки

`cargo test --workspace -q` (из `core/`), `npm run core:build`, `npx eslint . --quiet`,
`npx vitest run --reporter=dot`, затем сценарии (правило 7 README) с `--determinism`. **Всё должно остаться
зелёным и неизменным**: игровых значений этап не трогает. Любое изменение поведения игры — ошибка в ветке «нет
блока».

Отметить этап «✅ выполнен» в этом файле и в `README.md`.
