# Ревью `bullet-flight-level` (коммит 585b07e): план исправлений

## Контекст

Задача `plan/done/bullet-flight-level/` сделана: пуля летит на высоте ствола, как в GTA2. Уровень полёта
`fly = floor(h)`, пол под пулей `floor_under`, воздушные сегменты, `tank_reaches`, `first_tall_wall`, высоты стен
`game.wallHeights`, падающие осколки. Ревью прошло по ядру (`shot_levels.rs`, `shot_height.rs`, `tanks.rs`,
`client/shot.rs`, `bots/controller.rs`, `map_game.rs`, `lib.rs`), по клиенту (`ShotEffectController.js`,
`ImpactEffect.js`, `tracerPieces.js`, `index.js`) и по данным (`wallHeights.js`, `models.js`). Выводы:

- **Работоспособность.** Одна ошибка модели (этап 1): у стрелка на склоне пуля идёт наклонно и проходит **сквозь
  плиту**. Если она летит над плитой и опускается ниже её уровня, то проваливается под настил. Если летит под
  плитой и поднимается, то выходит на неё снизу. Это видно на карте `terraces`. Танк на рампе `rampStep` (1 → 2),
  стреляющий вниз по склону, уже через ~1 клетку за подножием уводит пулю на землю под террасу. Танки на террасе
  уровня 1 после этого недосягаемы, а трассер рисуется на земле. Неверное поведение закреплено тестами
  `falling_bullet_comes_down_to_the_ground` и `rising_bullet_climbs_onto_the_slab` в `shot_levels.rs`.
- **Надёжность.** `first_tall_wall` обходит клетки заново от сдвинутой точки `origin + dir·t0`, а не от начала
  луча, как `ray_segments`. Из-за округления первой клеткой сегмента может оказаться клетка перед ним (этап 2).
- **DRY.** Правило «высота танка не ниже ствола» записано дважды: `Tank::turret_top` и
  `ShotPredictor::turret_top_per_size`. Кроме того, предиктор пересчитывает высоту в самом внутреннем цикле (этап 3).
- **Производительность.** `MapGame::wall_height` на каждый вызов создаёт две `String` (этап 4, низкий приоритет).
- **Документированность и стандарт.** В `tracerPieces.js` остались комментарий и имя `window` от удалённого «окна у
  кромки». Есть неточные и непереформатированные комментарии в контроллере и в `ImpactEffect`. В ботах цель
  ищется после нарезки луча (этап 5).
- Безопасность и масштабируемость — замечаний нет. Тестируемость хорошая: правила вынесены в чистые функции
  (`ray_segments`, `tank_reaches`, `first_tall_wall`, `floor_under`), и у каждой есть юнит-тесты.

**Наблюдение без правки** (решение пользователя, в план не входит). Пуля, выпущенная вверх по склону, продолжает
подниматься над плитой. Вместе с `tank_reaches` это значит, что танк на рампе попадает в танк на мосту, только если
тот стоит у самой кромки: на `downtown` — в пределах ~5 мировых единиц. Этот вывод следует из решения «пуля
продолжает подниматься» (README плана, «Следствия»). Если он нежелателен, это отдельная задача.

## Общие правила

- Перед началом прочитать `CLAUDE.md`. **Коммитов не делать**, все правки остаются в рабочем дереве.
- Стиль: ES-модули, `===`, `let`/`const`, фигурные скобки обязательны, в именах нет двух заглавных подряд.
  Rust — edition 2024, в коде уже используются `let`-цепочки. Комментарии в коде пишутся по-русски, в стиле
  соседних.
- Команды запускать тихо: `npm run core:test`, `npx vitest run <путь>`, `npm test -- --silent`, `npx eslint .`.
- Выполненный этап отметить «✅ выполнен» у его заголовка. Когда выполнены все этапы, перенести файл в `plan/done/`
  (`git mv`).
- Номера строк примерные (≈), место искать по имени функции или теста. Если план расходится с кодом по смыслу,
  **остановиться и сообщить**, а не придумывать обходной путь.
- Итоговый файл плана: `plan/bullet-flight-level-review.md`, один файл без разбиения.

---

## Этап 1. Пуля не проходит сквозь плиту (высокий приоритет) ✅ выполнен

