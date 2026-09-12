# Этап 1. Ядро: потолок прыжка и мёртвая зона урона падения ✅ выполнен

Закрывает проблему 2 целиком и половину проблемы 3 (вторая половина —
карта, этап 7).

## Диагноз

### 1.1. Дуга прыжка ничем не ограничена

`core/src/level.rs`, ветка вылета с рампы (функция `step_layered`, блок
после комментария «вылет с рампы: тело только что сошло с прогона»):

```rust
let vz = (prev_slope[0] * vel[0] + prev_slope[1] * vel[1]) / levels.level_height()
    * rules.ramp_launch_factor;

if vz >= rules.min_launch_vz {
```

`prev_slope` — безразмерный уклон (`rise · levelHeight / span`), `vel` —
мировая скорость. На `terraces`/`rampSteep` уклон 0.5, `levelHeight` по
умолчанию равен `tileSize` (`32 × scale 0.4 = 12.8`), скорость на подъёме
≈ 195 ед/с ⇒ `vz ≈ 0.5 · 195 / 12.8 = 7.6`, а замер даёт **9.21** (танк
успевает разогнаться сильнее). Дальше:

- высота дуги `vz² / (2g)`, где `g = 2 / fallTime² = 16.33` ⇒ **2.6
  уровня**;
- `clear_walls` включается при `z ≥ from + jumpClearance (0.2)` и держится
  почти весь полёт, а `LevelState::collision_mask()` отдаёт в этом
  состоянии `Group::empty()` — танк не видит НИЧЕГО, включая периметр
  карты;
- время полёта 1.13 с, горизонт ≈ 17 тайлов.

Нижняя граница у вылета есть (`min_launch_vz`), верхней — нет. Она и
нужна.

### 1.2. У урона падения нет мёртвой зоны

`core/src/tanks.rs`, `apply_fall_damage`:

```rust
let damage = (self.level_rules.fall_damage * height as f64)
    .min(self.level_rules.max_fall_damage);
```

`height` — дробная высота дуги (`peak − уровень приземления`). Любой
подскок, даже на 0.05 уровня, стоит HP. Прыжок с `rampSteep` стоит
`15 × 2.6 = 39 HP`, хотя танк никуда не упал — вернулся на ту же плиту.

### 1.3. Тест не сторожит верхнюю границу

`core/tests/sim.rs::terraces_ramp_launches_the_tank` проверяет
`peak > 2.0` и факт приземления. Дуга в 2.6 уровня, в 10 уровней и в 0.3
уровня проходят этот тест одинаково.

## Решение

### Шаг 1.1. Новые правила в `core/src/config.rs`

В структуру `LevelRules` (там же, где `ramp_launch_factor`,
`min_launch_vz`, `jump_clearance`) добавить два поля. Порядок полей
значения не имеет — структура читается serde по именам.

```rust
    /// Потолок вертикальной скорости вылета (уровней/с). Без него дуга
    /// зависит только от уклона и скорости: крутой прогон `terraces`
    /// давал 9.2 уровней/с — подскок на 2.6 уровня, перелёт периметра
    /// карты и 39 HP урона за прыжок. 0 — потолка нет (прежнее
    /// поведение).
    #[serde(default = "default_max_launch_vz")]
    pub max_launch_vz: f32,

    /// Мёртвая зона урона падения (в уровнях): высота дуги, которая
    /// ничего не стоит. Прыжок с рампы возвращает танк на ту же плиту и
    /// не обязан стоить HP, а обрыв обязан.
    #[serde(default = "default_fall_damage_free_height")]
    pub fall_damage_free_height: f32,
```

Дефолты рядом с `default_jump_clearance`:

```rust
// потолок дуги: 3.5 уровней/с при g = 16.33 дают подскок 0.375 уровня —
// заметный на глаз прыжок, который не перелетает перила и не долетает до
// `jump_clearance`
fn default_max_launch_vz() -> f32 {
    3.5
}

// дуга ниже половины уровня урона не стоит: это подскок, а не падение
fn default_fall_damage_free_height() -> f32 {
    0.5
}
```

В `impl Default for LevelRules` добавить:

```rust
            max_launch_vz: default_max_launch_vz(),
            fall_damage_free_height: default_fall_damage_free_height(),
```

