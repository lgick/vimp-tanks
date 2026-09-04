# Этап 3 — ядро танков: уровни в симуляции ✅ выполнен

**Репозиторий:** `T` = `/Users/dmitry/Sites/my/vimp-tanks`
**Крейт:** `core/` (`vimp-tanks-core`)

Цель: танк знает свой уровень, поднимается по рампам, падает с обрывов,
физически видит только свой уровень, и всё это уезжает клиенту в блоке `m1`.

Предусловия: этапы 1 и 2 зелёные, `[patch.crates-io]` на локальный движок
стоит, `npm run core:build` проходит.

## 3.1 Конфигурация правил уровней

### `src/config/game.js`

Добавить рядом с `mapSetId` (в корень объекта, НЕ в `parts`):

```js
  // собственные параметры Rust-ядра игры: движок довозит объект целиком в
  // половину `game` init-JSON, не читая его (lib/coreConfig.js). Требует
  // vimp-engine >= <версия этапа 2>
  coreParams: {
    // правила 2.5D-уровней; одноуровневые карты их не касаются
    levels: {
      fallTime: 0.35, // с — длительность падения с моста до земли
      fallDamage: 15, // урон при приземлении (0 — падение бесплатно)
    },
  },
```

### `core/src/config.rs`

```rust
/// Правила 2.5D-уровней (game.js coreParams.levels). Одноуровневая карта
/// их не использует, поэтому все поля имеют умолчания: игра, забывшая
/// секцию, не падает — она просто не платит за падение.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LevelRules {
    #[serde(default = "default_fall_time")]
    pub fall_time: f32,
    #[serde(default)]
    pub fall_damage: f64,
}

impl Default for LevelRules {
    fn default() -> Self {
        Self { fall_time: default_fall_time(), fall_damage: 0.0 }
    }
}

fn default_fall_time() -> f32 {
    0.35
}
```

`TanksConfig` дополнить:

```rust
    #[serde(default)]
    pub levels: LevelRules,
```

`TanksConfig::validate` дополнить: `fall_time > 0.0` (иначе деление на ноль
в интерполяции z), `fall_damage >= 0.0`.

## 3.2 `core/src/level.rs` — правила уровней (новый файл)

Чистые функции над `MapLevels` движка. **Единственный источник правил
уровня для обеих сторон**: хост зовёт их из `TanksSim`, клиентская реплика
— из `Predictor` (этап 5). Ни одной ветки, зависящей от того, кто зовёт.

```rust
//! Правила 2.5D-уровней: рампы, обрывы, падение. Чистые функции над
//! `MapLevels` (геометрия слоёв, крейт движка) — авторитетный путь
//! (`TanksSim::update_levels`) и клиентская реплика (`client::predictor`)
//! обязаны звать ровно их, иначе предсказание уровня разъедется с
//! авторитетным молча.

use serde::{Deserialize, Serialize};
use vimp_engine_core::map::MapLevels;
use vimp_engine_core::physics::lerp;

use crate::config::LevelRules;

/// Состояние перехода между уровнями.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Transit {
    /// Стоит на своём уровне.
    Grounded,
    /// Центр корпуса на клетке рампы: коллизии ОБОИХ уровней.
    Ramp,
    /// Свободное падение с обрыва: коллизий нет, ввод заблокирован.
    Falling { elapsed: f32, from: u8 },
}

/// Уровень танка/тела и его визуальная высота.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct LevelState {
    pub level: u8,
    /// 0.0 — земля, 1.0 — плита моста; дробные значения — рампа/падение.
    pub z: f32,
    pub transit: Transit,
}

impl Default for LevelState {
    fn default() -> Self {
        Self { level: 0, z: 0.0, transit: Transit::Grounded }
    }
}

/// Что случилось на этом шаге.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum LevelEvent {
    None,
    /// Танк только что коснулся земли после падения.
    Landed,
}

impl LevelState {
    /// Игнорирует ли ввод (падение).
    pub fn input_locked(&self) -> bool {
        matches!(self.transit, Transit::Falling { .. })
    }

    /// Битовая маска уровней, которые тело сейчас видит физически.
    /// `Falling` — пустая маска: падающий не задевает ничего.
    pub fn collision_mask(&self) -> Group {
        match self.transit {
            Transit::Falling { .. } => Group::NONE,
            Transit::Ramp => level_group(0) | level_group(1),
            Transit::Grounded => level_group(self.level),
        }
    }
}

/// Шаг правил уровня для точки `(x, y)`. Вызывается ДО применения ввода и
/// ДО шага физики — так маска коллизий уже верна для наступающего шага.
pub fn step_level(
    state: &mut LevelState,
    x: f32,
    y: f32,
    levels: &MapLevels,
    rules: &LevelRules,
    dt: f32,
) -> LevelEvent {
    // одноуровневая карта: уровня как понятия нет
    if !levels.is_layered() {
        *state = LevelState::default();
        return LevelEvent::None;
    }

    if let Transit::Falling { elapsed, from } = state.transit {
        let elapsed = elapsed + dt;
        let t = (elapsed / rules.fall_time).clamp(0.0, 1.0);

        state.z = lerp(from as f32, 0.0, t);

        if t >= 1.0 {
            state.level = 0;
            state.z = 0.0;
            state.transit = Transit::Grounded;

            return LevelEvent::Landed;
        }

        state.transit = Transit::Falling { elapsed, from };

        return LevelEvent::None;
    }

    if let Some(ramp) = levels.ramp_at(x, y) {
        let (low, high) = if ramp.from < ramp.to { (ramp.from, ramp.to) } else { (ramp.to, ramp.from) };

        state.transit = Transit::Ramp;
        state.z = lerp(ramp.from as f32, ramp.to as f32, ramp.progress);
        // уровень щёлкает на середине; коллизии на рампе всё равно обоих
        // уровней, поэтому щелчок не создаёт ни проваливания, ни толчка
        state.level = if state.z >= 0.5 { high } else { low };

        return LevelEvent::None;
    }

    state.transit = Transit::Grounded;

    if state.level >= 1 && !levels.has_floor(state.level, x, y) {
        state.transit = Transit::Falling { elapsed: 0.0, from: state.level };
        state.z = state.level as f32;

        return LevelEvent::None;
    }

    state.z = state.level as f32;

    LevelEvent::None
}
```

