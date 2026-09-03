# Этап 5 — клиентское предсказание со слоями

**Репозиторий:** `T` = `/Users/dmitry/Sites/my/vimp-tanks`
**Крейт:** `core/src/client/` (`ClientCore`)

Цель: клиент предсказывает уровень своего танка по тем же правилам, что и
хост; предсказанные контакты не считаются между телами разных уровней;
локальный трассер повторяет сегментацию авторитетного луча.

Инвариант этапа: **формат кадра не меняется**. `PLAYER_STATE_LEN` остаётся
`8`, `level`/`z` в предсказанное состояние не входят — клиент выводит их из
позиции теми же функциями `core/src/level.rs`, а авторитетное значение
приезжает в блоке `m1` и служит жёсткой коррекцией.

Предусловие: этап 4 зелёный.

## 5.1 `core/src/client/mod.rs` — конфиг карты и слои

### `ClientMapConfig`

```rust
    /// Надземные уровни карты (MAP_DATA). Ключ — номер уровня строкой.
    #[serde(default)]
    pub(crate) levels: IndexMap<String, vimp_engine_core::map::MapLevelConfig>,
    #[serde(default)]
    pub(crate) ramps: Vec<vimp_engine_core::map::RampConfig>,
```

### `Grid` → `MapLevels`

Структура `Grid` (`map`, `solid_tiles`, `tile_size`) существует только
затем, чтобы отдать `collect_tile_contacts`/`ray_vs_grid` три вещи. Со
слоями таких троек становится две, а правила уровня всё равно живут в
`MapLevels`. Поэтому `Grid` удаляется, а на её месте — `Rc<MapLevels>`.

```rust
impl ClientMapConfig {
    /// Слоистая геометрия карты. Одна структура на предсказание движения и
    /// на предсказание выстрела: две одинаково построенные разъехались бы
    /// молча (та же причина, по которой раньше здесь был общий `Grid`).
    fn take_levels(&mut self) -> MapLevels {
        MapLevels::build(
            &std::mem::take(&mut self.map),
            &std::mem::take(&mut self.physics_static),
            &self.levels,
            &self.ramps,
            self.step * self.scale,
        )
    }
}
```

`TanksClient::set_map`:

```rust
        let mut cfg: ClientMapConfig = serde_json::from_str(map_json).map_err(|e| e.to_string())?;
        let levels = Rc::new(cfg.take_levels());

        self.predictor.reset();
        self.reset_remote_tanks();
        self.predictor.set_map(&cfg, Rc::clone(&levels));
        self.shot.set_map(levels);
```

Заменить все `Rc<Grid>` на `Rc<MapLevels>` в `Predictor` и `ShotPredictor`,
а обращения `grid.map` / `grid.solid_tiles` / `grid.tile_size` — на
`levels.grid(level)` / `levels.solid(level)` / `levels.tile_size()`.

### Индексы полей `m1`

```rust
// индексы полей строки m1 — позиционный контракт со схемой
// src/config/snapshot.js
const TANK_FIELD_CONDITION: usize = 7;
const TANK_FIELD_SIZE: usize = 8;
const TANK_FIELD_TEAM: usize = 9;
const TANK_FIELD_ANGVEL: usize = 10;
const TANK_FIELD_Z: usize = 11;
const TANK_FIELD_LEVEL: usize = 12;
```

### `track_frame` — жёсткая коррекция уровня

Свой танк уже вычитывается из кадра ради `condition`/`size`/`team`.
Дописать туда уровень:

```rust
                Some(row) => {
                    ...
                    self.my_tank_meta = Some((condition, size, team));
                    self.predictor.freeze(condition == 0);

                    // авторитетный уровень: реплика считает его сама теми же
                    // правилами, но кадр — последнее слово. Расхождение
                    // возможно на границе рампы (кадр отстаёт на буфер
                    // интерполяции), поэтому коррекция применяется только
                    // когда реплика НЕ в переходе: иначе кадр отматывал бы
                    // подъём назад на каждом тике
                    self.predictor.correct_level(field_u8(row, TANK_FIELD_LEVEL));
                }
```

### `render_overlay` — хвост шире на два

