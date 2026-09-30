# Ревью `bullet-flight-level-review` (коммиты 2e569fd..1cb0d29): план исправлений

> Итоговое место файла: `plan/bullet-flight-level-review-2.md` (один файл, без разбиения на этапы-файлы).

## Контекст

Ревью касается пяти коммитов `bullet-flight-level-review`, в которых выполнен план
`plan/done/bullet-flight-level-review.md`:

- `fly_through_slabs`: пуля не проходит сквозь плиту;
- `first_tall_wall` обходит клетки от начала луча;
- `ModelConfig::hull_top`;
- `wall_heights` с числовыми ключами;
- комментарии и перенос поиска цели у ботов.

Проверены ядро (`shot_levels.rs`, `shot_height.rs`, `config.rs`, `tank.rs`, `map_game.rs`, `client/shot.rs`,
`bots/controller.rs`, `tests/sim.rs`), клиент (`tracerPieces.js`, `ShotEffectController.js`, `ImpactEffect.js`),
документация `docs/{en,ru}/{core,gameplay}.md` и `walk_ray_cells` движка (vimp-engine-core 0.22.6).

**Выводы по критериям:**

- **Работоспособность.** На всех текущих картах этапы 1–5 работают верно. Я вручную прогнал `fly_through_slabs` на
  всех четырёх новых тестах, на подъёме с рампы на мост (число 608) и на карте `terraces`. Этап 2 проверен по коду
  `walk_ray_cells`: дистанции входа в клетку не зависят от длины луча, поэтому обход от `origin` совпадает с нарезкой
  `ray_segments` бит-в-бит. Найдена одна **латентная** ошибка правила «плита непрозрачна» (этап 1). Она проявляется
  только на картах с тремя и более уровнями, где плиты разных уровней стоят не стопкой. На `terraces` её нет: я
  проверил геометрию, у плит 1 и 2 нет соседних клеток «только 1» и «только 2».
- **Читаемость.** Имя `ModelConfig::hull_top()` конфликтует с уже существующим `tankModel.hullTop` в
  `src/config/render.js`. Там это верх КОРПУСА, 6 px, он ниже башни. А `hull_top()` возвращает верх БАШНИ. Поле
  `Tank::turret_top` теперь хранит `hull_top`, и в doc поля `ModelConfig::turret_top` осталась ссылка на
  `Tank::turret_top` — исполнитель сам на это указал (этап 2).
- **Документированность.** В rustdoc `ray_segments` и в `docs/{en,ru}/core.md` осталось «выпущенная вниз — опускается
  на уровень ниже» и «уровень полёта — высший уровень не выше пули». Новое правило им противоречит. Вставленная
  фраза в `core.md` не перенесена по ширине, строки ≈ 110 символов. В `configuration.md` не сказано, что ключи
  `wallHeights` теперь обязаны быть числами (этап 3).
- **Проверка не завершена.** Итоговая проверка прошлого плана не выполнена: исполнитель не запускал ни полный
  `npm test`, ни `npm run build` + `sim:scenarios`, ни ручную проверку. Файл при этом уже лежит в `plan/done/`
  (этап 4).
- **Тестируемость, DRY, производительность, безопасность, масштабируемость.** Замечаний нет. `hull_top` убрал
  дублирование. `turret_top_per_size` вынесен из цикла. `wall_height` больше не выделяет `String`. Правила остались
  чистыми функциями с юнит-тестами. Тесты хоста и предиктора ловят ошибку: без правки они падают.
- **Стандартизация.** Новый Rust-код написан в стиле соседних строк. `rustfmt` (дефолт 100 символов) правит сотни мест
  по всему крейту при любой ширине (100/110/120), поэтому код крейта в целом не отформатирован rustfmt. Это отдельная
  задача, в план она не входит.

**Наблюдения без правки** (в план не входят, решать пользователю):

1. Прижатая пуля летит ниже настила своего уровня `k`. Если она встречает подножие рампы `k → k+1`, то
   `embankment_hit` даёт `HIT_EMBANKMENT_FACE` у подножия: `gap_in = k − h > 0`. Если бы высота пули была прижата к
   `k`, получился бы `HIT_SLOPE` в той же точке. Пуля останавливается в том же месте, отличается только код
   попадания, то есть картинка. На земле так было и раньше: пуля ниже нуля у подножия рампы `0 → 1`.