**Проблема.** `shot_levels::ray_segments` (`core/src/shot_levels.rs` ≈ 77–153) на входе в каждую клетку берёт
`fly = floor(h(t) + FLY_EPS)` только по высоте пули. Плиты между прошлой и текущей клеткой функция не учитывает.

- **Вниз.** Пуля стрелка на склоне `rampStep` на `terraces` (прогон 1 → 2 лежит на плите террасы) за подножием
  опускается ниже 1.0, пока ещё летит над террасой. `fly` становится 0, а `floor_under(0) = 0`, и сегмент `(0, 0)`
  уходит на землю под плитой. Хост кастует этот сегмент с фильтром уровня 0 (`tanks.rs` ≈ 1514), и танк на террасе
  (уровень 1) недосягаем. Зато под террасой пуля поражает стены и реквизит земли, а трассер рисуется на земле
  (`endLevel` 0).
- **Вверх.** Пуля, которая идёт под плитой и поднимается выше её уровня, переходит на плиту сквозь настил.

**Правило (решение).** Для пули плита — такой же пол, как земля. Пуля ниже нуля и сейчас остаётся на земле (сегмент
`(0, 0)`, `tank_reaches` истинно для всех). Так же пуля, летевшая над плитой уровня `k`, остаётся на уровне `k`, пока
под ней эта плита. Пуля, летевшая под плитой, остаётся под ней. Перейти через уровень `k` можно только там, где плиты
`k` нет хотя бы в одной из двух соседних клеток: у кромки, над рампой, в провале. Подъём с рампы на мост это правило
не ломает: верхняя клетка рампы не несёт плиту уровня `to`.

### 1.1. `core/src/shot_levels.rs`: новая функция и её вызов

Добавить над `ray_segments` (после `floor_under`):

```rust
/// Настил плиты для пули непрозрачен, как земля: если плита уровня `k` есть
/// и в предыдущей клетке луча, и в текущей, пуля её не пересекает. Летевшая
/// над плитой не проваливается под неё (остаётся на уровне `k`, как пуля
/// ниже нуля остаётся на земле), летевшая под плитой не выходит на неё
/// снизу (остаётся на `k − 1`). Уровень `k` пересекается только там, где
/// плиты `k` нет хотя бы в одной из двух клеток: у кромки, над рампой, в
/// провале. `prev` — уровень полёта в предыдущей клетке, `raw` — по высоте
/// пули на входе в текущую.
fn fly_through_slabs(levels: &MapLevels, prev: u8, raw: u8, prev_center: [f32; 2], center: [f32; 2]) -> u8 {
    let slab = |k: u8| {
        levels.has_floor(k, prev_center[0], prev_center[1]) && levels.has_floor(k, center[0], center[1])
    };

    if raw < prev {
        // спуск: плоскости prev, prev − 1, …, raw + 1 — сверху вниз
        (raw + 1..=prev).rev().find(|&k| slab(k)).unwrap_or(raw)
    } else if raw > prev {
        // подъём: плоскости prev + 1, …, raw — снизу вверх
        (prev + 1..=raw).find(|&k| slab(k)).map_or(raw, |k| k - 1)
    } else {
        raw
    }
}
```

(`k ≥ 1` в обоих диапазонах, поэтому `has_floor(0) == true` на правило не влияет.)

В `ray_segments`:
- рядом с `current` завести `let mut prev_center: Option<[f32; 2]> = None;` с комментарием «центр предыдущей
  клетки луча (`fly_through_slabs`)»;
- в замыкании `walk_ray_cells` сначала вычислить `center`, потом `fly`:
  ```rust
  let center = [(cx as f32 + 0.5) * tile, (cy as f32 + 0.5) * tile];
  let fly = match (current, prev_center) {
      (Some((_, prev_fly)), Some(prev)) => fly_through_slabs(levels, prev_fly, fly_at(t), prev, center),
      _ => fly_at(t),
  };
  let state = (floor_under(levels, fly, center[0], center[1]), fly);

  prev_center = Some(center);
  ```
- ранний выход `state != (0, 0) || rising` оставить: из `(0, 0)` без подъёма пуля по-прежнему не выходит;
- в doc-комментарий `ray_segments` добавить пункт: «* наклонная пуля (стрелок на склоне) не проходит сквозь плиту:
  над ней она держится её уровня, под ней остаётся под ней (`fly_through_slabs`)». Шапку модуля (строки 1–6)
  не трогать.