> **Почему `level` щёлкает на 0.5, а не на кромке.** На рампе маска —
> «оба уровня», значит физически ничего от щелчка не зависит. Щелчок нужен
> только чтобы после съезда с рампы состояние было определено: съехал
> вверху — уровень 1, скатился вниз — уровень 0.

> **Авторское правило карты.** Перила уровня 1 нельзя ставить вплотную к
> НИЗУ рампы: танк у подножия уже видит маску обоих уровней и упрётся в
> них. Записать это в `docs/*/extending.md` (этап 8).

## 3.3 `core/src/tank.rs`

### Поля

```rust
    /// Хендл коллайдера корпуса: маска уровней переписывается каждый раз,
    /// когда танк меняет уровень, а искать коллайдер через тело на каждом
    /// шаге — лишняя работа в горячем пути
    pub collider: ColliderHandle,
    /// Уровень, высота и переход (2.5D-карты).
    pub level_state: LevelState,
```

`Tank::new`: сохранить хендл, который вернул `world.insert_collider`, и
выставить стартовую маску `level_interaction(0)`:

```rust
    let collider = world.insert_collider(
        ColliderBuilder::cuboid(width / 2.0, height / 2.0)
            .density(model.fixture.density)
            .friction(model.fixture.friction)
            .restitution(model.fixture.restitution)
            .active_events(ActiveEvents::COLLISION_EVENTS)
            // стартуем на земле; слоёная карта переставит маску первым же
            // шагом `update_levels`
            .collision_groups(level_interaction(0)),
        Some(body_handle),
    );
```

### `update`

Первым делом — гейт падения. Танк в свободном падении не рулит и не
стреляет, но его скорость сохраняется (он летит по инерции, как в ТЗ):

```rust
        // падение: ввод игнорируется целиком (клавиши остаются нажатыми и
        // подхватятся при приземлении), выстрел не производится
        if self.level_state.input_locked() {
            self.update_cooldowns(dt);
            self.engine_load = 0.0;

            return None;
        }
```

Поставить его сразу после `let keys = self.keys_for_processing();` —
одноразовые клавиши всё равно надо снять, иначе они «залипнут» до посадки.

### `change_player_data`

Сбросить уровень: `self.level_state = LevelState::default();` — фактический
уровень выставит `set_level`/`update_levels` сразу после.

### Новые методы

```rust
    /// Явный уровень (точка респауна назвала его) — снапом, без перехода.
    pub fn set_level(&mut self, level: u8) {
        self.level_state = LevelState { level, z: level as f32, transit: Transit::Grounded };
    }

    /// Переписывает маску коллизий корпуса под текущее состояние уровня.
    pub fn sync_collision_groups(&self, world: &mut PhysicsWorld) {
        if let Some(collider) = world.colliders.get_mut(self.collider) {
            collider.set_collision_groups(levels_interaction(self.level_state.collision_mask()));
        }
    }
```