```rust
            tail: vec![
                my_model_key_id as f32,
                my_game_id as f32,
                p.x, p.y, p.angle, p.gun_rotation, p.vx, p.vy, p.engine_load,
                condition as f32, size as f32, team as f32, p.angvel,
                // 2.5D: порядок обязан совпадать со схемой m1
                p.z,
                p.level as f32,
            ],
```

`RenderState` дополнить полями `pub z: f32`, `pub level: u8`.

## 5.2 `core/src/client/predictor.rs`

### Поля

```rust
    levels: Option<Rc<MapLevels>>,
    /// Уровень/высота/переход своего танка. Считается теми же функциями
    /// `crate::level`, что и на хосте, — иначе реплика уедет от
    /// авторитетного уровня и на границе рампы танк начнёт мигать между
    /// слоями
    level_state: crate::level::LevelState,
    level_rules: crate::config::LevelRules,
```

`Predictor::new` получает `LevelRules` (передать из `TanksClient::new`,
`cfg.levels` клиентского конфига — см. 5.5).

### `step`

В самом начале `fn step(&mut self, keys: u32)`, до расчёта ввода:

```rust
        // правила уровня — до применения ввода, ровно как в
        // TanksSim::on_fixed_step: иначе шаг падения посчитается по
        // позиции, которую ввод уже сдвинул
        if let Some(levels) = &self.levels {
            crate::level::step_level(
                &mut self.level_state,
                self.state.x,
                self.state.y,
                levels,
                &self.level_rules,
                (self.step_ms / 1000.0) as f32,
            );
        }

        // падение: ввод игнорируется целиком (зеркало Tank::update)
        let keys = if self.level_state.input_locked() { 0 } else { keys };
```

> `LevelEvent::Landed` на клиенте игнорируется: урон авторитетен и приедет
> событием панели. Дублировать его в реплике нельзя — здоровье клиент не
> предсказывает.

### `resolve_world`

Стены собираются по КАЖДОМУ уровню из маски танка:

```rust
        if let Some(levels) = &self.levels {
            let mask = self.level_state.collision_mask();

            for index in 0..movable {
                let obb = Box2 { ... };

                for level in 0..levels.level_count() as u8 {
                    if !mask.intersects(level_group(level)) {
                        continue;
                    }

                    let Some(grid) = levels.grid(level) else { continue };
                    let hits = collect_tile_contacts(&obb, grid, levels.solid(level), levels.tile_size());

                    for hit in hits { /* как сейчас */ }
                }
            }
        }
```

> **Ловушка.** `movable` включает тела подсистем (ящики карты, чужие танки),
> а у них уровень СВОЙ, не танковый. Тело подсистемы обязано брать свою
> маску: `PredictedBody` дополняется полем `level: u8` (см. 5.3/5.4), а
> цикл выше берёт маску `mask` для индекса 0 (свой танк) и
> `level_group(bodies[index - 1].level)` для остальных.

Пары тел (`obb_vs_obb`) фильтруются по пересечению масок:

```rust
                // тела разных уровней не касаются: танк на мосту не толкает
                // ящик под мостом
                if mask_of(a) & mask_of(b) == Group::NONE { continue; }
```

где `mask_of(0)` = маска танка, `mask_of(i)` = `level_group(bodies[i-1].level)`.

Гейт в начале метода `self.grid.is_none() && self.sets.is_empty()` меняется
на `self.levels.is_none() && self.sets.is_empty()`. Плюс: падающий танк
контактов не даёт вовсе —

```rust
        if self.frozen || self.level_state.input_locked() { /* только demote_idle и выход */ }
```

Аккуратно: подсистемы всё равно надо шагнуть, иначе ящики замрут на время
падения. Значит гейт ставится не на весь метод, а на участие ИНДЕКСА 0 в
контактах: собирать `movable` начиная с 1, а свой танк не добавлять в `sim`
при `input_locked()`. Проще и надёжнее: оставить танк в `sim`, но задать
ему пустую маску — тогда он не породит ни одного контакта, а код останется
одним.

### Новые методы

```rust
    /// Авторитетный уровень из кадра. Применяется только вне перехода —
    /// кадр отстаёт на буфер интерполяции, и на рампе он тянул бы реплику
    /// назад каждым тиком.
    pub fn correct_level(&mut self, level: u8) {
        if matches!(self.level_state.transit, crate::level::Transit::Grounded)
            && self.level_state.level != level
        {
            self.level_state.level = level;
            self.level_state.z = level as f32;
        }
    }

    pub fn level_state(&self) -> crate::level::LevelState {
        self.level_state
    }
```

