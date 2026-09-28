# Этап 4. Ядро: попадание по высоте пули — хост, предиктор, боты; все тесты ядра ✅ выполнен

Контекст — `plan/bullet-flight-level/README.md`, раздел «Модель», пункты 6–7. Этап требует этапов 2
(`Tank::turret_top`, `ModelConfig::turret_top`, `MapGame::wall_height`, `ShotPredictor.map_game`) и 3
(`RaySegment::fly`/`is_air`, новая сигнатура `ray_segments`, `level_at_distance` → `fly`).

## 4.1. Общие функции — `core/src/shot_height.rs`

Импорты: `use vimp_engine_core::client::raycast::walk_ray_cells;`, `use crate::map_game::MapGame;`
(`RaySegment` уже импортирован).

```rust
/// Дорастает ли танк до пули: верх корпуса `z + turret_top / level_height`
/// (уровни) не ниже высоты пули `h`. Одно правило на хост, предиктор и
/// ботов. Стоящий на полу танк (верх 3.0) всегда выше ствола (2.4) своего
/// уровня; не дорастает — наземный танк под пулей с моста и под пулей
/// стрелка, стоящего высоко на склоне.
pub fn tank_reaches(z: f32, turret_top: f32, level_height: f32, h: f32) -> bool {
    z + turret_top / level_height >= h
}

/// Первая стена воздушного сегмента, дорастающая до пули. Клетки сегмента
/// обходятся по порядку; на входе в клетку смотрятся стены уровней от пола
/// до уровня полёта (`levels.solid(k)`), и стена засчитывается, если её верх
/// `k + wall_height(k, tile)` не ниже пули. Дистанция — от начала ЛУЧА;
/// None — стен выше пули нет. Обычный сегмент стены судит по-старому
/// (коллайдеры хоста, `ray_vs_grid` предиктора).
pub fn first_tall_wall(
    levels: &MapLevels,
    map_game: &MapGame,
    segment: &RaySegment,
    origin: [f32; 2],
    dir: [f32; 2],
    bullet: &BulletLine,
) -> Option<f32> {
    let length = segment.t1 - segment.t0;
    let grid = levels.grid(0)?;
    let rows = grid.len();
    let cols = grid.first().map_or(0, |row| row.len());
    let tile = levels.tile_size();

    if length <= 0.0 || rows == 0 || cols == 0 || tile <= 0.0 {
        return None;
    }

    let start = [origin[0] + dir[0] * segment.t0, origin[1] + dir[1] * segment.t0];
    let mut hit = None;

    walk_ray_cells(start, dir, length, rows, cols, tile, |cx, cy, t| {
        // клетка, в которую луч входит на `t1`, — уже следующего сегмента
        if t >= length {
            return false;
        }

        if cx < 0 || cy < 0 {
            return true;
        }

        let distance = segment.t0 + t;
        let h = bullet.at(distance);
        let tall = (segment.level..=segment.fly).any(|k| {
            levels
                .grid(k)
                .and_then(|g| g.get(cy as usize))
                .and_then(|row| row.get(cx as usize))
                .is_some_and(|&cell| {
                    levels.solid(k).contains(&cell) && f32::from(k) + map_game.wall_height(k, cell) >= h
                })
        });

        if tall {
            hit = Some(distance);

            return false;
        }

        true
    });

    hit
}
```

Юнит-тесты в `mod tests`. Новый хелпер:
```rust
/// Карта 10×3, клетка 10: стена земли (тайл 1) в колонке 8 (x 80..90) во
/// всех строках; у уровня 1 — стена без плиты (тайл 4) в колонке 6 строки 0.
fn walled_map() -> MapLevels { … }
```
Строится как `ramp_map()`: `MapLevels::build(&grid0, &[1], &levels, &[], TILE, None)`, у уровня 1 —
`MapLevelConfig { map: grid1, floor: vec![], walls: vec![4], layers: IndexMap::new(), volumes: IndexMap::new() }`.
`MapGame` для тестов — `MapGame::from_value(&serde_json::json!({ "wallHeights": { … } })).unwrap()`. Воздушный
сегмент — `RaySegment { t0: 0.0, t1: 100.0, level: 0, fly: 1 }`, пуля с моста —
`BulletLine { base: 1.1, rate: 0.0 }`.
- `tank_reaches_by_its_top`: `tank_reaches(0.0, 3.0, 32.0, 0.075)` — true; `(0.0, 3.0, 32.0, 1.075)` — false;
  `(0.99, 3.0, 32.0, 1.075)` — true;