### `snapshot_row`

Расширить возвращаемый кортеж двумя значениями — `z` и `level`:

```rust
    pub fn snapshot_row(&self, body: &RigidBody, size: f32) -> ([f32; 7], u8, u8, u8, f32, f32, u8) {
        // ... как сейчас, плюс:
        // round2(self.level_state.z), self.level_state.level
    }
```

`prediction_state` **не меняется** — `PLAYER_STATE_LEN` остаётся 8, уровень
клиент выводит сам (этап 5).

## 3.4 `core/src/tanks.rs`

### `TankRow`

```rust
struct TankRow {
    floats: [f32; 7],
    condition: u8,
    size: u8,
    team: u8,
    angvel: f32,
    z: f32,
    level: u8,
}
```

`fields()` дописывает `FieldValue::F32(self.z)` и `FieldValue::U8(self.level)`
после `angvel` — порядок обязан совпасть со схемой `m1` (3.6).

### `TanksSim` — новое поле

```rust
    level_rules: crate::config::LevelRules,
```

заполняется в `new` из `cfg.levels.clone()`.

### `set_actor_level`

Реализовать метод трейта `GameSim`:

```rust
    fn set_actor_level(&mut self, world: &mut PhysicsWorld, game_id: u32, level: u8) {
        if let Some(tank) = self.tanks.get_mut(&game_id) {
            tank.set_level(level);
            tank.sync_collision_groups(world);
        }
    }
```

### `spawn_actor` / `reset_actor` — уровень по геометрии

Оба метода получают только `x, y`. Уровень выводится из карты — но карта
живёт в `EngineSim`, а не в `TanksSim`, и в `spawn_actor` её нет.

Решение: `TanksSim` держит **свою копию** слоёв, синхронизируемую на
первом же тике после смены карты:

```rust
    /// Слоистая геометрия текущей карты. `None` — карта ещё не приезжала
    /// или она одноуровневая. Обновляется в `on_fixed_step` по указателю
    /// на карту из `SimCtx` (у `spawn_actor` карты нет вовсе).
    levels: Option<MapLevels>,
    /// Танки, заспавненные до того, как слои доехали, — им уровень
    /// назначается первым же `update_levels`
    levels_dirty: bool,
```

В `on_fixed_step`, ПЕРВЫМ действием:

```rust
        // слои карты приезжают вместе с картой, а `spawn_actor` карты не
        // видит: держим копию геометрии и пересчитываем уровни всех танков,
        // когда она сменилась
        let map_layered = ctx.map.as_ref().is_some_and(|map| map.is_layered());

        if map_layered {
            let same = self
                .levels
                .as_ref()
                .is_some_and(|levels| std::ptr::eq(levels as *const _, /* см. ниже */));
            // проще и надёжнее: хранить set_id + размерность как отпечаток
        }
```

> **Проще:** держать `levels_fingerprint: (String, usize, usize)` —
> `set_id`, число строк и число колонок грида уровня 0. Если отпечаток
> текущей `ctx.map` отличается — пересобрать `self.levels =
> Some(map.levels().clone())` и выставить `levels_dirty = true`.
> `MapLevels` — `Clone`, копия делается раз на карту, не на тик.

### `update_levels` — новый метод `TanksSim`

Зовётся в `on_fixed_step` СРАЗУ ПОСЛЕ синхронизации слоёв и ДО цикла
`tank.update(...)`:

```rust
    /// Правила уровней для всех танков: рампы, обрывы, падение, маски
    /// коллизий. Идёт ДО применения ввода — маска обязана быть верной для
    /// наступающего шага физики.
    fn update_levels(&mut self, ctx: &mut SimCtx, dt: f32) {
        let Some(levels) = self.levels.as_ref() else {
            return;
        };

        let ids: Vec<u32> = self.tanks.keys().copied().collect();

        for id in ids {
            let Some(tank) = self.tanks.get_mut(&id) else { continue };
            let Some(body) = ctx.world.bodies.get(tank.body) else { continue };
            let pos = body.translation();

            let before = tank.level_state;
            let event = crate::level::step_level(
                &mut tank.level_state, pos.x, pos.y, levels, &self.level_rules, dt,
            );

            if tank.level_state.collision_mask() != before.collision_mask() {
                tank.sync_collision_groups(ctx.world);
            }

            if event == crate::level::LevelEvent::Landed {
                self.apply_fall_damage(ctx, id);
            }
        }
    }
```