2. Тест `wall_entered_before_the_segment_is_ignored` использует синтетический `t0 = 80` в середине клетки.
   `ray_segments` такой границы не даёт. Тест проверяет правило «клетки до `t0` пропускаются», а не округление.
   Этого достаточно.

## Общие правила

- Перед началом прочитать `CLAUDE.md`. **Коммитов не делать**, все правки остаются в рабочем дереве.
- Стиль:
  - JS: ES-модули, `===`, `let`/`const`, фигурные скобки обязательны, в именах нет двух заглавных подряд.
  - Rust: edition 2024, писать в стиле соседних строк. Длинные сигнатуры в одну строку допустимы, как у соседних
    функций. Весь файл через `cargo fmt` **не** прогонять.
  - Комментарии в коде — по-русски, в стиле соседних.
- Команды запускать тихо: `npm run core:test`, `npx vitest run <путь>`, `npm test -- --silent`, `npx eslint .`.
- Номера строк примерные (≈), место искать по имени функции или теста. Если план расходится с кодом по смыслу, или
  тест из плана не падает/не проходит так, как предсказано, **остановиться и сообщить**. Обходной путь не
  придумывать.
- Выполненный этап отметить «✅ выполнен» у заголовка. Когда выполнены все этапы, перенести файл в `plan/done/`
  (`git mv`, либо `mv`, если файл не отслеживается).
- `CHANGELOG.md` **не трогать**. Поведение пули «на высоте ствола» ещё не выпущено (`## [Unreleased]`). В
  выпущенной версии пуля со склона держалась уровня стрелка, и правки ниже видимого поведения относительно
  выпуска не меняют.

---

## Этап 1. Пуля, прижатая плитой, сходит с кромки на нижнюю плиту (средний приоритет, латентная ошибка) ✅ выполнен

**Проблема.** `fly_through_slabs` (`core/src/shot_levels.rs` ≈ 58–80) удерживает пулю у плоскости `k`, только
если плита `k` есть и в прошлой, и в текущей клетке. Для пули, которая честно пересекает плоскость внутри прошлой
клетки, это верно. Но пуля может быть **прижата** плитой: её уровень полёта в прошлой клетке `prev_fly` не равен
уровню по высоте `prev_raw`. Тогда ниже этой плиты пуля ни одной плоскости не пересекала, она «лежит» на плите. При
сходе с кромки она пересекает все плоскости разом, на границе клеток. Решать должна плита **текущей** клетки. Сейчас
же требуется ещё и плита в прошлой клетке:

- **Вниз.** Пуля прижата к плите 2, а под плитой 2 плиты 1 нет (как у `terraces` в x 47..52). Пуля сходит с кромки
  в клетку, где есть плита 1. Код проверяет «плита 1 в прошлой клетке» — её нет, и пуля уходит на землю СКВОЗЬ
  плиту 1.
- **Вверх (зеркально).** Пуля прижата снизу к плите 1 (`prev_fly = 0`, `prev_raw ≥ 1`). Она выходит в клетку, где
  плиты 1 нет, но есть плита 2, и высота пули уже ≥ 2. Код выводит её НА плиту 2 снизу, сквозь настил.

Обе ситуации нарушают правило, записанное в doc самой функции: «Настил плиты для пули непрозрачен, как земля».

**Правило (решение).** Плоскость `k` между `prev_fly` и `raw` непроходима, если плита `k` есть в текущей клетке и
при этом:

- либо пуля в прошлой клетке прижата (`prev_fly != prev_raw`): плоскость пересекается на границе клеток;
- либо плита `k` есть и в прошлой клетке: плоскость пересекается внутри неё.

Прежние случаи от этого не меняются. Я проверил вручную: у четырёх тестов `fly_through_slabs` и у подъёма с рампы
на мост (608) результат тот же. Меняются только случаи «прижатая пуля, а в прошлой клетке нет плиты `k`».

### 1.1. `core/src/shot_levels.rs`: код

Над `fly_through_slabs` добавить структуру прошлой клетки:

```rust
/// Предыдущая клетка луча (`fly_through_slabs`).
#[derive(Clone, Copy)]
struct PrevCell {
    /// центр клетки
    center: [f32; 2],
    /// уровень полёта в ней
    fly: u8,
    /// уровень по высоте пули на входе в неё (`fly_at`)
    raw: u8,
}
```

Заменить `fly_through_slabs` целиком:

```rust
/// Настил плиты для пули непрозрачен, как земля: плоскость уровня `k` между
/// уровнем полёта в прошлой клетке и `raw` (по высоте пули на входе в
/// текущую) пуля не пересекает, если плита `k` есть в текущей клетке и
/// пересечение приходится на плиту: либо внутри прошлой клетки (плита `k`
/// есть и там), либо на границе клеток — у пули, прижатой плитой в прошлой
/// клетке (её уровень полёта не равен уровню по высоте): такая пуля лежит
/// на плите и проходит все плоскости разом при сходе с неё. Летевшая над
/// плитой не проваливается под неё (остаётся на уровне `k`, как пуля ниже
/// нуля остаётся на земле) и, сойдя с кромки верхней плиты, ложится на
/// нижнюю; летевшая под плитой не выходит на неё снизу (остаётся на
/// `k − 1`). Уровень `k` пересекается только там, где плиты `k` нет: у
/// кромки, над рампой, в провале.
fn fly_through_slabs(levels: &MapLevels, prev: PrevCell, raw: u8, center: [f32; 2]) -> u8 {
    // прижатая пуля пересекает плоскости на границе клеток
    let held = prev.fly != prev.raw;
    let slab = |k: u8| {
        levels.has_floor(k, center[0], center[1])
            && (held || levels.has_floor(k, prev.center[0], prev.center[1]))
    };

    if raw < prev.fly {
        // спуск: плоскости prev.fly, prev.fly − 1, …, raw + 1 — сверху вниз
        (raw + 1..=prev.fly).rev().find(|&k| slab(k)).unwrap_or(raw)
    } else if raw > prev.fly {
        // подъём: плоскости prev.fly + 1, …, raw — снизу вверх
        (prev.fly + 1..=raw).find(|&k| slab(k)).map_or(raw, |k| k - 1)
    } else {
        raw
    }
}
```

В `ray_segments` (≈ 135–160):

- строку `let mut prev_center: Option<[f32; 2]> = None;` и её комментарий заменить на
  ```rust
  // предыдущая клетка луча (`fly_through_slabs`)
  let mut prev: Option<PrevCell> = None;
  ```
- начало замыкания `walk_ray_cells` заменить на
  ```rust
  let center = [(cx as f32 + 0.5) * tile, (cy as f32 + 0.5) * tile];
  let raw = fly_at(t);
  let fly = match prev {
      Some(prev) => fly_through_slabs(levels, prev, raw, center),
      None => raw,
  };
  let state = (floor_under(levels, fly, center[0], center[1]), fly);

  prev = Some(PrevCell { center, fly, raw });
  ```
  Имя `prev` уже занято в ветке `Some(prev) if prev != state` ниже. Там это локальная привязка из `current`, она
  затеняет внешнюю переменную только внутри ветки. Компилятор это примет, но для ясности ту привязку лучше
  переименовать в `Some(last) if last != state`, с `level: last.0, fly: last.1`.
- ранний выход `state != (0, 0) || rising` не трогать;
- `current` остаётся, он нужен для нарезки сегментов.

Без пули (`bullet = None`) `raw` постоянен, `held` всегда ложно, и путь бит-в-бит прежний. Одноуровневая карта
уходит в `ground_only` ещё раньше.

### 1.2. Тесты `shot_levels.rs` (модуль `tests`)

Сначала написать тесты и убедиться, что **до** правки 1.1 они падают именно с «старыми» значениями (указаны
ниже). Только потом править код.

Новая фикстура рядом с `layered()` и `terraced()`, в том же стиле, с doc-комментарием:

```rust
/// Карта 8×8 на три уровня, плиты НЕ стопкой: плита уровня 1 — колонки
/// 1..3 (тайл 2), плита уровня 2 — колонки 4..7 (тайл 3); под плитой 2
/// плиты 1 нет.
fn offset_decks() -> MapLevels {
    let grid0 = vec![vec![0; 8]; 8];
    let mut grid1 = vec![vec![0; 8]; 8];
    let mut grid2 = vec![vec![0; 8]; 8];

    for row in grid1.iter_mut() {
        for cell in row.iter_mut().take(4).skip(1) {
            *cell = 2;
        }
    }

    for row in grid2.iter_mut() {
        for cell in row.iter_mut().skip(4) {
            *cell = 3;
        }
    }

    let mut levels: IndexMap<String, MapLevelConfig> = IndexMap::new();

    levels.insert("1".to_string(), MapLevelConfig {
        map: grid1, floor: vec![2], walls: vec![], layers: IndexMap::new(), volumes: IndexMap::new(),
    });
    levels.insert("2".to_string(), MapLevelConfig {
        map: grid2, floor: vec![3], walls: vec![], layers: IndexMap::new(), volumes: IndexMap::new(),
    });

    MapLevels::build(&grid0, &[], &levels, &[], TILE, None)
}
```