- `low_wall_is_flown_over`: из `(5, 15)` на восток, `{ "0": { "1": 1.0 } }` → `None`;
- `wall_without_height_stops_the_bullet`: `MapGame::default()` → `Some(75.0)` (вход в x = 80);
- `tall_wall_stops_the_bullet`: `{ "0": { "1": 2.0 } }` → `Some(75.0)`;
- `falling_bullet_meets_a_low_wall`: `{ "0": { "1": 1.0 } }`, `BulletLine { base: 1.3, rate: -0.005 }` → на
  t = 75 пуля 0.925 → `Some(75.0)`;
- `wall_of_the_fly_level_counts`: из `(5, 5)` (строка 0) на восток,
  `{ "0": { "1": 1.0 }, "1": { "4": 0.35 } }` → стена уровня 1 в колонке 6 (верх 1.35) → `Some(55.0)`;
- `wall_past_the_segment_end_is_ignored`: сегмент `{ 0, 70, level 0, fly 1 }`, `MapGame::default()` → `None`.

## 4.2. Хост — `core/src/tanks.rs`, `process_hitscan` (≈ 1420–1589)

Сейчас каждый сегмент кастуется в Rapier (`ctx.world.cast_ray(&ray, 1.0, true, filter)`), фильтр —
`QueryFilter::new().exclude_sensors().exclude_rigid_body(shooter_body)`, на слоёной карте ещё
`.groups(levels_interaction_on_ramp(level_group(segment.level)))`. Ближайшее попадание хранится в
`hit: Option<(ColliderHandle, f32, u8)>`. `QueryFilter` в Rapier 0.34 умеет
`.predicate(&impl Fn(ColliderHandle, &Collider) -> bool)` (`rapier2d-0.34.0/src/pipeline/query_pipeline.rs` ≈ 779).

1. Импорты: из `crate::shot_height` добавить `first_tall_wall`, `tank_reaches`. `Collider` приходит из
   `rapier2d::prelude::*` (уже импортирован).
2. Перед циклом:
   ```rust
   let level_height = self.levels.as_ref().map_or(1.0, MapLevels::level_height);
   // ближайшее попадание: коллайдер (None — стена сетки воздушного
   // сегмента, без урона и импульса), дистанция, уровень ПРОЕКЦИИ конца
   let mut hit: Option<(Option<ColliderHandle>, f32, u8)> = None;
   ```