`levels_dirty`: перед циклом, если флаг взведён, выставить каждому танку
`set_level(levels.level_at(x, y))` и сбросить флаг — иначе танк,
заспавненный до приезда карты, останется на уровне 0 внутри моста.

### `apply_fall_damage`

```rust
    /// Урон при приземлении после падения с моста. Стрелка нет — урон
    /// приходит от самой карты, поэтому дружественный огонь и тряска
    /// оружия не при чём, а смерть засчитывается как самоубийство.
    fn apply_fall_damage(&mut self, ctx: &mut SimCtx, game_id: u32) {
        let damage = self.level_rules.fall_damage;

        if damage <= 0.0 {
            return;
        }

        let destroyed = {
            let Some(tank) = self.tanks.get_mut(&game_id) else { return };
            let Some(body) = ctx.world.bodies.get_mut(tank.body) else { return };

            tank.take_damage(damage, body, ctx.events)
        };

        if destroyed {
            ctx.events.push(CoreEvent::Death { victim: game_id, killer: game_id });
        }
    }
```

> **Проверить перед реализацией:** как движковая мета (`RoundManager` /
> статистика) обрабатывает `Death { victim, killer }` при `victim ==
> killer`. Если она начисляет фраг самому себе — либо она уже трактует это
> как самоубийство (тогда ничего не делаем), либо в этап 8 добавляется тест
> и правка меты движка. Смотреть обработчик события `death` в
> `packages/engine/src/host/GameCoreAdapter.js` и в мете статистики.

### `spawn_actor` — уровень для нового танка

Сразу после `self.tanks.insert(game_id, tank);`:

```rust
        // карта уже могла приехать: назначаем уровень по геометрии сразу,
        // иначе первый кадр покажет танк на земле внутри плиты моста
        if let Some(levels) = self.levels.as_ref() {
            if let Some(tank) = self.tanks.get_mut(&game_id) {
                tank.set_level(levels.level_at(x, y));
            }
        }
```

Аналогично в `reset_actor` после `change_player_data`.

### `on_fixed_step` — итоговый порядок

```
1. синхронизация self.levels с ctx.map (по отпечатку)
2. update_levels(ctx, dt)          // уровень, z, маски, урон от падения
3. цикл по танкам: tank.update(...) // ввод -> импульсы -> выстрел
4. process_shots_expired_by_time
```

### `refresh_cached`

Разобрать расширенный кортеж `snapshot_row` и положить `z`/`level` в
`TankRow`.

### `players_json`

Сегодня метод кладёт 10 значений (7 float + condition/size/team) и **молча
теряет `angvel`**, хотя схема `m1` его объявляет. Пути JSON и бинарного
кадра расходятся по ширине строки — сейчас это безобидно только потому, что
парты не читают индекс 10.

С добавлением `z`/`level` расхождение станет ошибкой: парт прочтёт `level`
по индексу 12, а JSON-путь этот индекс не заполнит. Поэтому:

```rust
            // полный порядок полей схемы m1: 7 float, condition, size,
            // team, angvel, z, level. Раньше метод обрывался на team, из-за
            // чего первый кадр (FIRST_SHOT_DATA) и бинарные кадры имели
            // разную ширину строки — с приходом level это стало ошибкой
            for value in row.floats { arr.push(Value::from(value as f64)); }
            arr.push(Value::from(row.condition));
            arr.push(Value::from(row.size));
            arr.push(Value::from(row.team));
            arr.push(Value::from(row.angvel as f64));
            arr.push(Value::from(row.z as f64));
            arr.push(Value::from(row.level));
```

`Vec::with_capacity(10)` → `with_capacity(13)`.

### `clear` / `serialize` / `deserialize`

* `clear`: `self.levels = None; self.levels_fingerprint = None; self.levels_dirty = false;`
* `TanksDump`/`TanksDumpOwned`: `Tank` сериализуется целиком, `level_state`
  поедет сам (он `Serialize`/`Deserialize`). `MapLevels` в дамп **не
  включать** — карта восстанавливается своим путём (`restoreMap` меты), а
  дублирование гридов раздуло бы дамп эстафеты Worker'ов.
  После `deserialize` выставить `levels_dirty = true`.

### `rebuild_spatial_grid`

`SpatialEntity` уровня не несёт (движковая структура). Боты берут уровень
цели через `BotView.tanks[&id].level_state.level` — правок здесь нет.

## 3.5 `core/src/body_tag.rs`

