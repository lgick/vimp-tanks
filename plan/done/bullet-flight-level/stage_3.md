# Этап 3. Ядро: сегменты луча по высоте пули (`fly`), без окна у кромки; насыпь ✅ выполнен

Контекст — `plan/bullet-flight-level/README.md`, раздел «Модель», пункты 2–5 и «насыпь» из пункта 6. После этого
этапа зелёными остаются только юнит-тесты `shot_levels` и `shot_height`. Тесты хоста, предиктора, ботов и JS-тесты
ядра временно красные — **сразу за этим этапом выполнить этап 4**.

## Как устроено сейчас (проверено по коду)

`core/src/shot_levels.rs`:

- `pub struct RaySegment { pub t0: f32, pub t1: f32, pub level: u8 }`, `t` — дистанция вдоль единичного
  направления;
- `ray_segments(levels, origin, dir, range, level) -> Vec<RaySegment>`. Одноуровневая карта даёт
  `ground_only(range)`. Иначе клетки обходит `walk_ray_cells` (движок, `vimp_engine_core::client::raycast`;
  колбэк `(cx, cy, t) -> bool` получает дистанцию ВХОДА в клетку, 0 — для стартовой, `false` останавливает обход).
  Внутри правило «вниз» (падение на `landing_level`) и правило «вверх» (окно-«проба» над кромкой, переменные
  `probe`, `probe_done`, `probe_open`, хелперы `is_railing`, `step`);
- `covers_level(segments, t, level)` — есть ли на `t` сегмент уровня `level` (боты);
- `level_at_distance(segments, t)` — максимальный `level` среди сегментов на `t` (уровень конца промаха).

`core/src/shot_height.rs`:

- `embankment_hit(levels, origin, dir, t0, t1, level, bullet)` — три правила: грань (вход снаружи, `t_in > t0`),
  склон (склон поднялся выше пули), верхний торец (`exits_top`: вверх по склону до торца — стоп);
- `first_embankment_hit(levels, segments, origin, dir, bullet)`.

Вызовы `ray_segments`: `core/src/tanks.rs` ≈ 1440 (хост), `core/src/client/shot.rs` ≈ 677 (`miss_level`) и ≈ 711
(`cast_ray`), `core/src/bots/controller.rs` ≈ 591, `core/src/lib.rs` ≈ 212 (ABI `shot_segments`). Литералы
`RaySegment { … }` вне модуля: `tanks.rs` ≈ 1447, `client/shot.rs` ≈ 713, тесты `shot_height.rs` ≈ 288.

## 3.1. `core/src/shot_levels.rs`

1. Шапку модуля (`//!`) переписать:
   ```rust
   //! Разбиение луча выстрела на сегменты (2.5D-карты). Пуля летит на своей
   //! высоте (`shot_height::BulletLine`): уровень полёта — высший уровень не
   //! выше пули, пол под ней — плита этого уровня или та, на которую упало
   //! бы тело. Авторитетный hitscan, клиентский предиктор выстрела и боты
   //! зовут ровно эту функцию, иначе трассер игрока разойдётся с
   //! попаданием, посчитанным хостом.
   ```
2. Импорт `use crate::shot_height::BulletLine;`. Константа:
   ```rust
   /// Запас на округление высоты пули: пуля ровно на уровне плиты — над ней.
   const FLY_EPS: f32 = 1e-4;
   ```
3. `RaySegment`:
   ```rust
   /// Отрезок луча. `t` — дистанция вдоль НОРМАЛИЗОВАННОГО направления от
   /// точки старта, в мировых единицах. `level` — уровень ПОЛА под пулей: по
   /// нему фильтр коллизий, стены и насыпь рамп. `fly` — уровень ПОЛЁТА:
   /// высший уровень не выше пули, в его проекции рисуются трассер и конец
   /// луча. `fly > level` — воздушный сегмент: пуля над полом ниже своего
   /// уровня и поражает только то, что до неё дорастает (`shot_height`).
   #[derive(Clone, Copy, Debug, PartialEq)]
   pub struct RaySegment {
       pub t0: f32,
       pub t1: f32,
       pub level: u8,
       pub fly: u8,
   }

   impl RaySegment {
       /// Воздушный сегмент: пуля над полом ниже уровня полёта.
       pub fn is_air(&self) -> bool {
           self.fly > self.level
       }
   }
   ```
   `ground_only` — `RaySegment { t0: 0.0, t1: range, level: 0, fly: 0 }`.