3. Тело цикла по сегментам:
   ```rust
   let ray = Ray::new(origin + dir * segment.t0, dir * length);
   let air = segment.is_air();
   let tanks = &self.tanks;
   let bodies = &ctx.world.bodies;
   // пуля на своей высоте (`shot_height`): танк поражается, только если
   // дорастает до неё — в любом сегменте; в воздушном сегменте стены судит
   // `first_tall_wall`, а реквизит пуля перелетает
   let reach = |_: ColliderHandle, collider: &Collider| -> bool {
       let Some(body) = collider.parent().and_then(|handle| bodies.get(handle)) else {
           return !air;
       };

       match (BodyTag::decode(body.user_data), bullet.as_ref()) {
           (Some(BodyTag::Player { game_id, .. }), Some(line)) => tanks.get(&game_id).is_none_or(|tank| {
               let t = (body.translation() - origin).dot(dir);

               tank_reaches(tank.level_state.z, tank.turret_top(), level_height, line.at(t))
           }),
           (Some(BodyTag::Player { .. }), None) => true,
           _ => !air,
       }
   };
   let mut filter = QueryFilter::new().exclude_sensors().exclude_rigid_body(shooter_body);

   // одноуровневая карта фильтр не ставит вовсе — путь стрельбы обязан
   // остаться прежним бит-в-бит
   if layered {
       // пуля видит уровень пола как тело на прогоне — без стражей рамп:
       // насыпь судит её высота (`shot_height::embankment_hit`)
       filter = filter
           .groups(levels_interaction_on_ramp(level_group(segment.level)))
           .predicate(&reach);
   }

   if let Some((collider_handle, toi)) = ctx.world.cast_ray(&ray, 1.0, true, filter) {
       let distance = segment.t0 + toi * length;

       if hit.is_none_or(|(_, best, _)| distance < best) {
           hit = Some((Some(collider_handle), distance, segment.fly));
       }
   }

   // стены воздушного сегмента — по высоте (`first_tall_wall`)
   if air
       && let (Some(levels), Some(line)) = (self.levels.as_ref(), bullet.as_ref())
       && let Some(distance) =
           first_tall_wall(levels, &self.map_game, segment, [origin.x, origin.y], [dir.x, dir.y], line)
       && hit.is_none_or(|(_, best, _)| distance < best)
   {
       hit = Some((None, distance, segment.fly));
   }
   ```
   - `(body.translation() - origin).dot(dir)` — проекция центра танка на луч. Если типы не сходятся
     (`&Vector` вместо `Vector`), разыменовать: `(*body.translation() - origin)`.
   - Заём: `reach` берёт `&self.tanks` и `&ctx.world.bodies`, `cast_ray` — `&ctx.world`, `first_tall_wall` —
     `&self.levels`/`&self.map_game`. Все заёмы неизменяемые, это законно. Если borrow checker спорит, цикл по
     сегментам выносится в функцию, принимающую `&PhysicsWorld`, `&IndexMap<u32, Tank>`, `Option<&MapLevels>`,
     `&MapGame`.
4. Насыпь (`embankment`, `hit_code`) — как было. `filter(|e| hit.is_none_or(|(_, distance, _)| e.t < distance))`
   работает с новым кортежем без изменений. `end_level = e.level` — теперь это `fly` (этап 3).
5. Ветка попадания:
   ```rust
   if let Some((handle, distance, level)) = hit {
       let impact = origin + dir * distance;

       end_x = round1(impact.x);
       end_y = round1(impact.y);
       end_level = level;

       // стена сетки воздушного сегмента — без урона и импульса
       if let Some(collider_handle) = handle {
           // …прежний код: hit_body_handle, импульс, урон танку и пропу…
       }
   }
   ```
6. Комментарий над `end_level` промаха (про пробу у кромки) заменить на «промах: уровень ПРОЕКЦИИ на конце луча
   (`fly` сегмента) — у пули с моста над землёй это уровень моста».
7. Одноуровневая карта: `layered == false`, воздушных сегментов нет (`ground_only`), предикат не ставится — путь
   бит в бит прежний.

## 4.3. Предиктор — `core/src/client/shot.rs`, `cast_ray`

После этапа 3 `cast_ray(origin, dir, segments, my_id, bullet, world)` получает готовые сегменты. Сейчас для каждого
сегмента он проверяет стены своего уровня (`ray_vs_grid`), динамику карты (`sim_boxes`, уровень тела == уровень
сегмента) и чужие танки (`self.tanks` → `TankTarget { x, y, angle, size, level, z }`, OBB из `sim_tanks` или по
`size`), а результат передаёт в `consider(distance, target, level)`.

1. Импорты из `crate::shot_height`: `first_tall_wall`, `tank_reaches`.
2. Метод `ShotPredictor`:
   ```rust
   // высота чужого танка на единицу `size`: строка m1 модель не несёт, а
   // все модели пропорциональны `size` (как width = size·4) — отношение
   // берётся у своей модели; не ниже ствола, как `Tank::turret_top`
   fn turret_top_per_size(&self) -> f32 {
       self.model.as_ref().map_or(0.0, |model| {
           if model.size > 0.0 {
               model.turret_top.max(model.barrel_height) / model.size
           } else {
               0.0
           }
       })
   }
   ```