В `TanksConfig::validate()` (строка 304) — рядом с проверками
`ramp_launch_factor`/`min_launch_vz`/`jump_clearance`:

```rust
        if self.levels.max_launch_vz < 0.0 {
            return Err(format!(
                "levels.maxLaunchVz must be >= 0, got {}",
                self.levels.max_launch_vz
            ));
        }

        if self.levels.fall_damage_free_height < 0.0 {
            return Err(format!(
                "levels.fallDamageFreeHeight must be >= 0, got {}",
                self.levels.fall_damage_free_height
            ));
        }
```

### Шаг 1.2. Потолок в `core/src/level.rs`

В `step_layered`, в ветке вылета с рампы, между вычислением `vz` и
проверкой `min_launch_vz`:

```rust
        let raw_vz = (prev_slope[0] * vel[0] + prev_slope[1] * vel[1])
            / levels.level_height()
            * rules.ramp_launch_factor;

        // потолок дуги: без него `vz` зависит только от уклона и
        // скорости, и крутой прогон закидывает танк выше любой геометрии
        // карты (замер на `terraces`: 9.2 уровней/с, дуга 2.6 уровня).
        // 0 — потолка нет
        let vz = if rules.max_launch_vz > 0.0 {
            raw_vz.min(rules.max_launch_vz)
        } else {
            raw_vz
        };

        if vz >= rules.min_launch_vz {
```

Ниже по коду ничего не меняется: `vz` уже ограничен.

### Шаг 1.3. Мёртвая зона урона в `core/src/tanks.rs`

`apply_fall_damage` (строка 937). Новое тело расчёта:

```rust
        // урон считает не вся дуга, а её часть выше мёртвой зоны: прыжок
        // с рампы возвращает танк на ту же плиту и стоить HP не обязан,
        // а обрыв обязан. `fallDamage` — цена за уровень СВЕРХ зоны,
        // поэтому падение ровно с одного уровня стоит
        // `fallDamage · (1 − freeHeight)`
        let paid = (height - self.level_rules.fall_damage_free_height).max(0.0);
        let damage =
            (self.level_rules.fall_damage * paid as f64).min(self.level_rules.max_fall_damage);
```

`if damage <= 0.0 { return; }` ниже остаётся — он же и отсекает подскоки.

### Шаг 1.4. Перенастройка `src/config/game.js`

Блок `coreParams.levels` (строки 45–90). Изменяемые и новые значения:

```js
      fallDamage: 30, // урон за уровень СВЕРХ мёртвой зоны (0 — падение бесплатно)
      // высота дуги, которая ничего не стоит: прыжок с рампы возвращает
      // танк на ту же плиту. При freeHeight 0.5 и fallDamage 30 падение
      // ровно с одного уровня стоит прежние 15 HP
      fallDamageFreeHeight: 0.5,
      maxFallDamage: 100, // потолок урона падения
```

```js
      // множитель вертикальной скорости на вылете с верхнего торца
      // рампы: 0 — прыжка нет вовсе, 1 — вся вертикальная составляющая
      // скорости на уклоне уходит в полёт. 1.0 давал на крутом прогоне
      // `terraces` дугу в 2.6 уровня (замер), поэтому доля
      rampLaunchFactor: 0.35,
      // порог вылета (уровней/с): ниже него прыжок не начинается, иначе
      // съезд по рампе шагом рождал бы микропрыжки на каждой клетке
      minLaunchVz: 0.35,
      // потолок вылета (уровней/с). При g = 2/fallTime² = 16.33 он задаёт
      // максимальную дугу: vz²/(2g) = 0.375 уровня. Обязан быть НИЖЕ
      // jumpClearance, иначе штатный прыжок перелетает стены и периметр
      maxLaunchVz: 3.5,
      // насколько выше уровня взлёта (в уровнях) танк перестаёт видеть
      // стены — то есть перепрыгивает препятствия. Выше максимальной дуги
      // (см. maxLaunchVz): перелёт остаётся механикой ядра, но штатным
      // прыжком недостижим — карте, которой он нужен, достаточно поднять
      // rampLaunchFactor/maxLaunchVz
      jumpClearance: 0.45,
```