`MapLevelConfig` оформить так же, как в `terraced()`: поля построчно. Если `MapLevels::build` не принимает пустой
`walls`, взять форму из `terraced()`.

1. `held_bullet_steps_off_the_upper_deck_onto_the_lower_one`. Старт `[75.0, 5.0]` (колонка 7), направление
   `[-1.0, 0.0]`, `RANGE`, уровень 2, `BulletLine { base: 2.1, rate: -0.05 }`. Комментарий к тесту:
   «x 70..40 — плита 2: пуля держится её, хотя на входе в x = 40 она уже 0.35; в x = 30 сходит с кромки на
   плиту 1, которой под плитой 2 нет, и держится её до x = 10».
   Трасса:
   - вход в колонку 6: t = 5, h = 1.85;
   - колонка 5: t = 15, h = 1.35;
   - колонка 4: t = 25, h = 0.85;
   - колонка 3: t = 35, h = 0.35, `prev_fly = 2`, `prev_raw = 0`;
   - колонки 2 и 1: t = 45 и 55;
   - колонка 0: t = 65.

   Ожидание:
   `vec![seg(0.0, 35.0, 2, 2), seg(35.0, 65.0, 1, 1), seg(65.0, RANGE, 0, 0)]`.
   До правки было `vec![seg(0.0, 35.0, 2, 2), seg(35.0, RANGE, 0, 0)]`: пуля проходила сквозь плиту 1.

2. `held_bullet_does_not_climb_onto_the_upper_deck_from_below`. Старт `[5.0, 5.0]` (колонка 0), восток, `RANGE`,
   уровень 0, `BulletLine { base: 0.1, rate: 0.065 }`. Комментарий: «в x = 10 пуля 0.43 входит под плиту 1; к
   x = 40 она уже 2.38, но прижата снизу плитой 1 и в плиту 2 выходит из-под настила: под плитой 2 — воздух
   уровня 1».
   Трасса:
   - вход в колонку 1: t = 5, h = 0.425;
   - колонка 2: t = 15, h = 1.075 — прижата;
   - колонка 3: t = 25, h = 1.725;
   - колонка 4: t = 35, h = 2.375, `prev_fly = 0`, `prev_raw = 1`;
   - дальше raw зажат в `top = 2`.

   Ожидание: `vec![seg(0.0, 35.0, 0, 0), seg(35.0, RANGE, 0, 1)]`. Под плитой 2 `floor_under(1)` — это
   `landing_level` = 0. До правки было `vec![seg(0.0, 35.0, 0, 0), seg(35.0, RANGE, 2, 2)]`.

Остальные тесты модуля, в том числе четыре теста прошлого этапа 1, должны пройти **без изменений**.

### 1.3. Проверка этапа

`npm run core:test`: все тесты зелёные, в том числе `client::shot` и `tests/sim.rs`
(`shot_down_the_upper_ramp_hits_a_tank_on_the_terrace`). Затем `npm run core:build` и
`npx vitest run tests/core`: число 608 у выстрела со склона не должно измениться.

Документацию по этому этапу — см. этап 3.

---

## Этап 2. Имя `hull_top` → `hit_top` (низкий приоритет, читаемость) ✅ выполнен

**Проблема.** `ModelConfig::hull_top()` (`core/src/config.rs` ≈ 78–86) возвращает `turret_top.max(barrel_height)`,
то есть верх БАШНИ. В проекте же `hullTop` уже значит верх КОРПУСА: `src/config/render.js` ≈ 219, `hullTop: 6`
против `turretTop: 10`. Читатель, который знает рендер, поймёт метод ровно наоборот. Кроме того:

- поле `Tank::turret_top` и метод `Tank::turret_top()` (`core/src/tank.rs` ≈ 121, 252, 281) хранят уже не
  `turretTop` модели, а производную высоту;
- doc поля `ModelConfig::turret_top` (`config.rs` ≈ 53–56) ссылается на `Tank::turret_top`.

