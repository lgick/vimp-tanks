# Этап 4 — стрельба и взрывы между уровнями (авторитетный путь) ✅ выполнен

**Репозиторий:** `T` = `/Users/dmitry/Sites/my/vimp-tanks`
**Крейт:** `core/` (`vimp-tanks-core`)

Цель: hitscan знает про уровни и кромки плиты, бомба помнит свой уровень,
взрыв не проходит сквозь плиту, клиент получает достаточно данных, чтобы
нарисовать трассер, меняющий высоту.

Предусловие: этап 3 зелёный.

## Правила (утверждены, не менять)

| Ситуация | Правило |
| --- | --- |
| **L1 → L1** | Пока луч над плитой — бьёт только цели уровня 1. Перила уровня 1 его блокируют. |
| **L1 → L0** | На первом тайле БЕЗ плиты луч «падает» на уровень 0 и дальше бьёт только цели уровня 0. Падение необратимо. |
| **L0 → L0** | Луч всегда идёт на уровне 0; под мостом он проходит свободно. Стены уровня 0 его блокируют. |
| **L0 → L1** | В ПЕРВОМ тайле с плитой, в который вошёл луч, он может поразить танк уровня 1 — если этот тайл не тайл перил. Дальше плита экранирует всё: луч продолжается на уровне 0. |
| **Танк на рампе** | Маска обоих уровней ⇒ его достают лучи обоих уровней. |
| **Падающий танк** | Маска пустая ⇒ его не достают ни лучи, ни взрывы, пока он в воздухе (0.35 c). Осознанное правило, а не побочный эффект: документировать в `gameplay.md`. |
| **Взрыв** | Поражает только цели своего уровня. Плита моста экранирует и вверх, и вниз. |
| **Бомба** | Уровень = уровень владельца на момент сброса; если под точкой сброса нет плиты этого уровня (или владелец падает) — уровень 0. |

## 4.1 `src/config/snapshot.js`

```js
  w1: {
    ...
    fields: [
      ...
      { name: 'wasHit', ty: 'u8' },
      { name: 'shooterId', ty: 'u8' },
      // 2.5D: уровень начала и конца луча. Клиент мог бы вывести оба сам
      // из своей копии слоёв, но тогда картинка трассера зависела бы от
      // ещё одного повторённого алгоритма — два байта дешевле
      { name: 'startLevel', ty: 'u8' },
      { name: 'endLevel', ty: 'u8' },
    ],
  },
  w2: {
    ...
    fields: [..., { name: 'ownerId', ty: 'u8' }, { name: 'level', ty: 'u8' }],
  },
  w2e: {
    ...
    fields: [
      { name: 'x', ty: 'f32' },
      { name: 'y', ty: 'f32' },
      { name: 'radius', ty: 'f32' },
      { name: 'level', ty: 'u8' },
    ],
  },
```

## 4.2 `core/src/shot_levels.rs` — сегментация луча (новый файл)

Общий код для авторитетного пути (`tanks.rs`) и клиентской реплики
(`client/shot.rs`, этап 5). Как и `level.rs`, он обязан быть один на обе
стороны.

```rust
//! Разбиение луча выстрела на сегменты по уровням (2.5D-карты). Правила
//! из plan/stage_4.md; авторитетный hitscan и клиентский предиктор
//! выстрела зовут ровно эту функцию, иначе трассер игрока разойдётся с
//! попаданием, посчитанным хостом.

use vimp_engine_core::client::raycast::walk_ray_cells;
use vimp_engine_core::map::MapLevels;

/// Отрезок луча, целиком лежащий на одном уровне. `t` — дистанция вдоль
/// НОРМАЛИЗОВАННОГО направления от точки старта, в мировых единицах.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RaySegment {
    pub t0: f32,
    pub t1: f32,
    pub level: u8,
}

/// Сегменты луча от `origin` в направлении `dir` (единичном) длиной
/// `range`, выпущенного с уровня `level`.
///
/// Одноуровневая карта даёт ровно один сегмент `[0, range]` уровня 0 —
/// путь стрельбы на таких картах обязан остаться прежним бит-в-бит.
pub fn ray_segments(
    levels: &MapLevels,
    origin: [f32; 2],
    dir: [f32; 2],
    range: f32,
    level: u8,
) -> Vec<RaySegment>
```

### Алгоритм