**Итоговая арифметика после правки** (её обязан воспроизводить тест шага
1.5): `rampLaunchFactor 0.35` от замеренных 9.21 даёт 3.22, потолок 3.5 не
срабатывает ⇒ дуга `3.22²/(2·16.33) = 0.318` уровня, время полёта
`2·3.22/16.33 = 0.39 с`, горизонт ≈ 77 мировых единиц (≈ 6 тайлов),
`impact` касания 3.22, урон `30 · max(0, 0.318 − 0.5) = 0`.
`0.318 < jumpClearance 0.45` ⇒ `clear_walls` не включается никогда.

### Шаг 1.5. Тесты

**`core/src/level.rs`, модуль `tests`** — рядом с существующими тестами
вылета:

1. `launch_speed_is_capped`: правила с `ramp_launch_factor = 1.0`,
   `max_launch_vz = 1.0`; прогнать сход с крутого прогона на большой
   скорости; достать `Transit::Airborne { vz, .. }` и проверить
   `vz <= 1.0 + 1e-6`.
2. `zero_cap_means_no_cap`: те же входные данные, `max_launch_vz = 0.0` ⇒
   `vz` заметно больше 1.0 (прежнее поведение сохранено).
3. `a_capped_jump_never_clears_walls`: правила `max_launch_vz = 3.5`,
   `jump_clearance = 0.45`, `fall_time = 0.35`; прокрутить весь полёт
   шагами `dt = 1/60` и убедиться, что `state.clear_walls` не был `true`
   ни на одном шаге.

**`core/src/tanks.rs` тестового модуля не имеет** — тесты урона живут в
`core/tests/sim.rs` рядом с `landing_applies_fall_damage`. Добавить туда:

4. `a_ramp_jump_costs_no_health`: `terraces`, спавн у подножия
   `rampSteep` (как в `terraces_ramp_launches_the_tank`), полный газ;
   после приземления `condition` танка равен стартовому.
5. `a_one_level_fall_still_costs_the_old_price`: сценарий существующего
   `landing_applies_fall_damage`, но проверяется КОНКРЕТНОЕ значение:
   потеря ровно `fallDamage · (1 − fallDamageFreeHeight)` HP. Это и есть
   защита от того, что кто-то поправит `fallDamage`, забыв про зону.

**`core/tests/sim.rs::terraces_ramp_launches_the_tank`** — добавить
верхнюю границу рядом с существующей нижней:

```rust
    // верхняя граница так же обязательна, как нижняя: без неё регрессия
    // настройки (rampLaunchFactor 1.0 давал дугу в 2.6 уровня) тесту
    // невидима
    assert!(
        peak < 2.0 + 0.6,
        "дуга прыжка обязана оставаться в пределах полуметра-уровня, peak = {peak}"
    );
```

**`core/src/config.rs`, модуль `tests`** — по образцу
`validate_rejects_negative_fall_damage`: `validate_rejects_negative_max_launch_vz`
и `validate_rejects_negative_fall_damage_free_height`.

**`tests/config/game.test.js`** (если в нём уже есть проверки блока
`levels` — посмотреть) — добавить утверждение
`maxLaunchVz² / (2 · 2 / fallTime²) < jumpClearance`: это инвариант
«штатный прыжок не перелетает стены», и он обязан быть виден в тесте, а не
только в комментарии.

## Проверка этапа

```bash
npm run core:test && npx eslint . && npm test && npm run core:build
npm run build && npm run sim:scenarios
```

Ручная: `VITE_MAP='terraces' npm run dev`, `team1`, держать `W` на крутой
рампе — танк подскакивает заметно, но невысоко, HP не теряет,
приземляется на верхнюю площадку.

## Оговорки для исполнителя

- `sim:scenarios` на `jump.json` после этого этапа обязан остаться
  зелёным. Если `predictionDrift` покраснеет — смотреть на
  `Predictor::correct_level`: реплика берёт `vz` из кадра, а кадр её
  округляет (`round2`), так что потолок обязан применяться ДО округления,
  то есть в `level.rs`, а не в `snapshot_row`. Правка шага 1.2 это
  условие выполняет; переносить потолок в `snapshot_row` нельзя.
- `fallDamage 15 → 30` меняет цену падения с ДВУХ уровней: было 30 HP,
  станет 45. Это осознанное следствие выбранной формулы; если оно
  нежелательно, регулируется `maxFallDamage`. Записать в CHANGELOG
  (`### Changed`) на этапе 7.