3. В цикле по сегментам: `let air = segment.is_air();`. Уровень для **всех** `consider` — `segment.fly` вместо
   `level`. Фильтры по уровню (стены сетки, `body_level != level`, `tank_level != level`) остаются по
   `segment.level` (пол).
4. **Стены:**
   ```rust
   if air {
       // воздушный сегмент: только стены, дорастающие до пули
       if let (Some(levels), Some(line)) = (&self.levels, bullet.as_ref()) {
           consider(
               first_tall_wall(levels, &self.map_game, segment, origin, dir, line),
               RayTarget::Wall,
               segment.fly,
           );
       }
   } else if let Some(levels) = &self.levels
       && let Some(grid) = levels.grid(level)
   {
       // …прежний `ray_vs_grid`…
   }
   ```
5. **Динамика карты** — только в обычном сегменте: `if !air && let Some(dynamics) = world.dynamics { … }`.
6. **Чужие танки:** после построения `obb`, перед `consider`:
   ```rust
   // пуля на своей высоте: танк поражается, только если дорастает до неё
   if let (Some(levels), Some(line)) = (&self.levels, bullet.as_ref()) {
       let t = (obb.x - origin[0]) * dir[0] + (obb.y - origin[1]) * dir[1];

       if !tank_reaches(tank.z, self.turret_top_per_size() * tank.size, levels.level_height(), line.at(t)) {
           continue;
       }
   }
   ```
   Центр берётся из `obb` (сим-геометрия или строка), как и у хоста — центр тела. Заём `self` внутри цикла по
   `&self.tanks` неизменяемый — законно.
7. Насыпь — как было: `consider(Some(hit.t), RayTarget::Embankment(hit.code), hit.level)`, `hit.level` — уже
   `fly`.
8. Комментарий над `cast_ray` дополнить: «…пуля на своей высоте: танки — только дорастающие до неё, в воздушном
   сегменте стены — по высоте (`first_tall_wall`), динамика карты — нет».

## 4.4. Боты — `core/src/bots/controller.rs`, `execute_aim_and_shoot` (≈ 583–625)

Сейчас: `segments = ray_segments(…)` (после этапа 3 — с `Some(&bullet)`), затем
`if !covers_level(&segments, direction.length(), target_level) { return; }`, затем проверка насыпи.

Проверку `covers_level` заменить:
```rust
let target_distance = direction.length();
let Some(target_tank) = game.tanks.get(&target) else {
    return;
};
let target_z = target_tank.level_state.z;
// пол под пулей на дистанции цели — один из уровней, которых касается
// цель (у стоящей — её уровень, у танка на рампе — оба соседних), и цель
// дорастает до пули (`shot_height`): танк на земле с моста, танк на мосту
// с земли и наземный танк под пулей стрелка высоко на склоне не достать —
// не тратим выстрел
let covered = (target_z.floor() as u8..=target_z.ceil() as u8)
    .any(|lvl| crate::shot_levels::covers_level(&segments, target_distance, lvl));

if !covered
    || !crate::shot_height::tank_reaches(
        target_z,
        target_tank.turret_top(),
        levels.level_height(),
        bullet.at(target_distance),
    )
{
    return;
}
```
- `target` — идентификатор цели в функции (`let target = self.target.unwrap();`), `target_level` больше не нужен —
  убрать, если нигде не используется.
- Если заём `game.tanks` спорит с `tank` (свой танк), скопировать нужные `f32` заранее.
- Комментарий над блоком («цель на чужом уровне может быть закрыта плитой моста…») дополнить: «…или быть ниже
  либо выше пули».

## 4.5. Тесты

### `core/tests/sim.rs` (правила игры проверяются здесь)

Хелперы файла: `make_core()`, `layered_map_json()` (≈ 222: 20×20 клеток по 32, рамка стен тайл 1 без объёмов —
бесконечно высокие; плита уровня 1 — колонки 10..12 (x 320..416), строки 5..14 (y 160..480); рампа тайл 3 —
строка 9, колонки 6..9 (x 192..320), подъём на восток 0 → 1), `core.spawn_actor(id, "m1", team, x, y, angle)`,
`steps`, `level_of`, `tank_z`, `core.take_events()`, `fire(&mut core, seq, count)` (стреляет игрок 1),
`events(&mut core)`, `health_of(&events, id)`. Пуля с моста — 1.075, танк — 0.094 уровня.