```
if !levels.is_layered() { return vec![RaySegment { t0: 0.0, t1: range, level: 0 }]; }

grid1 = levels.grid(1);  // None -> тоже один сегмент уровня 0
rows/cols берём из grid1

// плита в клетке: тайл входит в levels.floor(1)
// перила в клетке: тайл входит в levels.solid(1)

if level >= 1 {
    // ищем первую клетку БЕЗ плиты (или выход за границы карты)
    t_drop = range
    walk_ray_cells(origin, dir, range, rows, cols, tile, |cx, cy, t| {
        if вне сетки || !плита(cx, cy) { t_drop = t; return false; }
        true
    });

    if t_drop >= range { vec![{0, range, 1}] }
    else { vec![{0, t_drop, 1}, {t_drop, range, 0}] }
} else {
    // ищем первую клетку С плитой
    t_slab = range; slab_is_railing = false; t_slab_exit = range;
    walk_ray_cells(..., |cx, cy, t| {
        if внутри сетки && плита(cx, cy) {
            t_slab = t;
            slab_is_railing = перила(cx, cy);
            return false;
        }
        true
    });

    let mut out = vec![RaySegment { t0: 0.0, t1: range, level: 0 }];

    if t_slab < range && !slab_is_railing {
        // проба уровня 1 внутри ОДНОЙ клетки кромки: танк, стоящий у края
        // без перил, открыт снизу. Верхняя граница — выход из этой клетки;
        // считаем её как t_slab + диагональ клетки, чего заведомо хватает
        // на любой угол входа, а лишнее отрежет проверка «ближайшее
        // попадание» (сегменты перекрываются, минимальный toi выигрывает)
        let cell_span = levels.tile_size() * std::f32::consts::SQRT_2;
        out.push(RaySegment { t0: t_slab, t1: (t_slab + cell_span).min(range), level: 1 });
    }

    out
}
```

> **Почему перекрытие сегментов допустимо.** Сегмент уровня 0 идёт до
> `range`, проба уровня 1 лежит внутри него. Попадание выбирается по
> минимальной дистанции среди всех сегментов — значит стена уровня 0 перед
> кромкой всё равно выигрывает, а танк на кромке выигрывает у пустоты за
> ним. Ни одна ветка не нуждается в «вырезании» интервалов.

> **Ловушка `walk_ray_cells`.** Стартовая клетка посещается с `t = 0.0`.
> Для стрелка уровня 0, стоящего ПОД мостом, первая же клетка окажется
> плитой и проба выстрелит в упор вверх — это правильно (он под самым
> краем), но только если он под кромкой. Чтобы он не «простреливал» плиту
> из глубины под мостом, пробу ставим только когда `t_slab > 0.0` ИЛИ
> клетка старта — кромка (у соседней клетки против направления луча плиты
> нет). Реализовать проверкой соседа: `!плита(cx - stepX, cy - stepY)`.

## 4.3 `core/src/tanks.rs` — `process_hitscan`

Переписать на сегменты. Сигнатура и возвращаемый `TracerRow` меняются
только добавлением уровней.