Без пули (`bullet = None`, ABI `shot_segments`) `fly` постоянен, и правило не срабатывает. Одноуровневая карта
уходит в `ground_only` раньше. Путь на плоских картах остаётся прежним бит-в-бит.

### 1.2. Тесты `shot_levels.rs` (модуль `tests`)

Карты `layered()` (плита уровня 1 в колонках 3..5) и `terraced()` (плита 1 в колонках 3..6, плита 2 в колонках
3..5), клетка 10, луч по строке 0 (`y = 5`).

1. `falling_bullet_comes_down_to_the_ground` → переименовать в
   `falling_bullet_stays_on_the_slab_and_drops_off_its_edge`. Вход прежний: старт `[35, 5]`, восток, уровень 1,
   `BulletLine { base: 1.1, rate: -0.05 }`. Комментарий: «на входе в x = 40 пуля 0.85 — ниже плиты, но плита под
   ней: держится уровня 1; за кромкой (x = 60) падает». Ожидание:
   `vec![seg(0.0, 25.0, 1, 1), seg(25.0, RANGE, 0, 0)]`.
2. `rising_bullet_climbs_onto_the_slab` → переименовать в `rising_bullet_does_not_pierce_the_slab_from_below`. Вход
   прежний (`base: 0.1, rate: 1.0 / 30.0`, старт `[5, 5]`, уровень 0). Комментарий: «в x = 30 пуля 0.93 входит под
   плиту, в x = 40 она уже 1.27, но плита сверху: остаётся под ней; за плитой (x = 60) — воздух на уровне 1».
   Ожидание: `vec![seg(0.0, 55.0, 0, 0), seg(55.0, RANGE, 0, 1)]`.
3. Новый `rising_bullet_climbs_onto_the_slab_from_its_edge`: `layered()`, старт `[5, 5]`, восток, уровень 0,
   `BulletLine { base: 0.1, rate: 0.04 }`. На входе в x = 30 пуля 1.1, а прошлая клетка без плиты, поэтому пуля
   выходит на плиту. Ожидание:
   `vec![seg(0.0, 25.0, 0, 0), seg(25.0, 55.0, 1, 1), seg(55.0, RANGE, 0, 1)]`.
4. Новый `falling_bullet_steps_down_the_terraces`: `terraced()`, старт `[35, 5]`, восток, уровень 2,
   `BulletLine { base: 2.1, rate: -0.05 }`. Ожидание:
   `vec![seg(0.0, 25.0, 2, 2), seg(25.0, 35.0, 1, 1), seg(35.0, RANGE, 0, 0)]`. Пуля держится плиты 2 до x = 60,
   плиты 1 — до x = 70.

Остальные тесты модуля не должны измениться: у их пуль `rate = 0`.

### 1.3. Предиктор: тест в `core/src/client/shot.rs`

Рядом с `tracer_from_the_slope_climbs_over_the_slab` добавить `tracer_down_the_slope_stays_on_the_slab_it_flies_over`:
- `apply_map(&mut shot, &layered_shot_map())` (плита уровня 1 в колонках 3..5, клетка 10) и
  `put_tank(&mut shot, bridge_tank_row(35.0, 5.0))` (чужой танк на плите, уровень 1);
- стрелок: `RenderState { angle: std::f32::consts::PI, z: 1.3, slope_vec: [0.5, 0.0], ..render_at_level(55.0, 5.0, 1) }`.
  Пуля: дуло x = 50.6, `base = 1.18`, `rate = −0.05`. На входе в колонку 3 (x = 40) пуля 0.65, но плита под ней;
- ожидание: `tracer[6] == HIT_TARGET`, `tracer[9] == 1` (endLevel). До правки выходил промах, потому что сегмент
  уходил на уровень 0 и танк уровня 1 отсекался. Если числа не сходятся, сверить `make_shot()` (ствол 1.0, size 2).
  При расхождении по смыслу — остановиться и сообщить.

### 1.4. Хост: тест в `core/tests/sim.rs` на реальной карте `terraces`