1. `shot_from_the_bridge_goes_down_the_ramp` (≈ 1135) → `bridge_shot_down_the_ramp_passes_over_a_ground_tank`.
   Комментарий: «пуля с моста не падает: над рампой и землёй она летит на высоте моста, танк на земле до неё не
   дорастает». Ожидание: `assert_eq!(health, None, "…")`.
2. `shot_past_the_ledge_hits_the_ground_tank` (≈ 1472) → `shot_past_the_ledge_passes_over_the_ground_tank`,
   `assert_eq!(health_of(&all, 2), None, "за кромкой пуля летит над землёй: {all:?}")`.
3. `ground_shot_hits_the_tank_on_the_open_edge` (≈ 1496) → `ground_shot_does_not_reach_a_tank_on_the_open_edge`,
   `assert_eq!(health_of(&all, 2), None, "пуля с земли идёт под плитой: {all:?}")`.
4. `ground_shot_stops_at_the_second_slab_cell`, `railing_protects_the_tank_from_below` — ожидания прежние (`None`).
   Комментарии про пробу переписать: «пуля с земли идёт под плитой».
5. Новый `bridge_shot_passes_over_a_tank_midway_up_the_ramp`: стрелок 1 — `(400, 304, 180.0)` на плите,
   спаунится первым. Цель 2 — `(208, 304, 0.0)`, едет вперёд (`core.apply_input(2, 1, "down", "forward")`), шаги
   по одному, пока `tank_z(&core, 2) >= 0.6` (предел 200, образец —
   `ground_shot_stops_on_the_slope_before_a_tank_high_on_the_ramp` ≈ 1092). Затем `core.take_events();
   fire(&mut core, 1, 1);` → `health_of(…, 2) == None` (верх 0.69 < пули 1.075).
6. Остальные тесты (`ground_shot_stops_on_the_slope_before_a_tank_high_on_the_ramp`,
   `ground_shot_hits_a_tank_at_the_foot_of_the_ramp`, `bridge_shot_hits_bridge_tank_not_ground_tank`,
   `hitscan_shot_kills_after_three_hits`, выстрелы по пропам) — без правок, зелёные.

Попадание в танк у верхней кромки рампы с моста (окно z 0.981..1 — 2.4 единицы пути) на живой симуляции ловить
ненадёжно. Его проверяют юнит-тесты `tank_reaches`, предиктор (ниже) и ручная проверка этапа 6.

### `core/src/client/shot.rs`, `mod tests`

Хелперы: `make_shot()`, `apply_map`, `render_at(x, y)`, `render_at_level(x, y, level)`, `tracer_of`,
`layered_shot_map()` (10×3 по 10, плита уровня 1 — колонки 3..5, перила — строка 1, колонка 5),
`ramp_shot_map()` (рампа в строке 1, x 30..60, на восток 0 → 1; плита уровня 1 в колонках 6..9),
`bridge_tank_row(x, y)` (чужой танк size 2, z 1, уровень 1). Ствол 1.0 → пуля 0.1 над полом; `turretTop` 1.25 →
танк 0.125. Чужой танк вставляется через `shot.update_world(&DecodedSnapshot { … })`, как в
`ground_tracer_hits_the_tank_in_transit` (≈ 1563).

Новый хелпер рядом с `bridge_tank_row`:
```rust
// строка чужого танка на земле (size 2, z 0, уровень 0)
fn ground_tank_row(x: f32, y: f32) -> Vec<FieldValue> {
    let mut row = bridge_tank_row(x, y);

    row[TANK_FIELD_Z] = FieldValue::F32(0.0);
    row[TANK_FIELD_LEVEL] = FieldValue::U8(0);
    row
}
```

1. `tracer_drops_at_the_ledge` → `tracer_flies_on_past_the_ledge`: ожидание `tracer[9] == 1` (конец в проекции
   моста), комментарий «за колонкой 5 плиты нет — пуля летит дальше на высоте моста».