```rust
    fn process_hitscan(&mut self, ctx: &mut SimCtx, shooter_id: u32, weapon_index: usize, shot: &ShotCommand) -> TracerRow {
        let weapon = self.weapons[weapon_index].clone();
        let range = weapon.range.unwrap_or(1000.0);
        let impulse_magnitude = weapon.impulse_magnitude;
        let shooter_body = self.tanks[&shooter_id].body;
        let start_level = self.tanks[&shooter_id].level_state.level;

        let dir = shot.direction; // уже нормализован (Tank::fire_direction)
        let origin = shot.start_point;

        let segments = match self.levels.as_ref() {
            Some(levels) => crate::shot_levels::ray_segments(
                levels, [origin.x, origin.y], [dir.x, dir.y], range, start_level,
            ),
            None => vec![crate::shot_levels::RaySegment { t0: 0.0, t1: range, level: 0 }],
        };

        let layered = self.levels.as_ref().is_some_and(|l| l.is_layered());

        // ближайшее попадание среди сегментов
        let mut best: Option<(ColliderHandle, f32, u8)> = None;

        for seg in &segments {
            let len = seg.t1 - seg.t0;

            if len <= 0.0 { continue; }

            let seg_origin = origin + dir * seg.t0;
            let ray = Ray::new(seg_origin, dir * len);
            let mut filter = QueryFilter::new()
                .exclude_sensors()
                .exclude_rigid_body(shooter_body);

            // одноуровневая карта фильтр по группам не ставит вовсе —
            // путь стрельбы обязан остаться прежним бит-в-бит
            if layered {
                filter = filter.groups(vimp_engine_core::map::level_interaction(seg.level));
            }

            if let Some((handle, toi)) = ctx.world.cast_ray(&ray, 1.0, true, filter) {
                let t = seg.t0 + toi * len;

                if best.is_none_or(|(_, best_t, _)| t < best_t) {
                    best = Some((handle, t, seg.level));
                }
            }
        }

        let end_point_ray = origin + dir * range;
        let was_hit = best.is_some();
        let mut end_x = round1(end_point_ray.x);
        let mut end_y = round1(end_point_ray.y);
        // уровень конца луча = уровень последнего сегмента, если промах
        let mut end_level = segments.last().map(|s| s.level).unwrap_or(start_level);

        if let Some((collider_handle, t, level)) = best {
            let impact = origin + dir * t;

            end_x = round1(impact.x);
            end_y = round1(impact.y);
            end_level = level;

            // ... дальше блок импульса и урона — БЕЗ ИЗМЕНЕНИЙ, кроме того
            // что `impact` теперь считается из t, а не из ray.point_at(toi)
        }

        TracerRow {
            floats: [ ... как сейчас ... ],
            was_hit,
            shooter: shooter_id as u8,
            start_level,
            end_level,
        }
    }
```

> **Регресс, которого нельзя допустить.** Сегодня `ray_vector = direction *
> range` и `max_toi = 1.0`, то есть `toi ∈ [0, 1]`. В новой форме сегмент
> имеет свою длину `len`, и `toi` нормируется на неё. Для одноуровневой
> карты `t = 0 + toi * range` — та же точка. Сценарий `combat.json` (этап 8
> и `npm run sim:scenarios` сейчас) обязан остаться зелёным по `dumpTicks`.

`TracerRow` дополнить полями `start_level: u8`, `end_level: u8`; `fields()`
дописывает их после `shooter`.

## 4.4 `core/src/bomb.rs`

```rust
pub struct Bomb {
    pub shot_id: u32,
    pub weapon: usize,
    pub owner_id: u32,
    pub team_id: u8,
    /// Уровень, на котором лежит бомба: взрыв поражает только его.
    pub level: u8,
    pub body: RigidBodyHandle,
}
```

`Bomb::new` получает `level: u8` и ставит коллайдеру
`.collision_groups(level_interaction(level))` — сенсор на мосту не соберёт
контактов с землёй.

`BombRow` дополнить `pub level: u8`; `fields()` — `FieldValue::U8(level)`
после `owner`.

`snapshot_row` — прокинуть `self.level`.

## 4.5 `core/src/tanks.rs` — `create_weapon_action`

```rust
        let owner = &self.tanks[&owner_id];
        let mut level = owner.level_state.level;

        // бомба, сброшенная в воздухе или над пустотой, оказывается внизу:
        // держать её на уровне 1 там, где плиты нет, значило бы взрывать
        // «в воздухе» над открытой землёй
        if owner.level_state.input_locked() {
            level = 0;
        } else if let Some(levels) = self.levels.as_ref() {
            if level >= 1 && !levels.has_floor(level, shot.body_position.x, shot.body_position.y) {
                level = 0;
            }
        }
```

и передать `level` в `Bomb::new`.

## 4.6 `core/src/tanks.rs` — `detonate`

Уровень цели читается из масок её коллайдера — так уровень танка и уровень
динамики карты (у которой игрового тега нет вовсе) читаются одинаково.

В цикле сбора целей, сразу после получения `collider`:

```rust
                // уровень цели — из масок её коллайдера: плита моста
                // экранирует взрыв в обе стороны
                if let Some(levels) = self.levels.as_ref() {
                    if levels.is_layered() {
                        let bomb_bit = vimp_engine_core::map::level_group(bomb.level);

                        if !collider.collision_groups().memberships.intersects(bomb_bit) {
                            continue;
                        }
                    }
                }
```

Взять `bomb.level` в локальную переменную ДО цикла (там уже есть
заимствование `ctx.world`).