Правок нет: уровень тела читается из масок коллайдера
(`collider.collision_groups().memberships`), а не из тега. Так уровень
динамики карты (у которой тег движковый, без игровых полей) и уровень
танка читаются одним способом.

## 3.6 `src/config/snapshot.js` — схема `m1`

Дописать ДВА поля в конец списка `m1.fields` (порядок позиционно связан с
`TankRow::fields`):

```js
      // 2.5D: визуальная высота 0..1 (рампа/падение) и дискретный уровень.
      // z интерполируется — подъём по рампе и падение обязаны быть плавными
      // у зрителя; level дискретен — он переключает zIndex и набор
      // коллизий, промежуточных значений у него нет
      { name: 'z', ty: 'f32', interp: 'lerp' },
      { name: 'level', ty: 'u8' },
```

Обновить комментарий в шапке файла: перечислить, что `render_overlay`
клиентского ядра обязан отдавать хвост той же ширины (этап 5).

## 3.7 Тесты

### Rust (`core/src/...`)

| Файл | Тест | Что проверяет |
| --- | --- | --- |
| `level.rs` | `flat_map_keeps_level_zero` | Неслоёная `MapLevels` → состояние всегда дефолтное |
| `level.rs` | `ramp_raises_z_and_snaps_level_at_half` | Прогресс 0.2 → z 0.2, level 0; прогресс 0.7 → z 0.7, level 1 |
| `level.rs` | `ramp_sets_both_level_masks` | На рампе `collision_mask()` содержит оба бита |
| `level.rs` | `leaving_slab_starts_falling` | Уровень 1, точка без плиты → `Falling`, маска пустая, ввод заблокирован |
| `level.rs` | `falling_lands_after_fall_time` | Через `fallTime` — `Landed`, level 0, z 0 |
| `level.rs` | `slab_keeps_the_tank_grounded` | Уровень 1 на плите → `Grounded`, z 1 |
| `tank.rs` | `falling_tank_ignores_input` | `update` при `Falling` возвращает `None` и не даёт импульсов |
| `tank.rs` | `snapshot_row_carries_level_and_z` | Кортеж содержит округлённый z и level |
| `tanks.rs` | `spawn_on_slab_starts_on_level_one` | Спавн в точке плиты → `level == 1` |
| `tanks.rs` | `set_actor_level_overrides_geometry` | Явный `set_actor_level(id, 0)` под мостом → level 0 |
| `tanks.rs` | `landing_applies_fall_damage` | Здоровье падает на `fallDamage`, при добивании — `Death{victim==killer}` |
| `tanks.rs` | `tanks_on_different_levels_do_not_collide` | Два танка в одной точке на разных уровнях: `world.step()` не порождает контакта |
| `tanks.rs` | `players_json_matches_schema_width` | Длина массива строки == числу полей схемы `m1` |
| `config.rs` | `level_rules_default_when_absent` | `game` без `levels` → `fallTime 0.35`, `fallDamage 0` |
| `config.rs` | `validate_rejects_zero_fall_time` | |

### JS (`tests/`)

| Файл | Тест |
| --- | --- |
| `tests/config/game.test.js` | `coreParams.levels присутствует и валиден` |
| `tests/core/core.test.js` | сквозной: загрузить слоёную карту-фикстуру, заспавнить танк на плите, шагнуть, прочитать кадр — `level == 1` в блоке `m1` |

Фикстуру слоёной карты положить в `tests/core/fixtures/layered.json`
(маленькая, 6×6) и переиспользовать в этапах 4–7.

## 3.8 Changelog и документация

* `CHANGELOG.md` → `### Added`: уровни танка (`level`, `z`), рампы,
  падение с обрыва с уроном, поля `z`/`level` в блоке `m1`,
  `coreParams.levels`. Пункт «`players_data()` теперь отдаёт строку полной
  ширины схемы» — в `### Fixed`.
* `docs/en|ru/core.md`: раздел про `core/src/level.rs`, порядок
  `on_fixed_step`, маски коллизий, падение.
* `docs/en|ru/configuration.md`: `coreParams.levels` и схема `m1` с новыми
  полями.
* `docs/en|ru/gameplay.md`: как игрок заезжает на мост и что происходит при
  падении.

## Критерии готовности этапа

```bash
cd /Users/dmitry/Sites/my/vimp-tanks
npm run core:build && npm run core:test && npx eslint . && npm test -- --silent
npm run build && npm run sim:scenarios
```

Все 4 существующих сценария зелёные (одноуровневые карты не изменились).

Отметить `✅ выполнен` здесь и в `plan/README.md`.