4. Общая функция пола — ею же пользуется ABI клиента (этап 5):
   ```rust
   /// Пол под пулей, летящей на уровне `fly`, в мировой точке: сам `fly`,
   /// если там его плита (у земли плита везде), иначе уровень, на который
   /// упало бы тело (`MapLevels::landing_level`). Вне карты — земля.
   pub fn floor_under(levels: &MapLevels, fly: u8, x: f32, y: f32) -> u8 {
       if fly == 0 || levels.has_floor(fly, x, y) {
           fly
       } else {
           levels.landing_level(fly, x, y)
       }
   }
   ```
5. `ray_segments` — новая сигнатура и тело. Ранние выходы (`!is_layered`, нет сетки, пустая сетка) остаются.
   Хелперы `tile_at`, `is_slab`, `is_railing`, `step` и все переменные окна (`probe`, `probe_done`, `probe_open`)
   удалить: пол считает `floor_under`.
   ```rust
   /// Сегменты луча от `origin` в направлении `dir` (единичном) длиной
   /// `range`. `bullet` — высота пули вдоль луча (`shot_height::bullet_line`);
   /// без неё (рендер трассера, `shot_segments`) пуля летит ровно на уровне
   /// стрелка `level`.
   ///
   /// В каждой клетке (на входе в неё) уровень полёта — высший уровень карты
   /// не выше пули, пол — `floor_under`. Сегмент кончается там, где меняется
   /// пара (пол, полёт):
   ///
   /// * пуля с плиты не падает — над клеткой без плиты своего уровня она
   ///   летит воздушным сегментом, над плитой своего уровня (другой мост) —
   ///   снова обычным;
   /// * пуля с земли идёт под плитой: окна у кромки нет, танк на мосту
   ///   снизу недосягаем;
   /// * пуля со склона вверх (ствол задран) поднимается над плитой и летит
   ///   по ней; вниз — опускается на нижний уровень.
   ///
   /// Одноуровневая карта даёт ровно один сегмент `[0, range]` уровня 0 —
   /// путь стрельбы на таких картах обязан остаться прежним бит-в-бит.
   pub fn ray_segments(
       levels: &MapLevels,
       origin: [f32; 2],
       dir: [f32; 2],
       range: f32,
       level: u8,
       bullet: Option<&BulletLine>,
   ) -> Vec<RaySegment> {
       // …ранние выходы и rows/cols/tile — как были…

       let top = (levels.level_count() - 1) as u8;
       // уровень полёта на дистанции `t`
       let fly_at = |t: f32| -> u8 {
           match bullet {
               Some(line) => (line.at(t) + FLY_EPS).floor().clamp(0.0, f32::from(top)) as u8,
               None => level.min(top),
           }
       };
       // растущая пуля (ствол задран на склоне) может подняться и с земли
       let rising = bullet.is_some_and(|line| line.rate > 0.0);
       let mut out: Vec<RaySegment> = Vec::new();
       // (пол, полёт) текущего сегмента
       let mut current: Option<(u8, u8)> = None;
       let mut t0 = 0.0f32;

       walk_ray_cells(origin, dir, range, rows, cols, tile, |cx, cy, t| {
           let fly = fly_at(t);
           let center = [(cx as f32 + 0.5) * tile, (cy as f32 + 0.5) * tile];
           let state = (floor_under(levels, fly, center[0], center[1]), fly);

           match current {
               None => current = Some(state),
               Some(prev) if prev != state => {
                   if t > t0 {
                       out.push(RaySegment { t0, t1: t, level: prev.0, fly: prev.1 });
                       t0 = t;
                   }

                   current = Some(state);
               }
               _ => {}
           }

           // над землёй пуля, что не поднимается, уровня уже не сменит
           state != (0, 0) || rising
       });

       let (floor, fly) = current.unwrap_or((level.min(top), level.min(top)));

       out.push(RaySegment { t0, t1: range, level: floor, fly });
       out
   }
   ```
   Стартовая клетка посещается всегда (`walk_ray_cells` зовёт колбэк с `t = 0` до проверок), поэтому `current`
   после обхода всегда `Some`. `unwrap_or` — только страховка.
6. `covers_level` — код прежний. Doc-комментарий переписать: «Достаёт ли луч на дистанции `t` пол уровня `level`:
   есть ли на `t` сегмент с таким полом (обычный или воздушный). Дорастает ли цель до пули, решает
   `shot_height::tank_reaches`». Упоминания пробы убрать.