`detonate` возвращает сейчас `[f32; 3]`; сделать `([f32; 3], u8)` либо
завести маленькую структуру `ExplosionRow { x, y, radius, level }`.
`weapon_effects` меняет тип на `IndexMap<String, Vec<ExplosionRow>>`, а
сборка блока в `build_snapshot_blocks` дописывает `FieldValue::U8(level)`.

## 4.7 Дружественный огонь и урон

`apply_damage` уровней не касается — до него доходят только цели, прошедшие
фильтр луча/взрыва. Правок нет.

## 4.8 Тесты

### Rust

| Файл | Тест | Что проверяет |
| --- | --- | --- |
| `shot_levels.rs` | `flat_map_gives_one_ground_segment` | Неслоёная карта → 1 сегмент `[0, range]` уровня 0 |
| `shot_levels.rs` | `bridge_ray_drops_at_first_empty_cell` | Стрелок L1: два сегмента, граница на кромке плиты |
| `shot_levels.rs` | `bridge_ray_over_full_slab_stays_up` | Плита до конца дальности → один сегмент уровня 1 |
| `shot_levels.rs` | `ground_ray_probes_the_first_slab_cell` | Стрелок L0: сегмент L0 на всю дальность + короткая проба уровня 1 у кромки |
| `shot_levels.rs` | `railing_cell_blocks_the_probe` | Кромка — тайл перил → пробы нет |
| `shot_levels.rs` | `shooter_deep_under_the_bridge_has_no_probe` | Стрелок в глубине под плитой → пробы нет |
| `tanks.rs` | `bridge_shot_hits_bridge_tank_not_ground_tank` | Два танка на одной прямой, один на мосту, один под ним → урон получает верхний |
| `tanks.rs` | `shot_past_the_ledge_hits_the_ground_tank` | Цель за кромкой на земле → попадание, `endLevel == 0` |
| `tanks.rs` | `ground_shot_hits_the_tank_on_the_open_edge` | Танк уровня 1 в тайле кромки без перил → попадание снизу |
| `tanks.rs` | `railing_protects_the_tank_from_below` | Тот же кейс с перилами → промах |
| `tanks.rs` | `falling_tank_is_not_hit` | Танк в `Falling` не поражается лучом |
| `tanks.rs` | `slab_shields_the_explosion` | Бомба на земле ровно под танком на мосту → урона нет; та же бомба на мосту → урон есть |
| `tanks.rs` | `bomb_dropped_over_the_void_lands_on_the_ground` | Сброс с уровня 1 в клетке без плиты → `bomb.level == 0` |
| `bomb.rs` | `bomb_collider_carries_the_level_group` | |

### JS

`tests/core/core.test.js`: сквозной кадр со слоёной фикстурой — блок `w1`
несёт `startLevel`/`endLevel`, `w2` — `level`, `w2e` — `level`.

> **Отклонение по месту тестов.** Тесты строки «tanks.rs» лежат в
> `core/tests/sim.rs` (у `tanks.rs` нет `#[cfg(test)]`-модуля, а харнесс со
> слоёной картой и `GameCore` уже там). Имена сохранены. Проверки
> `endLevel == 0` там нет — снапшот из Rust-теста не распаковать; уровни
> строк `w1`/`w2`/`w2e` проверяет сквозной JS-тест из этого же раздела,
> а Rust проверяет попадание/урон.

## 4.9 Changelog и документация

* `CHANGELOG.md` → `### Added`: стрельба и взрывы с учётом уровней, поля
  `startLevel`/`endLevel` (`w1`), `level` (`w2`, `w2e`).
* `docs/en|ru/gameplay.md`: таблица правил из шапки этого файла, включая
  неуязвимость в падении.
* `docs/en|ru/core.md`: `core/src/shot_levels.rs`, сегментный hitscan,
  чтение уровня цели из масок коллайдера.
* `docs/en|ru/configuration.md`: новые поля схем `w1`/`w2`/`w2e`.

## Критерии готовности этапа

```bash
cd /Users/dmitry/Sites/my/vimp-tanks
npm run core:build && npm run core:test && npx eslint . && npm test -- --silent
npm run build && npm run sim:scenarios
```

Сценарий `combat.json` обязан остаться зелёным и совпасть по дампам с
базовой линией — сегментация не изменила стрельбу на одноуровневых картах.

Отметить `✅ выполнен` здесь и в `plan/README.md`.