2. `tracer_passes_down_the_ramp_from_the_slab` → `tracer_flies_over_the_ramp_from_the_slab`: `tracer[9] == 1`,
   остальное как было.
3. `ground_tracer_ignores_the_bridge_tank_behind_the_slab` — ожидание прежнее, комментарий про пробу заменить на
   «пуля с земли идёт под плитой».
4. `ground_tracer_hits_the_tank_in_transit` — прежнее (`HIT_TARGET`: верх 0.625 выше пули 0.1).
5. Новые:
   - `tracer_from_the_slab_passes_over_a_ground_tank`: `layered_shot_map()`, чужой танк `ground_tank_row(80.0,
     5.0)`, выстрел `render_at_level(35.0, 5.0, 1)` на восток → `tracer[6] == HIT_NONE`, `tracer[9] == 1`;
   - `tracer_from_the_slab_hits_a_tank_at_the_top_of_the_ramp`: `ramp_shot_map()`, чужой танк
     `bridge_tank_row(56.0, 15.0)` с `row[TANK_FIELD_Z] = FieldValue::F32(0.98)` (верх 1.105 ≥ пули 1.1), выстрел
     `RenderState { angle: PI, ..render_at_level(75.0, 15.0, 1) }` → `tracer[6] == HIT_TARGET`, `tracer[9] == 1`;
   - `tracer_from_the_slab_passes_over_a_tank_lower_on_the_ramp`: то же с z = 0.9 (верх 1.025) →
     `tracer[6] == HIT_NONE`;
   - `tracer_from_the_ramp_side_passes_over_a_ground_tank`: `ramp_shot_map()`, чужой танк `ground_tank_row(45.0,
     26.0)`, выстрел `RenderState { angle: FRAC_PI_2, z: 0.5, slope_vec: [1.0 / 3.0, 0.0], ..render_at(45.0,
     15.0) }` (вбок, поперёк склона: пуля 0.6, верх танка 0.125) → `tracer[6] == HIT_NONE`;
   - `tracer_from_the_slope_climbs_over_the_slab`: `ramp_shot_map()`, `RenderState { z: 1.0 / 3.0, slope_vec:
     [1.0 / 3.0, 0.0], ..render_at(40.0, 15.0) }` на восток (ствол вдоль склона) → `tracer[6] == HIT_NONE`,
     `tracer[9] == 1`. Прежде такой выстрел упирался в верхний торец (`HIT_SLOPE` на x = 60);
   - `air_tracer_meets_a_wall_without_height`: карта-хелпер `walled_shot_map()` — как `layered_shot_map()`, но в
     гриде земли колонка 8 — тайл 1 (`physicsStatic: [1]` уже есть), поля `game` нет → стена бесконечно высокая.
     Выстрел с плиты `render_at_level(35.0, 5.0, 1)` на восток → `tracer[6] == HIT_TARGET`, `tracer[2] ≈ 80`,
     `tracer[9] == 1`;
   - `air_tracer_flies_over_a_low_wall`: та же карта с `"game": { "wallHeights": { "0": { "1": 1.0 } } }` →
     `tracer[6] == HIT_NONE`.

### `core/src/bots/controller.rs`, `mod tests`

Харнесс `Fixture` на `tests/core/fixtures/layered.json` (клетка 32): `add_tank(game_id, team_id, x, y, level)`,
`brain_at(game_id, position, level)`, `fires_within(&mut fixture, &mut brain, attempts)`. Модель size 2,
`barrelHeight 2.4`, `turretTop 3.0` (этап 2).

1. `bot_fires_at_the_enemy_on_the_open_edge` → `bot_holds_fire_at_the_enemy_on_the_open_edge`:
   `assert!(!fires_within(…), "пуля с земли идёт под плитой — танк на кромке недосягаем")`.
2. `bot_fires_at_a_ground_enemy_inside_the_probe_window` → `bot_fires_at_a_ground_enemy_under_the_edge`,
   комментарий без пробы («оба на земле, враг под кромкой плиты — пуля идёт под плитой и достаёт его»),
   ожидание прежнее.