Новый тест `shot_down_the_upper_ramp_hits_a_tank_on_the_terrace` рядом с тестами `terraces_map_json()`/`terraces_cell`
(≈ 2135+):
- `core.load_map(terraces_map_json())`;
- стрелок `1` — `terraces_cell(28.0, 21.0)`, угол `180.0` (носом на запад, кормой к подножию `rampStep`
  x 31..33); цель `2` — `terraces_cell(20.0, 21.0)`, угол `0.0`, команда 2. `steps(&mut core, 2)`, проверить
  `level_of(&core, 1) == 1` и `level_of(&core, 2) == 1`;
- `core.apply_input(1, 1, "down", "back")`, затем шагать по одному (до 400 шагов), пока `tank_z(&core, 1) >= 1.4`.
  Проверить `assert!(tank_z(&core, 1) >= 1.4, …)`, потом `core.apply_input(1, 2, "up", "back")`;
- `core.take_events(); fire(&mut core, 3, 1);`, ожидание:
  `health_of(&events(&mut core), 2).is_some_and(|h| h < 100.0)` с сообщением «пуля вниз по рампе осталась на террасе».
- Если танк задним ходом на рампу не заезжает (гейт входа), не обходить это молча, а остановиться и сообщить.
  Тест 1.3 правило уже покрывает.

### 1.5. Документация (en/ru — одинаково)

- `docs/en/core.md` и `docs/ru/core.md`, раздел про `ray_segments` (≈ en 930–950, ru 900–916). После фразы о
  `RaySegment { t0, t1, level, fly }` добавить: «A tilted bullet (a shooter on a slope) never crosses a slab: over a
  slab of level `k` it keeps flying at `k` even below its surface — the way a bullet below zero stays on the ground
  — and under it stays under it; level `k` is crossed only where one of the two neighbouring cells has no slab `k`
  (`fly_through_slabs`).» Русский вариант: «Наклонная пуля (стрелок на склоне) не пересекает плиту: над плитой
  уровня `k` она летит на `k`, даже опустившись ниже настила, — как пуля ниже нуля остаётся на земле, — а под ней
  остаётся под ней; уровень `k` пересекается только там, где плиты `k` нет хотя бы в одной из двух соседних клеток
  (`fly_through_slabs`).» Если в таблице тестов раздела перечислены тесты `shot_levels`, переименовать
  `falling_bullet_comes_down_to_the_ground` и `rising_bullet_climbs_onto_the_slab` и там.
- `docs/en/gameplay.md` и `docs/ru/gameplay.md`, строка таблицы **Tank on a slope** (≈ 256): добавить «Its bullet
  never passes through a slab: fired down a ramp that stands on a terrace, it stays on the terrace.» /
  «Пуля не проходит сквозь плиту: выпущенная вниз по рампе, стоящей на террасе, она остаётся на террасе».
- `CHANGELOG.md` **не трогать**: поведение «пули на высоте» ещё не выпущено (`## [Unreleased]`), а в выпущенной
  версии пуля над плитой держалась её уровня.

**Проверка этапа:** `npm run core:test`, затем `npm run core:build` и `npx vitest run tests/core` (JS-тесты живого
ядра, в том числе число 608 у выстрела со склона: оно не должно измениться).

---

## Этап 2. `first_tall_wall` обходит луч от его начала (средний приоритет) ✅ выполнен

**Проблема.** `shot_height::first_tall_wall` (`core/src/shot_height.rs` ≈ 83–136) начинает обход с
`start = origin + dir·t0`. Сегменты режет `ray_segments` обходом от `origin`, и граница сегмента — это ровно вход
в клетку. При округлении `start` может попасть в клетку **перед** сегментом (например, x = 59.99998 вместо 60).
Тогда её стены проверяются как стены воздушного сегмента: стена без объявленной высоты (`INFINITY`) под кромкой
плиты даёт ложное попадание прямо на кромке. Хост и предиктор зовут одну и ту же функцию, поэтому ошибка у них
совпадёт, но это всё равно неверное попадание.

**Решение.** Обходить от `origin` на длину `segment.t1` и пропускать клетки, в которые луч вошёл до `t0`. Последовательность
клеток и дистанции тогда совпадают с `ray_segments` бит-в-бит.