7. `level_at_distance` — `.map(|seg| seg.fly)` вместо `.map(|seg| seg.level)`. Doc: «Уровень ПРОЕКЦИИ луча на
   дистанции `t` (`fly` сегмента) — на нём клиент рисует конец промаха. На границе двух сегментов берётся
   верхний». Комментарий про пробу в теле убрать.

## 3.2. `core/src/shot_height.rs` — насыпь

1. `embankment_hit` принимает сегмент:
   ```rust
   pub fn embankment_hit(
       levels: &MapLevels,
       origin: [f32; 2],
       dir: [f32; 2],
       segment: &RaySegment,
       bullet: &BulletLine,
   ) -> Option<EmbankmentHit> {
       let (t0, t1, level) = (segment.t0, segment.t1, segment.level);
       // …дальше как было…
   ```
2. Правило верхнего торца удалить: переменные `uphill`, `exits_top` и ветку `else if exits_top`. На плиту луч
   теперь поднимает `ray_segments`: пуля, дошедшая вверх по склону до торца, выше плиты, и следующий сегмент уже
   её уровня.
3. Правило грани — вход в прогон в пределах сегмента:
   ```rust
   /// Допуск «прогон начинается на границе сегмента», мировые единицы.
   const ENTRY_EPS: f32 = 1e-3;
   ```
   (константа — на уровне модуля) и в теле:
   ```rust
   // луч вошёл в прогон снаружи в пределах этого сегмента, а не начал
   // сегмент уже внутри насыпи (стрелок на склоне, смена уровня полёта над
   // склоном)
   let entry = along.0.max(cross.0);
   let hit = if gap_in > 0.0 {
       let code = if entry >= t0 - ENTRY_EPS { HIT_EMBANKMENT_FACE } else { HIT_SLOPE };

       Some((t_in, code))
   } else if gap_out > 0.0 {
       Some((t_in + (-gap_in) / (gap_out - gap_in) * (t_out - t_in), HIT_SLOPE))
   } else {
       None
   };
   ```
   Прежнее условие `t_in > t0` путало грань со склоном у сегмента, который начинается ровно на ребре прогона. С
   `fly` такие сегменты появляются, например, когда пуля с плиты входит в бок крутой рампы.
4. Результат: `EmbankmentHit { t, level: segment.fly, code }`. Doc поля `level`: «уровень ПРОЕКЦИИ конца — `fly`
   сегмента (у обычного сегмента — его уровень)».
5. Doc `embankment_hit` переписать: «Первая встреча пули с насыпью рамп на отрезке луча `segment`. Учитываются
   прогоны, чей НИЖНИЙ уровень — пол сегмента. Правила: луч вошёл в прогон снаружи в пределах сегмента, а насыпь на
   входе выше пули — грань (`HIT_EMBANKMENT_FACE`); внутри прогона склон поднялся выше пули — склон (`HIT_SLOPE`).
   Верхний торец пулю не останавливает: выше него плита, и на неё луч поднимает `ray_segments`». Doc
   `HIT_SLOPE`: убрать «или пуля дошла вверх по склону до верхнего торца».
6. `first_embankment_hit`: `embankment_hit(levels, origin, dir, segment, bullet)`.
7. Шапку модуля дополнить: «Уровень полёта и пол под пулей — `shot_levels::ray_segments`».

## 3.3. Вызовы `ray_segments` — чтобы собиралось

Правила попадания меняет этап 4. Здесь только новая сигнатура и `fly`.

1. **Хост**, `core/src/tanks.rs`, `process_hitscan` (≈ 1420):
   - блок `let shooter = …; let muzzle_offset = …; let bullet = …` (≈ 1450–1461) перенести ВЫШЕ `let segments`;
   - `ray_segments(levels, [origin.x, origin.y], [dir.x, dir.y], range, start_level, bullet.as_ref())`;
   - ветка `None =>` — `RaySegment { t0: 0.0, t1: range, level: 0, fly: 0 }`.
2. **Предиктор**, `core/src/client/shot.rs`:
   - `build_tracer`: сегменты считаются один раз, сразу после `bullet`:
     ```rust
     let segments = match &self.levels {
         Some(levels) => crate::shot_levels::ray_segments(
             levels,
             muzzle,
             direction,
             range,
             start_level,
             bullet.as_ref(),
         ),
         None => vec![crate::shot_levels::RaySegment { t0: 0.0, t1: range, level: 0, fly: 0 }],
     };
     ```
   - `cast_ray`: параметры `range` и `shooter_level` заменить на `segments: &[RaySegment]`; локальный расчёт
     `segments` внутри удалить, цикл — `for segment in segments`. Вызов:
     `self.cast_ray(muzzle, direction, &segments, shooter, bullet, world)`;
   - `miss_level` удалить. Уровень конца промаха:
     ```rust
     None if self.levels.is_none() => start_level,
     None => crate::shot_levels::level_at_distance(&segments, range).unwrap_or(start_level),
     ```
     Комментарий «луч с моста «падает» за кромкой» заменить на «у воздушного сегмента — уровень полёта».