### `reset` / `set_map` / `on_server_state`

* `reset`: `self.level_state = LevelState::default();`
* `set_map`: `self.levels = Some(levels);`
* `on_server_state`: уровень НЕ берётся из авторитетного состояния (его там
  нет). Реплей истории пересчитает `level_state` сам, шаг за шагом, начиная
  с авторитетной позиции. Перед реплеем сбросить только `Falling`:
  ```rust
        // реплей начинается с авторитетной позиции: незавершённое падение
        // из прошлой ветки предсказания к ней не относится
        if let crate::level::Transit::Falling { .. } = self.level_state.transit {
            self.level_state.transit = crate::level::Transit::Grounded;
        }
  ```

### `render_state`

Дописать `z: self.level_state.z`, `level: self.level_state.level`.

## 5.3 `core/src/client/predicted_set.rs`

`PredictedBody` дополнить:

```rust
    /// Уровень тела: контакты считаются только между телами, чьи маски
    /// пересекаются
    pub level: u8,
```

Значение по умолчанию `0`; заполняют `MapDynamics` и `RemoteTanks`.

## 5.4 `core/src/client/map_dynamics.rs` и `remote_tanks.rs`

### `MapDynamics::set_map`

`ClientDynamicObject` дополнить `#[serde(default)] pub(crate) level: u8`
(поле уже приезжает в `physicsDynamic` — см. этап 2) и класть его в
`PredictedBody.level`.

### `RemoteTanks`

* `update` (интерполированный кадр) и `snapshot_bodies` читают
  `TANK_FIELD_LEVEL` из строки и кладут в `PredictedBody.level`.
* `sim_boxes()` меняет форму на `Vec<(u32, Box2, u8)>` (id, бокс, уровень) —
  потребитель (`ShotPredictor::cast_ray`) обязан знать уровень корпуса.
  Либо добавить отдельный `sim_boxes_leveled()`, оставив старый — решить по
  числу вызовов (сейчас вызов один).

## 5.5 `core/src/config.rs` — клиентская половина

`TanksClientConfig` дополнить:

```rust
    #[serde(default)]
    pub levels: LevelRules,
```

Клиентский конфиг собирает движок из `CONFIG_DATA`
(`packages/engine/src/lib/buildClientConfig.js`). Проверить, доезжает ли
туда `coreParams`; если нет — довезти его тем же приёмом, что в этапе 2
(проброс непрозрачного объекта), и дописать правку в `stage_2.md` как
довесок 2.3.

> Если правило падения на клиенте отличается от хостового `fallTime`, танк
> в падении будет приземляться раньше/позже авторитетного и мигать
> уровнем. Значение обязано ехать из одного источника.

## 5.6 `core/src/client/shot.rs`

### Хранимые танки

Структура строки танка внутри `ShotPredictor` (`self.tanks`) дополняется
`level: u8` — читать из `TANK_FIELD_LEVEL` в `update_world` и
`update_world_interpolated`.

### `build_tracer` / `cast_ray`

`cast_ray` получает уровень стрелка и строит те же сегменты, что хост:

```rust
    fn cast_ray(
        &self,
        origin: [f32; 2],
        dir: [f32; 2],
        range: f32,
        my_id: u32,
        shooter_level: u8,
        world: ShotWorld<'_>,
    ) -> Option<(f32, RayTarget, u8)>   // + уровень попадания
```

```rust
        let segments = match &self.levels {
            Some(levels) => crate::shot_levels::ray_segments(levels, origin, dir, range, shooter_level),
            None => vec![RaySegment { t0: 0.0, t1: range, level: 0 }],
        };

        for seg in &segments {
            let len = seg.t1 - seg.t0;
            if len <= 0.0 { continue; }

            let seg_origin = [origin[0] + dir[0] * seg.t0, origin[1] + dir[1] * seg.t0];

            // стены СВОЕГО уровня
            if let Some(levels) = &self.levels
                && let Some(grid) = levels.grid(seg.level)
            {
                consider(
                    ray_vs_grid(seg_origin, dir, len, grid, levels.solid(seg.level), levels.tile_size())
                        .map(|d| d + seg.t0),
                    RayTarget::Wall,
                    seg.level,
                );
            }

            // динамика карты и чужие корпуса — только своего уровня
            // (фильтр по `PredictedBody.level` / полю строки `level`),
            // дистанция ограничена длиной сегмента и сдвинута на seg.t0
        }
```