3. Новый `bot_on_the_slope_holds_fire_at_a_ground_tank_below_its_bullet`: бот `add_tank(1, 1, 230.4, 304.0, 0)`,
   затем `fixture.tanks[&1].level_state.z = 0.3` (склон на x = 230.4 — ровно 0.3) и
   `fixture.tanks[&1].gun_rotation = std::f32::consts::FRAC_PI_2`. Цель `add_tank(2, 2, 230.4, 400.0, 0)`,
   `brain_at(1, [230.4, 304.0], 0)`, `Attacking`, цель 2 → `!fires_within(…, 100)`: пуля 0.375 выше верха цели
   0.094. Позитивный контроль — существующий `bot_fires_at_a_tank_at_the_foot_of_the_ramp`.
4. `bot_holds_fire_through_the_slab`, `bot_holds_fire_at_a_tank_high_on_the_ramp`,
   `bot_fires_at_a_tank_at_the_foot_of_the_ramp` — без правок.

Боты на мосту за кромку не стреляют и без этого правила: линия видимости `nav.has_obstacle_between_on(1, …)`
считает клетки без плиты препятствием. Поэтому отдельный тест «бот на мосту» проверял бы навигацию, а не пулю, —
его не добавлять.

### `tests/core/core.test.js` (хост через WASM)

1. «трассер w1 несёт уровни луча, бомба w2 и взрыв w2e — свой уровень» (≈ 185): стрелок `(336, 272, 0)`, цель
   `(460, 272)` на земле. Комментарий: «стрелок на плите, цель за её восточной кромкой на земле: пуля летит над ней
   на высоте моста до восточной стены рамки». Ожидания: `tracer[6] === 1` (стена), `tracer[8] === 1`,
   **`tracer[9] === 1`**, добавить `expect(tracer[2]).toBeCloseTo(608, 0)`. Часть про бомбу не менять.
2. Блок «насыпь рампы»:
   - «с моста вниз по рампе» → название «с моста над рампой — пуля летит на высоте моста до западной стены»,
     `tracer[2] ≈ 32`, `tracer[6] === 1`, **`tracer[9] === 1`**;
   - «со склона вверх — склон на верхнем торце» → «со склона вверх — пуля уходит над плитой моста»: ожидания
     `tracer[6] === 1`, `tracer[2] ≈ 608` (восточная стена рамки), `tracer[9] === 1`. Число сверить на живом ядре
     (`npm run core:build`): пуля с задранным стволом поднимается дальше, стена рамки бесконечно высокая. Если
     ядро даёт другое, остановиться и сообщить;
   - «с земли вверх по рампе» и «с земли в борт» — без правок.

### `tests/core/clientCore.test.js` (предиктор через WASM)

1. «на слоёной карте трассер с моста падает за кромкой плиты» (≈ 567) → «…летит дальше на высоте моста»:
   `expect(tracer[9]).toBe(1)` с комментарием «endLevel — уровень полёта».
2. «shot_segments: луч с моста — плита до кромки, дальше земля» (≈ 601) → «…дальше воздушный сегмент того же
   уровня полёта»: третье число каждой тройки — `fly`. Ожидания: сегментов два, `segments[0]` —
   `{ t0: 0, t1 ≈ 64, level: 1 }`, `segments.at(-1)` — `{ level: 1, t1 ≈ 500 }`. Случай без карты
   (`[0, 500, 1]`) — без правок.
3. Блок «насыпь рампы» (предсказанный трассер): «с моста вниз по рампе» — `tracer[9] === 1` и то же название, что
   у хоста. Остальные — без правок.

Команды: `npm run core:test`, `npm run core:build`, `npx vitest run tests/core`.

## Критерий готовности

- `npm run core:test` и `npx vitest run tests/core` зелёные.
- `grep -rn "проб\|probe" core/src core/tests` — только в тексте, не касающемся луча (если найдётся про луч —
  переписать).
- Этап отмечен «✅ выполнен» здесь и в `README.md`.