3. **Боты**, `core/src/bots/controller.rs`, `execute_aim_and_shoot`: `let bullet = bullet_line(…)` (≈ 605)
   перенести ВЫШЕ `ray_segments` (сразу после `let range = …`) и передать `Some(&bullet)` последним аргументом.
   Проверка `covers_level` и насыпи пока остаётся прежней.
4. **ABI**, `core/src/lib.rs`, `shot_segments`: вызов `ray_segments(levels, [x, y], [dx, dy], range, level, None)`,
   плоский вывод — `[segment.t0, segment.t1, f32::from(segment.fly)]`. Doc: «…fired from `level` (пуля ровно на
   уровне стрелка — наклона ствола рендер не знает). Плоско: `[t0, t1, fly, …]` — третий элемент — уровень
   ПРОЕКЦИИ сегмента: луч с моста идёт над плитой и дальше на её высоте».
5. Литералы `RaySegment { … }` — `grep -rn "RaySegment {" core`: везде добавить `fly` (равный `level`).

## 3.4. Тесты `core/src/shot_levels.rs`

Хелперы модуля: `layered()` (8×8, клетка 10, плита уровня 1 — колонки 3..5, перила тайл 4 в клетке (5, 4)),
`terraced()` (плита 1 — колонки 3..6, плита 2 — колонки 3..5), `flat()`, `RANGE = 100`. Ровная пуля в тестах —
`BulletLine { base: L + 0.1, rate: 0.0 }` для стрелка уровня `L`: ствол 1.0 при клетке 10.

1. **Удалить** тесты окна: `ground_ray_probes_the_first_slab_cell`, `probe_ends_at_the_border_of_the_edge_cell`,
   `oblique_probe_is_shorter_than_the_cell_diagonal`, `axial_ray_checks_the_cell_strictly_behind`,
   `covers_level_sees_both_levels_inside_the_probe`, `railing_cell_blocks_the_probe`,
   `shooter_deep_under_the_bridge_has_no_probe`, `level_at_distance_prefers_the_upper_segment`,
   `shooter_under_the_edge_keeps_the_probe`, `probe_gives_the_nearest_level_above`,
   `probe_reaches_the_edge_of_the_level_above`, `railing_closes_the_probe_on_a_terraced_map`.
2. **Переписать:**
   - `flat_map_gives_one_ground_segment` — и с `None`, и с `Some(&BulletLine { base: 0.1, rate: 0.0 })`;
   - `bridge_ray_drops_at_first_empty_cell` → `bridge_ray_flies_over_the_ground`:
     `ray_segments(&layered(), [35.0, 5.0], [1.0, 0.0], RANGE, 1, Some(&ровная 1.1))` →
     `[{0, 25, level 1, fly 1}, {25, 100, level 0, fly 1}]`, `segments[1].is_air()`;
   - `bridge_ray_over_full_slab_stays_up` — ожидание `[{0, 70, level 1, fly 1}]` (пуля 1.1);
   - `terraced_ray_stays_over_the_upper_slab` — `[{0, 70, 2, 2}]` (пуля 2.1);
   - `terraced_ray_drops_level_by_level` → `terrace_ray_flies_over_two_lower_floors`: `[35, 5]`, восток, уровень
     2, пуля 2.1 → `[{0, 25, level 2, fly 2}, {25, 35, level 1, fly 2}, {35, 100, level 0, fly 2}]`;
   - `miss_level_of_a_ground_ray_stays_on_the_ground`: с земли `[5, 5]`, восток, пуля 0.1 → сегменты равны
     `ground_only(RANGE)`, `level_at_distance(&segments, RANGE) == Some(0)`.