```rust
    if segment.t1 <= segment.t0 || rows == 0 || cols == 0 || tile <= 0.0 {
        return None;
    }

    let mut hit = None;

    // обход — от начала ЛУЧА, как в `ray_segments`: клетки и дистанции входа
    // совпадают с нарезкой, первая клетка сегмента входит ровно на `t0`
    walk_ray_cells(origin, dir, segment.t1, rows, cols, tile, |cx, cy, t| {
        // клетка, в которую луч входит на `t1`, — уже следующего сегмента
        if t >= segment.t1 {
            return false;
        }

        // клетки прошлых сегментов
        if t < segment.t0 || cx < 0 || cy < 0 {
            return true;
        }

        let h = bullet.at(t);
        // … проверка `tall` без изменений …
        if tall {
            hit = Some(t);
            return false;
        }

        true
    });
```

Переменные `length` и `start` удалить. Doc-комментарий («Дистанция — от начала ЛУЧА») остаётся верным.

**Тест** (`shot_height.rs`, модуль `tests`), новый `wall_entered_before_the_segment_is_ignored`:
`RaySegment { t0: 80.0, t1: 100.0, level: 0, fly: 1 }`, origin `[5.0, 15.0]`, `MapGame::default()`, `BRIDGE`.
Стена земли в колонке 8 (x 80..90), луч вошёл в неё на t = 75, то есть раньше `t0`. Ожидание: `None`. Старый код
здесь давал `Some(80.0)`. Остальные тесты `first_tall_wall` должны пройти без изменений.

**Проверка:** `npm run core:test`.

---

## Этап 3. Высота танка — одно правило (DRY, низкий приоритет) ✅ выполнен

**Проблема.** `Tank::turret_top()` (`core/src/tank.rs` ≈ 284) и `ShotPredictor::turret_top_per_size()`
(`core/src/client/shot.rs` ≈ 698) повторяют одну формулу `turret_top.max(barrel_height)`. Вдобавок `cast_ray`
(≈ 848–853) вызывает `turret_top_per_size()` для каждого танка в каждом сегменте.

**Решение.**
1. `core/src/config.rs`: после `pub struct ModelConfig { … }` добавить
   ```rust
   impl ModelConfig {
       /// Высота танка над полом для пули (`shot_height::tank_reaches`),
       /// мировые единицы: `turret_top`, но не ниже ствола — танк без
       /// объявленной высоты достаётся пулей своего уровня.
       pub fn hull_top(&self) -> f32 {
           self.turret_top.max(self.barrel_height)
       }
   }
   ```
   Если `impl ModelConfig` уже есть, добавить метод туда.
2. `core/src/tank.rs`: в `Tank::new` писать `turret_top: model.hull_top(),`, а `turret_top()` пусть возвращает
   `self.turret_top`. Doc метода: «Высота танка над полом, мировые единицы (`ModelConfig::hull_top`)».
3. `core/src/client/shot.rs`: в `turret_top_per_size` заменить `model.turret_top.max(model.barrel_height)` на
   `model.hull_top()` и из комментария убрать «не ниже ствола, как `Tank::turret_top`» (правило теперь в
   `hull_top`). В `cast_ray` перед `for segment in segments` вычислить
   `let turret_top_per_size = self.turret_top_per_size();`, а в цикле использовать `turret_top_per_size * tank.size`.
4. Тест в `config.rs` (или рядом с существующими тестами модели): `hull_top` равен `turret_top`, если тот выше
   ствола, и равен стволу, если `turret_top` = 0. Существующие тесты `tests/config/tracer.test.js` не трогать.

**Проверка:** `npm run core:test`.

---

## Этап 4. `wall_heights` с числовыми ключами (производительность, низкий приоритет) ✅ выполнен

**Проблема.** `MapGame::wall_height` (`core/src/map_game.rs` ≈ 115) на каждый вызов создаёт
`level.to_string()` и `tile.to_string()`. Вызов идёт в каждой клетке воздушного сегмента на каждом уровне с
`solid` на хосте, в предикторе и у ботов.

**Решение.** Сменить тип поля на `pub wall_heights: BTreeMap<u8, BTreeMap<i32, f32>>`. serde_json разбирает
строковые ключи объекта в целые, в том числе из `serde_json::Value`. Тогда:
```rust
pub fn wall_height(&self, level: u8, tile: i32) -> f32 {
    self.wall_heights
        .get(&level)
        .and_then(|tiles| tiles.get(&tile))
        .copied()
        .unwrap_or(f32::INFINITY)
}
```
Doc-комментарий поля: «уровень → id тайла → высота объёма в уровнях (ключи JSON — строки "0", "12", разбираются в
числа)». Из doc метода убрать фразу «разбор ключей на лету дешёвый».