`consider` дополняется третьим аргументом — уровнем; ближайшее попадание
по-прежнему выигрывает.

### Строка трассера в спавне

`build_tracer` возвращает массив полей `w1`; дописать `startLevel` и
`endLevel` в том же порядке, что схема:

```rust
        [start_x, start_y, end_x, end_y, body_x, body_y, was_hit, shooter_id, start_level, end_level]
```

`try_fire` получает уровень из `render.level` (см. 5.1) и передаёт в
`build_tracer`.

### Локальная бомба

Спавн-JSON бомбы дополняется уровнем — тем же правилом, что на хосте:

```rust
                let mut level = render.level;

                if let Some(levels) = &self.levels {
                    if level >= 1 && !levels.has_floor(level, render.x, render.y) {
                        level = 0;
                    }
                }

                Some(json!({ weapon_name: { local_id: [render.x, render.y, 0, weapon.size, weapon.time, my_game_id, level] } }))
```

### `filter_frame_game`

Проверить, не завязан ли алиас локальной бомбы на длину строки. Если
сравнение идёт по ключам — правок нет.

## 5.7 Тесты

### Rust

| Файл | Тест | Что проверяет |
| --- | --- | --- |
| `client/predictor.rs` | `replica_climbs_the_ramp` | Реплика, проезжая по рампе, даёт те же `level`/`z`, что `level::step_level` |
| `client/predictor.rs` | `replica_falls_off_the_ledge` | Съезд с плиты → `input_locked`, через `fallTime` — уровень 0 |
| `client/predictor.rs` | `falling_replica_makes_no_contacts` | Падающий танк не выталкивается стеной уровня 0 под ним |
| `client/predictor.rs` | `tank_and_box_on_different_levels_do_not_touch` | Ящик уровня 0 под танком уровня 1: контакта нет |
| `client/predictor.rs` | `wall_of_the_other_level_is_ignored` | Перила уровня 1 не останавливают танк уровня 0 |
| `client/predictor.rs` | `correct_level_only_when_grounded` | На рампе кадр уровень не перебивает; на плоскости — перебивает |
| `client/predictor.rs` | `parity_*` (существующие) | остаются зелёными без правок — реплика движения не менялась |
| `client/shot.rs` | `tracer_drops_at_the_ledge` | `endLevel == 0` при выстреле с моста за кромку |
| `client/shot.rs` | `tracer_stops_on_the_railing_of_its_level` | Перила уровня 1 обрезают луч уровня 1 |
| `client/shot.rs` | `ground_tracer_ignores_the_bridge_tank_behind_the_slab` | Танк уровня 1 не в первом тайле плиты не поражается |
| `client/remote_tanks.rs` | `body_carries_the_level_from_the_row` | |
| `client/map_dynamics.rs` | `body_carries_the_level_from_the_map` | |
| `client/mod.rs` | `render_overlay_tail_matches_schema_width` | Длина хвоста == 2 + число полей `m1` |

### JS

`tests/core/clientCore.test.js`: сквозной — `set_map` со слоёной фикстурой,
`try_fire` возвращает трассер с `startLevel`/`endLevel`.

## 5.8 Changelog и документация

* `CHANGELOG.md` → `### Added`: предсказание уровня своего танка, контакты
  и трассеры с учётом уровней. `### Changed`: клиентская геометрия карты
  перешла с `Grid` на `MapLevels`.
* `docs/en|ru/core.md`: раздел клиентского ядра — как уровень
  предсказывается и чем корректируется; почему `PLAYER_STATE_LEN` не
  расширяли.
* `docs/en|ru/architecture.md`: в списке инвариантов — «правила уровня
  живут в `core/src/level.rs` и зовутся обеими сторонами».

## Критерии готовности этапа

```bash
cd /Users/dmitry/Sites/my/vimp-tanks
npm run core:build && npm run core:test && npx eslint . && npm test -- --silent
npm run build && npm run sim:scenarios
```

Инвариант 9 раннера (`predictionDrift`) на существующих сценариях —
без новых нарушений.

Отметить `✅ выполнен` здесь и в `plan/README.md`.