3. **Новые:**
   - `ground_ray_passes_under_the_slab`: `layered()`, `[5, 5]` → восток, уровень 0, пуля 0.1 → `ground_only(RANGE)`
     (окна нет);
   - `bridge_ray_returns_onto_a_slab_of_its_level`: новый хелпер `gapped()` (8×8, клетка 10, плита уровня 1 —
     колонки 1..2 и 5..6, объявление уровня — как в `layered()`, без перил). Из `[15, 5]` на восток, уровень 1,
     пуля 1.1 → `[{0, 15, 1, 1}, {15, 35, 0, 1}, {35, 55, 1, 1}, {55, 100, 0, 1}]`;
   - `rising_bullet_climbs_onto_the_slab`: `layered()`, `[5, 5]` → восток, уровень 0,
     `BulletLine { base: 0.1, rate: 1.0 / 30.0 }`. Входы в клетки: x = 30 (t = 25, h ≈ 0.93 → полёт 0),
     x = 40 (t = 35, h ≈ 1.27 → 1). Ожидание `[{0, 35, 0, 0}, {35, 55, 1, 1}, {55, 100, 0, 1}]` (на x = 60 плита
     кончается);
   - `falling_bullet_comes_down_to_the_ground`: `layered()`, `[35, 5]` → восток, уровень 1,
     `BulletLine { base: 1.1, rate: -0.05 }` → на входе в x = 40 (t = 5) h = 0.85 →
     `[{0, 5, 1, 1}, {5, 100, 0, 0}]`;
   - `without_a_bullet_the_ray_flies_at_the_shooter_level`: `layered()`, `[35, 5]`, восток, уровень 1, `None` →
     то же, что `bridge_ray_flies_over_the_ground`;
   - `level_at_distance_in_the_air_is_the_fly_level`: сегменты `bridge_ray_flies_over_the_ground` →
     `level_at_distance(&segments, RANGE) == Some(1)`, `covers_level(&segments, 50.0, 0) == true`,
     `covers_level(&segments, 50.0, 1) == false`;
   - `floor_under_answers_by_the_slab`: `floor_under(&layered(), 1, 45.0, 5.0) == 1`,
     `floor_under(&layered(), 1, 75.0, 5.0) == 0`, `floor_under(&terraced(), 2, 65.0, 5.0) == 1`,
     `floor_under(&layered(), 0, -5.0, 5.0) == 0`.

## 3.5. Тесты `core/src/shot_height.rs`

Хелпер `ramp_map()` (10×3, клетка 10, рампа в строке 1, колонки 3..5 (x 30..60), подъём на восток 0 → 1; плита
уровня 1 в колонках 6..9). Хелпер `hit(origin, dir, t0, t1, level, bullet)` строит
`RaySegment { t0, t1, level, fly: level }` и зовёт новый `embankment_hit`.

1. `bullet_along_the_slope_stops_at_the_top_end` → `bullet_along_the_slope_passes_the_top_end`: тот же вызов →
   `None` (правила торца больше нет).
2. `first_hit_over_segments_is_the_nearest` — в литералы `RaySegment` добавить `fly`.
3. Новые:
   - `segment_starting_on_the_run_edge_hits_the_face`: `hit([75.0, 15.0], [-1.0, 0.0], 15.0, 100.0, 0, FLOOR)` —
     сегмент начинается на торце x = 60 → `HIT_EMBANKMENT_FACE`, `t = 15`;
   - `segment_started_inside_the_embankment_hits_the_slope`: `hit([45.0, 15.0], [1.0, 0.0], 0.0, 100.0, 0,
BulletLine { base: 0.3, rate: 0.0 })` (склон на x = 45 — 0.5, выше пули; сегмент начат внутри прогона) →
     `HIT_SLOPE`, `t = 0`;
   - `air_hit_carries_the_fly_level`: `embankment_hit(&ramp_map(), [5.0, 15.0], [1.0, 0.0],
&RaySegment { t0: 0.0, t1: 100.0, level: 0, fly: 1 }, &FLOOR)` → `level == 1`, `code == HIT_SLOPE`;
   - `bridge_bullet_over_an_air_segment_misses`: тот же сегмент `{0, 100, level 0, fly 1}`, `[75.0, 15.0]` на
     запад, пуля 1.1 → `None`.

Команда: `npm run core:test -- shot_levels shot_height` (или `cd core && cargo test -q shot_levels shot_height`).
Ожидаемо красные до конца этапа 4: `core/tests/sim.rs`, тесты `client::shot`, `bots::controller`.

## Критерий готовности

- `cargo check` проходит (`npm run core:test` компилирует всё ядро).
- Тесты `shot_levels` и `shot_height` зелёные.
- `grep -n "probe\|exits_top\|uphill" core/src/shot_levels.rs core/src/shot_height.rs` — пусто.
- Этап отмечен «✅ выполнен» здесь и в `README.md`. Сразу перейти к этапу 4.