**Тесты** (`map_game.rs`): `wall_heights_parse_and_answer` и `unknown_wall_is_infinitely_tall` должны пройти как
есть. В `broken_game_is_an_error` добавить
`assert!(MapGame::from_value(&json!({ "wallHeights": { "x": { "1": 1.0 } } })).is_err());`: нечисловой уровень
теперь ошибка разбора, а не молча пропущенный ключ. Если serde не разбирает числовые ключи из `Value` (тесты
красные), откатить этап и сообщить: приоритет низкий.

**Проверка:** `npm run core:test`, затем `npm run core:build` и `npx vitest run tests/core`.

---

## Этап 5. Комментарии и мелочи (низкий приоритет) ✅ выполнен

1. `src/client/parts/effects/shot/tracerPieces.js`, хвост функции (≈ 60–75). Комментарий «конец луча — на уровне
   окна…» и имя `window` остались от удалённого окна у кромки, а имя `window` ещё и затеняет глобальный объект.
   Переименовать `window` → `endSegment` и заменить комментарий на: «последний кусок не на уровне конца (рендер режет
   луч без наклона ствола): он начинается там, где начался сегмент уровня конца, накрывающий конец, либо это весь
   последний кусок». Логику не менять.
2. `ShotEffectController.js`:
   - комментарий в конструкторе (≈ 56–60): переформатировать до ширины соседних строк (≤ 80 символов), текст не
     менять;
   - doc `_wallAt` (≈ 256–260): «`{ face, volume }` или null» → «`{ face, volume, base }` или null».
3. `ImpactEffect.js`, шапка класса (≈ 12–14): «Осколки попадания в стену рождаются на высоте `startK`» →
   «Осколки попадания в стену, в грань насыпи и воздушного попадания рождаются на высоте `startK`».
4. `core/src/bots/controller.rs`, `execute_aim_and_shoot` (≈ 583–625): блок `let Some(target_tank) =
   game.tanks.get(&target) else { return; };` перенести в начало ветки `if let Some(levels) = game.levels`, до
   `bullet_line`/`ray_segments`. Цели нет — нарезать луч незачем. Поведение не меняется.
5. Прогнать prettier **только** по изменённым JS-файлам этапа (`npx prettier --write <файлы>`). Если он
   переформатирует чужие строки, откатить их и оставить только правки этапа.

**Проверка:** `npx vitest run tests/client`, `npx eslint .`, `npm run core:test`.

---

## Итоговая проверка

1. `npm run core:test` — все зелёные, в том числе новые тесты этапов 1–4.
2. `npm run core:build`, затем `npm test -- --silent` (включая `tests/core/*` с живым ядром) и `npx eslint .`.
3. `npm run build` и `npm run sim:scenarios` — все сценарии проходят.
4. Вручную (`npm run dev`, карта `terraces`): заехать на `rampStep` и выстрелить вниз по склону в танк или бота на
   террасе. Пуля должна попасть, трассер — идти на высоте террасы, а не проваливаться под неё. На `downtown`
   выстрелы с моста, с земли и со склона `downtown`-рамп ведут себя как до правок.
5. Отметить этапы «✅ выполнен», перенести файл в `plan/done/` (`git mv`). Коммит не делать.

## Критические файлы

- `core/src/shot_levels.rs` — `fly_through_slabs`, `ray_segments`, тесты (этап 1)
- `core/src/client/shot.rs` — тест предиктора (1), `turret_top_per_size`/`cast_ray` (3)
- `core/tests/sim.rs` — тест хоста на `terraces` (1)
- `core/src/shot_height.rs` — `first_tall_wall` (2)
- `core/src/config.rs`, `core/src/tank.rs` — `hull_top` (3)
- `core/src/map_game.rs` — `wall_heights` (4)
- `src/client/parts/effects/shot/{tracerPieces,ShotEffectController,ImpactEffect}.js`, `core/src/bots/controller.rs` (5)
- `docs/{en,ru}/core.md`, `docs/{en,ru}/gameplay.md` (1)