**Решение.** Одно имя `hit_top` («верх танка для попадания пули») на всём пути:

1. `core/src/config.rs`:
   - `pub fn hull_top(&self)` переименовать в `pub fn hit_top(&self)`. Doc: «Верх танка для пули
     (`shot_height::tank_reaches`), мировые единицы: `turret_top`, но не ниже ствола — танк без объявленной высоты
     достаётся пулей своего уровня.»
   - В doc поля `turret_top` заменить «(`Tank::turret_top`)» на «(`ModelConfig::hit_top`)».
   - Тест `hull_top_is_turret_top_but_not_below_the_barrel` переименовать в
     `hit_top_is_turret_top_but_not_below_the_barrel`, вызовы — на `hit_top()`.
2. `core/src/tank.rs`:
   - поле `turret_top: f32` → `hit_top: f32`, в `Tank::new` писать `hit_top: model.hit_top(),`;
   - метод `pub fn turret_top(&self)` → `pub fn hit_top(&self)`, doc «Верх танка для пули, мировые единицы
     (`ModelConfig::hit_top`).»
3. Вызовы:
   - `core/src/tanks.rs` ≈ 1499: `tank.turret_top()` → `tank.hit_top()`;
   - `core/src/bots/controller.rs` ≈ 623: `target_tank.turret_top()` → `target_tank.hit_top()`.
4. `core/src/client/shot.rs`: `fn turret_top_per_size` → `fn hit_top_per_size`, внутри — `model.hit_top()`. В
   `cast_ray` локальную `turret_top_per_size` переименовать в `hit_top_per_size` (≈ 743 и 851). Комментарий над
   функцией начать словами «верх чужого танка для пули на единицу `size`…».
5. `core/src/shot_height.rs` ≈ 68–75: параметр `tank_reaches(z, turret_top, …)` переименовать в `hit_top`, в doc
   `z + turret_top / level_height` заменить на `z + hit_top / level_height`.
6. Документация (en/ru одинаково):
   - `docs/en/core.md` ≈ 996: `tank_reaches(z, turret_top, level_height, h)` → `tank_reaches(z, hit_top, level_height, h)`;
     ≈ 1012: «`turret_top` of a remote tank» → «`hit_top` of a remote tank»;
   - `docs/ru/core.md` ≈ 958 и ≈ 973 — то же.

   Ключ конфига `turretTop` и упоминания `turretTop` модели не менять: это имя поля данных.

7. Контроль: `grep -rn "hull_top\|fn turret_top\|\.turret_top()\|turret_top_per_size" core/src docs` ничего не
   находит. Поле `ModelConfig::turret_top` и его использование в `hit_top` остаются.

**Проверка:** `npm run core:test`.

---

## Этап 3. Документация правила полёта и ключей `wallHeights` (низкий приоритет) ✅ выполнен

### 3.1. rustdoc `ray_segments` (`core/src/shot_levels.rs` ≈ 82–102)

- Фразу «В каждой клетке (на входе в неё) уровень полёта — высший уровень карты не выше пули, пол — `floor_under`.»
  заменить на «В каждой клетке (на входе в неё) уровень полёта — высший уровень карты не выше пули (если плита не
  держит пулю, см. ниже), пол — `floor_under`.»
- Пункт «пуля со склона вверх (ствол задран) поднимается над плитой и летит по ней; вниз — опускается на нижний
  уровень;» заменить на «пуля со склона вверх (ствол задран) поднимается над плитой и летит по ней; вниз —
  опускается на нижний уровень за кромкой плиты;».
- Пункт про `fly_through_slabs` дополнить: «…под ней остаётся под ней, а сойдя с кромки верхней плиты, ложится на
  нижнюю (`fly_through_slabs`).»

### 3.2. `docs/en/core.md` (≈ 933–951) и `docs/ru/core.md` (≈ 902–918)

Первый пункт списка:

- en: «the highest map level not above the bullet» → «the highest map level not above the bullet (unless a slab
  holds the bullet, see below)»;
- ru: «высший уровень карты не выше пули» → «высший уровень карты не выше пули (если плита не держит пулю, см.
  ниже)».

После этой вставки переформатировать пункт по ширине.

Второй пункт заменить целиком, с переносом строк до ≤ 76 символов, как у соседних строк.

en:

```
- So a shot from a bridge does not drop: past the edge it flies on as an
  air segment and returns to an ordinary one over another slab of its
  level. A ground shot passes under the slab, even at its very edge. A
  bullet fired up a slope (the barrel tilted with the hull) climbs over
  the slab the ramp leads to; one fired down it comes down to the level
  below past the slab's edge. A tilted bullet (a shooter on a slope) never
  crosses a slab: over a slab of level `k` it keeps flying at `k` even
  below its surface — the way a bullet below zero stays on the ground —
  and under it stays under it. Level `k` is crossed only where the cell
  has no slab `k`: at an edge, over a ramp, in a gap. A bullet held by a
  slab crosses the levels right at the cell border, so stepping off a
  higher slab it lands on a lower one even if there is none under the
  higher slab (`fly_through_slabs`). Without a bullet (the renderer's
  `shot_segments`) the flight level is the shooter's level.
```

ru:

```
- Поэтому выстрел с моста не падает: за кромкой он летит дальше воздушным
  сегментом и над другой плитой своего уровня снова становится обычным.
  Наземный выстрел проходит под плитой даже у самой кромки. Пуля,
  выпущенная вверх по склону (ствол наклонён вместе с корпусом),
  поднимается над плитой, на которую ведёт рампа; выпущенная вниз —
  опускается на уровень ниже за кромкой плиты. Наклонная пуля (стрелок на
  склоне) не пересекает плиту: над плитой уровня `k` она летит на `k`,
  даже опустившись ниже настила, — как пуля ниже нуля остаётся на земле, —
  а под ней остаётся под ней. Уровень `k` пересекается только там, где в
  клетке нет плиты `k`: у кромки, над рампой, в провале. Пуля, которую
  держит плита, проходит уровни прямо на границе клеток, поэтому, сойдя с
  кромки верхней плиты, ложится на нижнюю, даже если под верхней её нет
  (`fly_through_slabs`). Без пули (`shot_segments` рендера) уровень полёта
  равен уровню стрелка.
```

### 3.3. `docs/en/configuration.md` (≈ 735–745) и `docs/ru/configuration.md` (раздел `game.wallHeights`)

В конец абзаца добавить:

- en: «Keys are level and tile numbers (JSON strings `"0"`, `"12"`); a non-numeric key fails the map load.»
- ru: «Ключи — номера уровня и тайла (строки JSON `"0"`, `"12"`); нечисловой ключ — ошибка загрузки карты.»

Затем переформатировать абзац по ширине соседних.

### 3.4. Проверка этапа

Prettier по изменённым `.md` не запускать, если он переформатирует чужие строки. Иначе допустимо:
`npx prettier --check docs/en/core.md docs/ru/core.md docs/en/configuration.md docs/ru/configuration.md`, а при
расхождениях только в правленых абзацах — `--write`. Затем `npm run core:test` (rustdoc меняется вместе с кодом).

---

## Этап 4. Итоговая проверка (обязательно; прошлый план её не выполнил) ✅ выполнен

1. `npm run core:test` — всё зелёное.
2. `npm run core:build`, затем `npm test -- --silent` (весь проект, включая `tests/core/*` с живым ядром) и
   `npx eslint .`.
3. `npm run audio:process` — только если нет `build/sounds/`. Затем `npm run build` и `npm run sim:scenarios`: все
   сценарии проходят.
4. Вручную (`npm run dev`), карта `terraces`. Задним ходом заехать на `rampStep` (x 31..33, y 21) и выстрелить на
   запад вниз по склону в танк или бота на террасе. Пуля должна попасть, трассер — идти на высоте террасы, а не
   под ней. На `downtown` выстрелы с моста, с земли и со склона рамп ведут себя как раньше. Если ручную проверку
   выполнить нельзя (нет браузера), так и написать в отчёте. Не отмечать её выполненной.
5. Отметить этапы «✅ выполнен» и перенести этот файл в `plan/done/`. Коммит не делать.

## Критические файлы

- `core/src/shot_levels.rs` — `PrevCell`, `fly_through_slabs`, `ray_segments`, фикстура `offset_decks`, тесты
  (этапы 1, 3.1)
- `core/src/config.rs`, `core/src/tank.rs`, `core/src/tanks.rs`, `core/src/bots/controller.rs`,
  `core/src/client/shot.rs`, `core/src/shot_height.rs` — переименование `hit_top` (этап 2)
- `docs/{en,ru}/core.md` (этапы 2, 3), `docs/{en,ru}/configuration.md` (этап 3)
