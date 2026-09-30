# План: исправления по код-ревью задачи `ramp-debris-parallax` (коммит efb097a)

План самодостаточен. Перед началом исполнитель читает `CLAUDE.md` в корне репозитория: там правила кода, тестов,
документации en/ru и CHANGELOG. Коммитов не делать, все правки остаются в рабочем дереве.

## Статус этапов

| Этап | Суть                                                           | Находки            | Статус                                           |
| ---- | -------------------------------------------------------------- | ------------------ | ------------------------------------------------ |
| 1    | `reproject` вместо дубля `wallFace.raisedPoint`                | M1                 | ✅ выполнен                                      |
| 2    | Ядро: высота пули и насыпь рамп — общий модуль, данные, хост   | H1, H2, H3, N1, N2 | ✅ выполнен                                      |
| 3    | Ядро: то же правило у предиктора и ботов (паритет)             | H2, N1             | ✅ выполнен                                      |
| 4    | JS: коды попадания и геометрия рамп (`rampSurface.js`, сервис) | H1, N2             | ✅ выполнен                                      |
| 5    | `ShotEffectController`: конец на склоне и на грани насыпи      | H1, N2, L1         | ✅ выполнен                                      |
| 6    | Документация en/ru и CHANGELOG                                 | L2                 | ✅ выполнен                                      |
| 7    | Прошлый план в `plan/done/`, итоговая проверка                 | L3                 | ✅ выполнен (проверка — в `bullet-flight-level`) |

Порядок строгий: 1 → 2 → 3 → 4 → 5 → 6 → 7. Этапы 2 и 3 делать подряд: после этапа 2 хост и предиктор
временно расходятся. Выполненный этап отметить тегом «✅ выполнен» у заголовка и в таблице. Когда выполнены все
этапы, перенести этот файл в `plan/done/` (`git mv`, без коммита).

---

## Контекст

### Что сделано в efb097a

Осколки попадания (`ImpactEffect`) теперь лежат на поверхности под собой. Контроллер выстрела
(`src/client/parts/effects/shot/ShotEffectController.js`) передаёт в эффект `surfaceK(x, y)` — проекцию высоты
склона рампы в точке. Её считает `rampRuns.heightAt` → `rampSurfaceAt` (`src/client/rampSurface.js`). Каждый кадр
`ImpactEffect.project` переносит осколок в проекцию его собственной высоты через `reproject`
(`src/client/parallax.js`). Осколки больше не «плывут» по клину при движении камеры.

### Требования пользователя после ручной проверки

1. **Выстрел с земли по рампе (жалоба).** Осколки оказываются у верхнего края рампы, у высокой рампы это выглядит
   странно. Осколки должны быть на высоте танка, а не на высоте верхней кромки.
2. **N1 — высокая рампа.** Танк наверху высокой рампы не должен поражаться с земли. Выстрел идёт на уровне
   (высоте) стреляющего танка.
3. **N2 — выстрел в борт рампы.** Он должен быть на высоте танка, как это уже сделано для стен: конец трассера и
   искры на видимой грани на высоте ствола.

### Что проверено на живом ядре

Ядро собрано (`core/pkg-node`), карта — `tests/core/fixtures/layered.json`. Рампа в строке 9, колонки 6..9
(x 192..320), подъём на восток 0 → 1. Плита моста в колонках 10..12. Выстрелы делались в памяти, без записи файлов:

| Выстрел                                      | Хост: конец луча, `wasHit`, `endLevel` | Предсказание своего выстрела                   |
| -------------------------------------------- | -------------------------------------- | ---------------------------------------------- |
| с земли (150, 304), на восток вверх по рампе | x = 318.4 (страж верхнего торца), 1, 0 | x = 608 (насквозь, под мост до стены), true, 0 |
| с моста (352, 304), на запад вниз по рампе   | x = 320 (кромка плиты), 1, 0           | x = 32 (западная стена), true, 0               |
| с земли (272, 360), на север в борт рампы    | y = 321.6 (борт на полу), 1, 0         | y = 32 (северная стена), true, 0               |

Стражи рампы — невидимые коллайдеры движка (`vimp-engine-core`, `map::ramp_guards`): два борта вдоль оси и
«неправильный» верхний торец. Толщина — 0.1 клетки, центр торца на кромке `run.max` (при подъёме по `+axis`).
Группа стража — `RAMP_GUARD_GROUP`, фильтр — `level_group(low)`. Луч хоста фильтруется
`level_interaction(segment.level)` = `body_filter(group, false)`, то есть видит `RAMP_GUARD_GROUP`.

### Главное решение плана

Физика и лучи двумерны, а рампа — склон. Стражи — препятствия для ТЕЛ, для пули они дают неверные ответы: упор у
верхней кромки, упор в кромку моста, упор в борт на полу. Решение — модель высоты пули в ядре, одна для хоста,
предиктора и ботов:

- **Пуля летит на высоте ствола стрелка.** Высота в уровнях вдоль луча: `h(t) = base + rate·t`, где
  `base = z + barrelHeight / levelHeight`. На ровном полу и в полёте `rate = 0`. Стоящий на склоне наклонён вместе
  с корпусом, поэтому ствол идёт вдоль склона: `rate = (slope_vec · dir) / levelHeight`.
- **Насыпь рампы останавливает пулю там, где она выше пули.** Это склон сверху, борт или торец, в который луч
  входит снаружи. Отдельное правило: луч, дошедший вверх по склону до верхнего торца, там останавливается — как
  сейчас его останавливает страж торца.
- **Стражей пуля не видит вовсе.** Фильтр луча — движковый `levels_interaction_on_ramp(level_group(level))`, «тело
  на прогоне стражей не видит».
- **Код попадания в строке трассера** (`wasHit`, уже `u8` схемы `w1`): 0 — промах, 1 — тело или стена, 2 — склон
  сверху, 3 — грань насыпи (борт или торец снаружи).
- **Клиент рисует конец по коду.** Код 2: конец на склоне на высоте пули, осколки на склоне. Код 3: как у стены —
  конец на грани на высоте ствола, искры в слое `shot-impact`. Точку встречи клиент больше не считает, её
  присылает ядро.

Что это даёт:

- выстрел с земли вверх по рампе кончается у подножия, там, где склон дорос до высоты ствола (жалоба 1);
- танк высоко на рампе с земли не поражается, у подножия — поражается (N1);
- выстрел в борт кончается на его грани на высоте ствола (N2);
- выстрел с моста вниз по рампе идёт по ней дальше (H3);
- предсказание совпадает с хостом (H2).

---

## Находки

| ID  | Важность | Критерий                                 | Суть                                                                                                   | Этап |
| --- | -------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---- |
| H1  | высокая  | работоспособность, тестируемость         | Выстрел с ровного пола в рампу: осколки и конец трассера у верхней кромки на полной высоте             | 2, 5 |
| H2  | высокая  | работоспособность (паритет)              | Предиктор своего выстрела не видит стражей рамп: свой трассер пролетает насыпь насквозь                | 2, 3 |
| H3  | средняя  | работоспособность (геймплей)             | Выстрел с моста вниз по рампе хост обрывает на кромке плиты                                            | 2    |
| N1  | высокая  | работоспособность (геймплей, требование) | Танк высоко на рампе поражается с земли: пуля проходит сквозь насыпь                                   | 2, 3 |
| N2  | средняя  | работоспособность (требование)           | Выстрел в борт кончается на полу у борта, а не на грани на высоте ствола                               | 2, 5 |
| M1  | средняя  | DRY                                      | `reproject` из efb097a — та же формула, что уже была в `wallFace.raisedPoint`                          | 1    |
| L1  | низкая   | читаемость                               | `_surfaceK` в контроллере — фабрика, а `_surfaceK` в `ImpactEffect` — сама функция                     | 5    |
| L2  | низкая   | документированность                      | Документация, CHANGELOG и комментарий `_surfaceK` описывают осколки у торца как исправленное поведение | 5, 6 |
| L3  | низкая   | стандартизация (процесс)                 | `plan/ramp-debris-parallax.md`: этап 7 не отмечен, план не в `plan/done/`                              | 7    |

### H1. Осколки и трассер у верхней кромки рампы

Хост склона не знает. Луч уровня 0 вверх по рампе проходит сквозь насыпь и упирается в стража верхнего торца: x =
318.4 при кромке 320. efb097a кладёт осколки на склон в этой точке, на высоту ≈ 1 уровень. На деле пуля с пола
летит на высоте ствола и встречает склон почти у подножия.

**Тесты закрепили ошибку.** В `tests/client/parts/effects/ShotEffectController.test.js`, блок
«осколки на склоне рампы», строка подписана «выстрел с земли, попадание у верха рампы». Тест проверяет, что осколок
лежит на высоте 0.875 уровня, то есть ровно то, на что жалуется пользователь.

### H2. Предиктор не видит стражей рамп

`ShotPredictor::cast_ray` (`core/src/client/shot.rs`, ≈ стр. 664–803) проверяет стены сетки, ящики и чужие танки,
но не стражей. Своя строка трассера подменяет авторитетную: `filter` в `shot.rs` (≈ стр. 429) гасит свой
авторитетный дубль. Поэтому игрок видит попадание туда, куда хост пулю не пустил (вторая колонка таблицы).

### H3. Выстрел с моста вниз по рампе обрывается на кромке

Луч с моста падает на уровень 0 в верхней клетке рампы (`shot_levels::ray_segments`). Граница падения совпадает с
кромкой `run.max`, где стоит центр стража торца. Сегмент начинается внутри бокса стража, и Rapier
`cast_ray(…, solid = true)` даёт `toi = 0` (строка 2 таблицы). Модель высоты пули это снимает: стражей пуля не
видит, а насыпь (не выше 1) ниже пули с моста (1 + ствол).

### N1. Танк высоко на рампе поражается с земли

Танк на рампе в переходе держит коллизии обоих уровней (`Transit::Ramp`), поэтому наземный луч его достаёт в любой
точке прогона. С моделью высоты пули наземный выстрел упирается в склон там, где тот поднялся до высоты ствола.
Танк дальше этой точки недосягаем, танк у подножия — досягаем.

### N2. Выстрел в борт на полу

Хост останавливает луч о борт-стража на полу (y = 321.6 в таблице), клиент рисует конец и искры на полу. У стен
(этап 14.4 прошлой задачи) конец и искры лежат на видимой грани на высоте ствола. С моделью высоты насыпи ядро
останавливает луч на грани (код 3), а клиент рисует её тем же путём, что стену.

### M1. `reproject` дублирует `raisedPoint`

`wallFace.raisedPoint` вычисляет `q = (p·(1 + kR) − cam·kR + cam·kB)/(1 + kB)`, а `reproject` —
`cam + (p − cam)·(1 + k)/(1 + kHost)`. Это одна и та же формула. `raisedPoint` используется только в
`ShotEffectController._wallEnd` и в тестах.

### Проверено — замечаний нет

- **`ImpactEffect.project`** идемпотентен: считает из `pData`, а не из спрайта, поэтому порядок тика и `onRender`
  не важен. Проверки `_placeDebris` корректны, регистрация `onRender` покрыта тестом.
- **Перевод `_placeFlash` на `reproject`**: формула совпадает, старые тесты вспышки зелёные.
- **Производительность.** `heightAt` зовётся на каждый летящий осколок за тик: 2–4 осколка, полёт ≈ 0.45 с.
  Линейный обход прогонов, у лежащего осколка высота кешируется. Новый расчёт насыпи в ядре — линейный обход
  прогонов один раз на выстрел.
- **Безопасность.** Новых сетевых входов нет: код попадания — тот же `u8`, сравнения строгие. NaN в координатах
  даёт «нет встречи» (все сравнения ложны).
- **Масштабируемость.** Обход прогонов линейный. Индекс понадобится только на сотнях прогонов.

---

## Этап 1. `reproject` вместо дубля `wallFace.raisedPoint` (M1) ✅ выполнен

1. `src/client/wallFace.js`: удалить функцию `raisedPoint` и её комментарий. В шапке фразу «…и где на ней
   рисуется точка» заменить на «…точку на грани на высоте даёт `reproject` (`src/client/parallax.js`)».
2. `ShotEffectController.js`: убрать `raisedPoint` из импорта `wallFace.js` (`reproject` уже импортирован). В
   `_wallEnd`, ветка `faceIsFront`, заменить `raisedPoint(` на `reproject(` с теми же аргументами. Деструктуризация
   `({ x, y } = …)` остаётся, лишнее поле `scale` не мешает.
3. `src/client/parallax.js`: в шапке, в перечне переносов `reproject`, добавить «конец трассера на грани стены».
4. Тесты:
   - `tests/client/wallFace.test.js`: удалить `describe('wallFace: raisedPoint')` и импорт.
   - `tests/client/parallax.test.js`, блок `parallax: reproject`: добавить случай из удалённого теста. Камера
     `{ x: 10, y: −20 }`, `kHost = 0.22`, `k = 0.22 + 0.19 · 0.22`, точка `(120, 80)`:
     `offsetPoint(q, camera, kHost)` совпадает с `offsetPoint(p, camera, k)` до 6 знаков.
   - `tests/client/parts/effects/ShotEffectController.test.js`: импорт `raisedPoint` заменить на `reproject`. В
     тесте «грань к камере…» (≈ стр. 504) — `reproject(96, 40, { x: 0, y: 40 }, 0, tracer.height * parallax.shear)`.
5. Документация: в `docs/en/architecture.md` и `docs/ru/architecture.md` (`grep -n raisedPoint`) заменить
   `` `raisedPoint` `` на `` `reproject`, `src/client/parallax.js` ``.
6. Проверка: `grep -rn raisedPoint src tests docs` ничего не находит, `npx vitest run tests/client` зелёный.

---

## Этап 2. Ядро: высота пули и насыпь рамп — общий модуль, данные, хост (H1, H2, H3, N1, N2) ✅ выполнен

### 2.1. Высота ствола в данных модели

- `src/data/models.js`, модель `m1`, рядом с `size`:
  ```js
  // высота ствола над полом, мировые единицы: пуля hitscan летит на ней и
  // упирается в насыпь рампы, если та выше (core/src/shot_height.rs).
  // = tankModel.barrelHeight 8 px · size 3 / 10 (src/config/render.js)
  barrelHeight: 2.4,
  ```
- `core/src/config.rs`, `ModelConfig`: поле
  ```rust
  /// Высота ствола над полом, мировые единицы (`barrelHeight`): пуля hitscan
  /// летит на ней (`shot_height::bullet_line`). Нет в конфиге — 0, пуля у
  /// самого пола.
  #[serde(default)]
  pub barrel_height: f32,
  ```
- `core/src/tank.rs`, `struct Tank`: приватное поле `barrel_height: f32`, заполняется в `Tank::new` из
  `model.barrel_height` (рядом с `width`), плюс геттер `pub fn barrel_height(&self) -> f32`.
- Страховочный JS-тест (в `tests/config/` или рядом с тестами данных, по месту): `models.m1.barrelHeight ===
tankModel.barrelHeight * models.m1.size / 10`, а `tracer.height` ≈ `models.m1.barrelHeight /
tankModel.levelHeight` с допуском 0.01. Рендер и ядро держат высоту ствола парой, общего источника у них нет. Тот
  же приём, что у `LandingShake`.

### 2.2. Общий модуль — `core/src/shot_height.rs` (новый)

Подключить в `core/src/lib.rs`: `mod shot_height;`, рядом с `mod shot_levels;`.

```rust
//! Высота пули hitscan и насыпь рамп. Физика и лучи двумерны, а рампа —
//! склон: пуля летит на высоте ствола стрелка и упирается в насыпь (склон
//! сверху, борт, торец), только если та выше неё. Стражи рамп
//! (`map::ramp_guards`) — препятствие для ТЕЛ; пуле они давали упор у
//! верхней кромки, в кромку моста и в борт на полу. Одна модель на хост
//! (`TanksSim::process_hitscan`), предиктор (`ShotPredictor::cast_ray`) и
//! ботов (`bots::controller`) — копии расходятся молча.

use vimp_engine_core::map::MapLevels;

use crate::shot_levels::RaySegment;

/// Код попадания в строке трассера (`wasHit`, u8 схемы `w1`). Зеркало —
/// `W1_HIT_*` в src/client/snapshotFields.js.
pub const HIT_NONE: u8 = 0;
/// Тело или стена.
pub const HIT_TARGET: u8 = 1;
/// Склон рампы сверху: насыпь поднялась выше пули, или пуля дошла вверх по
/// склону до верхнего торца. Высота пули в точке — высота склона.
pub const HIT_SLOPE: u8 = 2;
/// Грань насыпи — борт или торец, в который луч вошёл снаружи ниже её
/// верха. Клиент рисует её как грань стены.
pub const HIT_EMBANKMENT_FACE: u8 = 3;

/// Высота пули вдоль луча, в уровнях: `base + rate · t`, `t` — дистанция
/// от дула вдоль луча (мировые единицы).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BulletLine {
    pub base: f32,
    pub rate: f32,
}

impl BulletLine {
    pub fn at(&self, t: f32) -> f32 {
        self.base + self.rate * t
    }
}

/// Линия пули стрелка. Корпус на высоте `z` (уровни), ствол на `barrel`
/// мировых единиц над полом, дуло в `muzzle_offset` вдоль луча впереди
/// центра корпуса. `slope_vec` — безразмерный уклон под корпусом
/// (`LevelState::slope_vec`: ноль вне склона и в полёте). Стоящий на склоне
/// наклонён вместе с корпусом, ствол идёт вдоль склона, и высота пули
/// меняется с уклоном по направлению выстрела. `level_height` — мировых
/// единиц на уровень (`MapLevels::level_height`).
pub fn bullet_line(
    z: f32,
    slope_vec: [f32; 2],
    dir: [f32; 2],
    barrel: f32,
    muzzle_offset: f32,
    level_height: f32,
) -> BulletLine {
    let rate = (slope_vec[0] * dir[0] + slope_vec[1] * dir[1]) / level_height;

    BulletLine {
        base: z + barrel / level_height + rate * muzzle_offset,
        rate,
    }
}

/// Встреча пули с насыпью рампы.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EmbankmentHit {
    /// дистанция вдоль луча
    pub t: f32,
    /// уровень сегмента (нижний уровень рампы)
    pub level: u8,
    /// `HIT_SLOPE` или `HIT_EMBANKMENT_FACE`
    pub code: u8,
}

// параметры входа и выхода луча o + d·t в полосу [lo, hi]; None — мимо
fn slab(o: f32, d: f32, lo: f32, hi: f32) -> Option<(f32, f32)> {
    if d.abs() < 1e-9 {
        return (lo..=hi).contains(&o).then_some((f32::NEG_INFINITY, f32::INFINITY));
    }

    let a = (lo - o) / d;
    let b = (hi - o) / d;

    Some(if a < b { (a, b) } else { (b, a) })
}

/// Первая встреча пули с насыпью рамп уровня `level` на отрезке луча
/// `[t0, t1]`. Учитываются прогоны, чей НИЖНИЙ уровень — `level`. Внутри
/// прогона высота склона и пули вдоль прямого луча линейны, поэтому точка
/// считается точно. Правила:
///   - вошёл в прогон снаружи (не у начала отрезка), а насыпь на входе выше
///     пули — грань (`HIT_EMBANKMENT_FACE`): борт или торец;
///   - внутри прогона склон поднялся выше пули — склон (`HIT_SLOPE`);
///   - дошёл вверх по склону до верхнего торца — склон (`HIT_SLOPE`) на
///     торце: пуля над плитой уровня выше этой моделью уровней не
///     продолжается (прежде её так же останавливал страж торца).
pub fn embankment_hit(
    levels: &MapLevels,
    origin: [f32; 2],
    dir: [f32; 2],
    t0: f32,
    t1: f32,
    level: u8,
    bullet: &BulletLine,
) -> Option<EmbankmentHit> {
    let mut best: Option<EmbankmentHit> = None;

    for run in levels.runs() {
        if run.from.min(run.to) != level {
            continue;
        }

        let span = run.max - run.min;

        if span <= 0.0 {
            continue;
        }

        let along_x = run.axis == 0;
        let (ao, ad) = if along_x { (origin[0], dir[0]) } else { (origin[1], dir[1]) };
        let (co, cd) = if along_x { (origin[1], dir[1]) } else { (origin[0], dir[0]) };
        let (Some(along), Some(cross)) = (
            slab(ao, ad, run.min, run.max),
            slab(co, cd, run.cross_min, run.cross_max),
        ) else {
            continue;
        };
        let t_in = t0.max(along.0).max(cross.0);
        let t_out = t1.min(along.1).min(cross.1);

        if !(t_in <= t_out) {
            continue;
        }

        let surface = |t: f32| {
            let progress = ((ao + ad * t - run.min) / span).clamp(0.0, 1.0);
            let progress = if run.sign > 0 { progress } else { 1.0 - progress };

            run.from as f32 + (run.to as f32 - run.from as f32) * progress
        };
        let gap_in = surface(t_in) - bullet.at(t_in);
        let gap_out = surface(t_out) - bullet.at(t_out);
        // вверх по склону: подъём прогона — по знаку оси
        let uphill = ad * run.sign as f32 > 0.0;
        // выход через верхний торец: вдоль оси раньше, чем поперёк
        let exits_top = uphill && along.1 <= cross.1 && along.1 <= t1;

        let hit = if gap_in > 0.0 {
            let code = if t_in > t0 { HIT_EMBANKMENT_FACE } else { HIT_SLOPE };

            Some((t_in, code))
        } else if gap_out > 0.0 {
            Some((t_in + (-gap_in) / (gap_out - gap_in) * (t_out - t_in), HIT_SLOPE))
        } else if exits_top {
            Some((along.1, HIT_SLOPE))
        } else {
            None
        };

        if let Some((t, code)) = hit
            && best.is_none_or(|b| t < b.t)
        {
            best = Some(EmbankmentHit { t, level, code });
        }
    }

    best
}

/// Ближайшая встреча пули с насыпью по всем сегментам луча (`ray_segments`).
pub fn first_embankment_hit(
    levels: &MapLevels,
    segments: &[RaySegment],
    origin: [f32; 2],
    dir: [f32; 2],
    bullet: &BulletLine,
) -> Option<EmbankmentHit> {
    segments
        .iter()
        .filter(|segment| segment.t1 > segment.t0)
        .filter_map(|segment| {
            embankment_hit(levels, origin, dir, segment.t0, segment.t1, segment.level, bullet)
        })
        .min_by(|a, b| a.t.total_cmp(&b.t))
}
```

Замечания для исполнителя:

- Поля прогона (`axis`, `sign`, `from`, `to`, `min`, `max`, `cross_min`, `cross_max`) — публичные поля
  `RampRun` движка. Если ругается формат `let … else` / `let chains` — переписать под версию Rust из
  `rust-toolchain`/CI, смысл тот же.
- Широкая рампа режется на полосы (прогоны одного `block`). Луч, перешедший из полосы в полосу, внутри насыпи не
  «входит снаружи»: если на общей границе склон выше пули, он был выше и в предыдущей полосе, и ближняя встреча
  найдётся там. `min` по прогонам это обеспечивает.

**Юнит-тесты в `mod tests` модуля.** `MapLevels` строить через `MapLevels::build` по образцу `layered()` из
`shot_levels.rs`: клетка 10, рампа в строке 1, колонки 3..5 (x 30..60), подъём на восток 0 → 1, плита уровня 1 в
колонках 6..9, `level_height` — `None` (= клетка 10). Пуля пола `BulletLine { base: 0.1, rate: 0.0 }`.

- вдоль оси вверх из `(5, 15)`, отрезок `[0, 100]`: `HIT_SLOPE` при `t ≈ 33 − 5 = 28` (склон 0.1 на x = 33);
- пуля с моста вниз по рампе: из `(75, 15)` на запад, `base 1.1`, уровень 0, отрезок `[15, 100]` (луч упал на
  x = 60) — `None`;
- стрелок на склоне вверх вдоль склона: уклон рампы `rise · levelHeight / span = 1 · 10 / 30 = 1/3`, стрелок в
  `(40, 15)` на высоте `z = (40 − 30)/30 = 1/3`,
  `bullet_line(1.0 / 3.0, [1.0 / 3.0, 0.0], [1.0, 0.0], 1.0, 0.0, 10.0)` (пуля параллельна склону, на 0.1 выше),
  луч на восток, отрезок `[0, 100]` → `HIT_SLOPE` на торце x = 60, `t = 20`;
- сбоку по `−y` из `(45, 28)` при `base 0.1`, отрезок `[0, 100]`: `HIT_EMBANKMENT_FACE` на y = 20, `t = 8` (склон
  там 0.5);
- сбоку у подножия, где склон ниже пули: из `(33, 28)` по `−y`, `base 0.2` (склон там 0.1) → `None`, пуля
  перелетает борт;
- к верхнему торцу из-под моста: из `(75, 15)` на запад, `base 0.1`, уровень 0, отрезок `[0, 100]` →
  `HIT_EMBANKMENT_FACE` на x = 60, `t = 15`;
- `level` другого уровня — `None`; отрезок `[t0, t1]`, кончающийся до склона, — `None`;
- `bullet_line`: на полу `rate 0`, `base = z + barrel / level_height`; поперёк склона (`slope_vec ⟂ dir`) `rate 0`;
  вдоль склона `rate = slope / level_height`; `muzzle_offset` сдвигает `base` на `rate · offset`.

### 2.3. Хост — `core/src/tanks.rs`, `process_hitscan`

1. Импорт: из `vimp_engine_core::map` добавить `levels_interaction_on_ramp` (`level_group` уже есть). Импорт
   `crate::shot_height::{bullet_line, first_embankment_hit, HIT_EMBANKMENT_FACE, HIT_NONE, HIT_SLOPE, HIT_TARGET}`.
2. `struct TracerRow`: поле `was_hit: bool` → `hit: u8`, в `fields()` — `FieldValue::U8(self.hit)`, doc-комментарий:
   «+ код попадания (`shot_height::HIT_*`)».
3. Фильтр сегмента: `filter.groups(level_interaction(segment.level))` →
   ```rust
   // пуля видит уровень как тело на прогоне — без стражей рамп: насыпь
   // судит её высота (`shot_height::embankment_hit`)
   filter = filter.groups(levels_interaction_on_ramp(level_group(segment.level)));
   ```
   Если `level_interaction` в файле больше нигде не нужен — убрать из импорта.
4. До цикла по сегментам посчитать линию пули:
   ```rust
   let shooter = &self.tanks[&shooter_id];
   let muzzle_offset = (origin - shot.body_position).dot(dir);
   let bullet = self.levels.as_ref().map(|levels| {
       bullet_line(
           shooter.level_state.z,
           shooter.level_state.slope_vec,
           [dir.x, dir.y],
           shooter.barrel_height(),
           muzzle_offset,
           levels.level_height(),
       )
   });
   ```
   Типы `origin`, `shot.body_position` и `dir` — векторы Rapier, `.dot` у них есть. Если `shot.body_position` —
   не вектор, взять позицию тела стрелка.
5. После цикла по сегментам:
   ```rust
   // насыпь рамп выше пули (`shot_height`): ближе попадания в коллайдер —
   // луч кончается на ней, без урона и импульса
   let embankment = match (self.levels.as_ref(), bullet.as_ref()) {
       (Some(levels), Some(bullet)) => {
           first_embankment_hit(levels, &segments, [origin.x, origin.y], [dir.x, dir.y], bullet)
       }
       _ => None,
   }
   .filter(|e| hit.is_none_or(|(_, distance, _)| e.t < distance));

   if embankment.is_some() {
       hit = None;
   }
   ```
   Затем:
   - `let hit_code = match (hit, embankment) { (Some(_), _) => HIT_TARGET, (None, Some(e)) => e.code, _ => HIT_NONE };`
   - сразу после строк, где `end_x`/`end_y`/`end_level` получают значения промаха (`round1(end_point_ray…)`,
     `level_at_distance`), вставить:
     ```rust
     // луч кончился на насыпи рампы
     if let Some(e) = embankment {
         let point = origin + dir * e.t;

         end_x = round1(point.x);
         end_y = round1(point.y);
         end_level = e.level;
     }
     ```
   - существующая ветка `if let Some((collider_handle, distance, level)) = hit` (урон, импульс) остаётся как есть:
     при победе насыпи `hit` уже `None`;
   - в `TracerRow` — `hit: hit_code`.
6. Одноуровневая карта (`self.levels == None`) даёт `bullet = None`, насыпи нет: путь стрельбы прежний бит в бит.

### 2.4. Тесты этапа 2

- **Правила игры — `core/tests/sim.rs`** (по `CLAUDE.md` правила проверяются здесь). Карта `layered_map_json()`:
  клетка 32, `level_height` не задан (= 32), ствол 2.4 → пуля пола на 0.075 уровня, склон 0.075 на x = 201.6. Если
  конфиг моделей в `sim.rs` задан JSON-ом (≈ стр. 29), добавить в `m1` `"barrelHeight": 2.4`.
  - `ground_shot_stops_on_the_slope_before_a_tank_high_on_the_ramp` (N1). Цель 2 с `(208, 304, 0°)`, едет вперёд
    (`apply_input(2, 1, "down", "forward")`), шаги по одному, пока `tank_z(&core, 2) >= 0.6` (предел 200 шагов).
    Стрелок 1 на земле с `(100, 304, 0°)`, спаунится до начала езды. Дальше `core.take_events()`,
    `fire(&mut core, 1, 1)`. Ожидание: `health_of(&events(&mut core), 2)` — `None`. До правки — `Some(60)`.
  - `ground_shot_hits_a_tank_at_the_foot_of_the_ramp` (регресс N1). Цель стоит в `(196, 304)`, стрелок как выше.
    Ожидание: `Some(h)`, `h < 100`.
  - `shot_from_the_bridge_goes_down_the_ramp` (H3). Стрелок на плите `(352, 304, 180°)`, цель на земле
    `(150, 304)`. Ожидание: `Some(h)`, `h < 100`. До правки — `None`.
- **JS, хост, `tests/core/core.test.js`.** Новый `describe('насыпь рампы')` на `layeredMap`, по образцу теста
  «трассер w1 несёт уровни луча…». Выстрел, `pack_frame`, `decode(...).snapshot.w1[0]`:
  - с земли `(150, 304, 0)`: `tracer[2]` ≈ 201.6 (`toBeCloseTo(201.6, 1)`), `tracer[6] === 2`, `tracer[9] === 0`;
  - с моста `(352, 304, 180)`: `tracer[2]` ≈ 32, `tracer[6] === 1`, `tracer[9] === 0`;
  - в борт с земли `(272, 360, 270)`: `tracer[3]` ≈ 320, `tracer[6] === 3`, `tracer[9] === 0`;
  - со склона вверх: стрелок 1 едет с `(208, 304, 0)` вперёд, пока его z (строка `players_data`, индекс 11) не
    станет ≥ 0.2, затем стреляет: `tracer[2]` ≈ 320, `tracer[6] === 2`.
    Существующее `expect(tracer[6]).toBe(1)` (≈ стр. 204) не меняется.
- Команды: `npm run core:test`, `npm run core:build`, `npx vitest run tests/core/core.test.js`.

---

## Этап 3. Ядро: то же правило у предиктора и ботов (H2, N1) ✅ выполнен

### 3.1. Уклон своего танка в `RenderState`

`core/src/client/predictor.rs`, `struct RenderState` (≈ стр. 160): добавить поле

```rust
/// уклон под корпусом (`LevelState::slope_vec` реплики): по нему пуля
/// стоящего на склоне идёт вдоль склона (`shot_height::bullet_line`)
pub slope_vec: [f32; 2],
```

Заполнить там, где собирается `RenderState` (≈ стр. 1000), из `level_state.slope_vec` реплики, рядом с `z`/`level`.
Во всех прочих конструкциях `RenderState { … }` (найти через `grep -rn "RenderState {" core/src`, в том числе
тестовый `render_at` в `shot.rs`) — `slope_vec: [0.0, 0.0]`.

### 3.2. Предиктор — `core/src/client/shot.rs`

1. `enum RayTarget` дополнить вариантом, обновив комментарий над enum:
   ```rust
   // насыпь рампы (`shot_height::embankment_hit`): код `HIT_SLOPE` или
   // `HIT_EMBANKMENT_FACE`
   Embankment(u8),
   ```
2. `cast_ray` получает параметр `bullet: Option<BulletLine>`. После цикла по сегментам:
   ```rust
   // насыпь рамп выше пули — тем же правилом, что у хоста
   if let (Some(levels), Some(bullet)) = (&self.levels, bullet.as_ref())
       && let Some(hit) = first_embankment_hit(levels, &segments, origin, dir, bullet)
   {
       consider(Some(hit.t), RayTarget::Embankment(hit.code), hit.level);
   }
   ```
   Стражей предиктор не видел и видеть не должен.
3. В `try_fire`, до вызова `cast_ray`:
   ```rust
   let bullet = self.levels.as_ref().map(|levels| {
       bullet_line(
           render.z,
           render.slope_vec,
           direction,
           model.barrel_height,
           (muzzle[0] - render.x) * direction[0] + (muzzle[1] - render.y) * direction[1],
           levels.level_height(),
       )
   });
   ```
   `model` — модель стрелка, как её уже берёт `try_fire` (`self.model`). Передать `bullet` в `cast_ray`.
4. Строка трассера (`json!`, ≈ стр. 624): элемент `hit.is_some()` заменить на `hit_code`:
   ```rust
   let hit_code = match &hit {
       None => HIT_NONE,
       Some((_, RayTarget::Embankment(code), _)) => *code,
       Some(_) => HIT_TARGET,
   };
   ```
   Предсказанная строка несёт число, как авторитетная (`u8`), а не `bool`.
5. Существующие тесты: `assert_eq!(tracer[6], Value::Bool(true))` → `assert_eq!(tracer[6].as_u64(),
Some(u64::from(HIT_TARGET)))`, `Bool(false)` → `HIT_NONE`. Места найти через
   `grep -n "tracer\[6\]" core/src/client/shot.rs`, их около 10. В фикстуре `models()` добавить
   `"barrelHeight": 1.0`.
6. Новые тесты `shot.rs`. Карта-хелпер `ramp_shot_map()` по образцу `layered_shot_map()`: `step 10, scale 1`,
   земля 10×3. Тайл рампы 3 — в строке 1, колонки 3..5, `"ramps": [{ "tile": 3, "dir": "east", "from": 0, "to": 1 }]`.
   Уровень 1: плита тайл 2 (`floor: [2]`) в колонках 6..9. Ствол 1.0 при клетке 10 → пуля пола 0.1.
   - `tracer_stops_on_the_ramp_slope`: `render_at(5.0, 15.0)` → `tracer[2]` ≈ 33, `tracer[6] == HIT_SLOPE`,
     `tracer[9] == 0`;
   - `tracer_passes_down_the_ramp_from_the_slab`: `RenderState { angle: PI, ..render_at_level(75.0, 15.0, 1) }` →
     `tracer[6] == HIT_NONE`, `tracer[2] < 30.0`, `tracer[9] == 0`;
   - `tracer_stops_on_the_embankment_side`: `RenderState { angle: -FRAC_PI_2, ..render_at(45.0, 28.0) }` →
     `tracer[3]` ≈ 20, `tracer[6] == HIT_EMBANKMENT_FACE`.
7. JS, `tests/core/clientCore.test.js`: те же четыре случая, что в хост-тесте этапа 2.4, через `try_fire` (по
   образцу «на слоёной карте трассер с моста падает за кромкой плиты»). Ожидания совпадают с хостом, кроме
   случая «со склона»: свой танк нужно довести до склона предиктором; если это громоздко — пропустить, его
   покрывает хост. Существующее `expect(tracer[6]).toBe(false)` (≈ стр. 354) → `toBe(0)`.

### 3.3. Боты — `core/src/bots/controller.rs`, `execute_aim_and_shoot`

Сразу после проверки `covers_level` (≈ стр. 598):

```rust
// насыпь рампы выше пули закрывает цель (`shot_height`): танк высоко на
// рампе с земли не достать — не тратим выстрел, путь приведёт к нему
let bullet = bullet_line(
    tank.level_state.z,
    tank.level_state.slope_vec,
    [dir.x, dir.y],
    tank.barrel_height(),
    0.0,
    levels.level_height(),
);

if crate::shot_height::first_embankment_hit(
    levels,
    &segments,
    [my_position.x, my_position.y],
    [dir.x, dir.y],
    &bullet,
)
.is_some_and(|hit| hit.t < direction.length())
{
    return;
}
```

Переменную `tank` к этому месту взять заново через `game.tanks.get(&self.game_id)`, если заём уже отпущен.

Тесты в `mod tests` контроллера (харнесс `Fixture` на `layered.json`). В `model()` добавить `"barrelHeight": 2.4`.

- `bot_holds_fire_at_a_tank_high_on_the_ramp`: бот `add_tank(1, 1, 100.0, 304.0, 0)`, цель
  `add_tank(2, 2, 282.0, 304.0, 0)`, `brain_at(1, [100.0, 304.0], 0)`, `Attacking`, цель 2. Ожидание:
  `!fires_within(&mut fixture, &mut brain, 100)`.
- `bot_fires_at_a_tank_at_the_foot_of_the_ramp`: цель в `(196, 304)` → `fires_within(...)`.

Команды: `npm run core:test`, `npm run core:build`, `npx vitest run tests/core`.

---

## Этап 4. JS: коды попадания и геометрия рамп (H1, N2) ✅ выполнен

1. `src/client/snapshotFields.js`, после `W1_ANCHOR`:
   ```js
   // значения W1_WAS_HIT — зеркало `HIT_*` в core/src/shot_height.rs
   export const W1_HIT_NONE = 0;
   export const W1_HIT_TARGET = 1;
   // склон рампы сверху: высота пули в точке — высота склона
   export const W1_HIT_SLOPE = 2;
   // грань насыпи (борт или торец снаружи): рисуется как грань стены
   export const W1_HIT_EMBANKMENT_FACE = 3;
   ```
   `src/config/snapshot.js`, у поля `wasHit`: комментарий «код попадания: `W1_HIT_*` (src/client/snapshotFields.js)».
2. `src/client/rampSurface.js`. Общие хелперы и две новые функции; `rampSurfaceAt` переписать через них без смены
   поведения:
   ```js
   // учитывается ли прогон для уровня `level`: уровень между подножием и
   // вершиной (пол террасы под горкой уровнем выше рампой не накрыт)
   const coversLevel = (run, level) =>
     level >= Math.min(run.from, run.to) && level <= Math.max(run.from, run.to);

   // высота склона прогона на координате `along` вдоль его оси, в уровнях
   const runHeight = (run, along) => {
     const span = run.max - run.min;
     const t = span > 0 ? (along - run.min) / span : 0;
     const progress = run.sign > 0 ? t : 1 - t;

     return run.from + (run.to - run.from) * progress;
   };

   // прогон уровня `level` под мировой точкой (границы включительно); null — нет
   export function rampRunAt(runs, level, x, y) { … }

   // Склон под точкой: `{ height, axis }` — высота в уровнях и ось прогона
   // (0 = x, 1 = y; линия равной высоты ей перпендикулярна); null — не рампа
   export function rampSlopeAt(runs, level, x, y) { … }

   // Грань насыпи, на которой лежит конец луча `(x, y)` с направлением
   // `(dx, dy)`: `{ face: { axis: 'x' | 'y', coord, nx, ny }, volume }` — в
   // формате `edgeFace` (src/client/wallFace.js) и высота верха грани над
   // уровнем в этой точке. Учитываются прогоны с НИЖНИМ уровнем `level`
   // (как у насыпи в ядре), конец — на ребре прямоугольника прогона в
   // допуске `tolerance`, и чуть дальше по лучу — внутри прогона (луч
   // входит в насыпь). null — не грань
   export function rampFaceAt(runs, level, x, y, dx, dy, tolerance) { … }
   ```
   Реализация `rampFaceAt`:
   - перебрать прогоны с `Math.min(from, to) === level`;
   - точка «чуть дальше по лучу» `(x + dx·δ, y + dy·δ)`, где `δ = 2 · tolerance`, лежит внутри прямоугольника
     прогона;
   - найти ребро, ближайшее к `(x, y)` в допуске: вдоль оси — `min`/`max` (грань-торец, `axis` = `'x'` при оси 0),
     поперёк — `crossMin`/`crossMax` (борт, `axis` = `'y'` при оси 0);
   - нормаль навстречу лучу, как в `edgeFace`: для `axis 'x'` — `nx = dx > 0 ? −1 : 1`, `ny = 0`;
   - `volume = runHeight(run, along точки «чуть дальше») − level`.
3. `src/client/index.js`, сервис `rampRuns`, рядом с `heightAt`:
   ```js
   // склон под точкой `{ height, axis }` (src/client/rampSurface.js); по
   // нему конец выстрела в склон ложится на склон на высоте пули
   slopeAt(level, x, y) {
     return rampSlopeAt(allRuns(), level, x, y);
   },
   // грань насыпи под концом луча `{ face, volume }` (src/client/rampSurface.js);
   // по ней выстрел в борт рисуется как в стену
   faceAt(level, x, y, dx, dy, tolerance) {
     return rampFaceAt(allRuns(), level, x, y, dx, dy, tolerance);
   },
   ```
4. Тесты:
   - `tests/client/rampSurface.test.js`. Регресс `rampSurfaceAt` (старые тесты зелёные); `rampSlopeAt` (высота и
     ось, `null` вне); `rampFaceAt` на прогоне `{ axis: 0, sign: 1, from: 0, to: 1, min: 100, max: 140, crossMin: 0,
crossMax: 20 }`:
     - борт — конец `(120, 0)`, луч `(0, 1)` → `{ face: { axis: 'y', coord: 0, nx: 0, ny: −1 }, volume ≈ 0.5 }`;
     - торец из-под моста — конец `(140, 10)`, луч `(−1, 0)` → `axis 'x'`, `coord 140`, `volume ≈ 1`;
     - конец внутри прогона → `null`; луч, уходящий из прогона наружу, → `null`; прогон с нижним уровнем 1 при
       `level 0` → `null`.
   - `tests/client/tanksClientPlugin.test.js`: `slopeAt` и `faceAt` на фикстуре блока, общий разбор (`ramp_runs`
     вызван один раз).

---

## Этап 5. `ShotEffectController`: конец на склоне и на грани насыпи (H1, N2, L1, L2) ✅ выполнен

### 5.1. Код — `src/client/parts/effects/shot/ShotEffectController.js`

1. Импорт `W1_HIT_SLOPE`, `W1_HIT_EMBANKMENT_FACE` из `snapshotFields.js`.
2. Конструктор: `this.hitCode = data[W1_WAS_HIT] || 0;` и `this.hit = this.hitCode !== 0;`. Предсказанные строки
   до этапа 3 несли `bool`: `true || 0` → `true`, и `!== 0` для него верно. Тестовые строки с `true`/`false`
   продолжают работать.
3. **N2 — грань насыпи как стена.** В `_wallAt(nx, ny)`, первой проверкой после `if (!this.hit) return null`:

   ```js
   // грань насыпи рампы (борт или торец): ядро остановило пулю на ней
   // ниже её верха — рисуется тем же путём, что стена
   if (this.hitCode === W1_HIT_EMBANKMENT_FACE) {
     return (
       this._rampRuns?.faceAt?.(
         this.endLevel,
         this.endPositionX,
         this.endPositionY,
         nx,
         ny,
         WALL_EDGE_TOLERANCE,
       ) ?? null
     );
   }
   ```

   Прежняя проверка `!this._volumes` переезжает ниже (к пути объёмов), чтобы грань насыпи работала и на карте без
   объёмов. Дальше `_wallEnd`, `_impactHost` и `_placeImpact` работают без изменений:
   - грань к камере — конец на высоте ствола (`endLevel + tracer.height`), контроллер над перекрывателем;
   - грань от камеры — обрыв на силуэте верха грани (`kLine = (endLevel + volume) · shear`);
   - искры — в слое `shot-impact` на высоте ствола.

   В комментарии `_wallAt` и в шапке `_wallEnd` дописать: «…или грань насыпи рампы (`W1_HIT_EMBANKMENT_FACE`)».

4. **H1 — конец на склоне.** Новый метод рядом с `_wallEnd`:
   ```js
   // Видимый конец выстрела в склон рампы (`W1_HIT_SLOPE`) `{ x, y, dist,
   // stopLine }` или null. Ядро уже остановило луч там, где насыпь
   // поднялась выше пули (core/src/shot_height.rs), — в этой точке высота
   // склона и есть высота пули. Кусок трассера стоит в проекции пола уровня
   // конца, поэтому конец переносится на склон (`reproject`); линия равной
   // высоты склона перпендикулярна оси прогона — она и есть `stopLine`.
   // Осколки лягут на склон сами (`_debrisSurface`)
   _slopeEnd(dist) {
     const slope =
       this.hitCode === W1_HIT_SLOPE && dist > 0.001
         ? this._rampRuns?.slopeAt?.(this.endLevel, this.endPositionX, this.endPositionY)
         : null;

     if (!slope) {
       return null;
     }

     const camera =
       this._levelView?.camera() ?? cameraCenter(this.parent, this._renderer);
     const { shear } = parallaxConfig;
     const { x, y } = reproject(
       this.endPositionX,
       this.endPositionY,
       camera,
       this.endLevel * shear,
       slope.height * shear,
     );

     return {
       x,
       y,
       dist: Math.hypot(x - this.startPositionX, y - this.startPositionY),
       stopLine: { axis: slope.axis === 0 ? 'x' : 'y', coord: slope.axis === 0 ? x : y },
     };
   }
   ```
5. `run()`: строку `const end = this._wallEnd(dx, dy, dist);` заменить на
   `const end = this._slopeEnd(dist) ?? this._wallEnd(dx, dy, dist);`. Комментарий над ней: «видимый конец луча: у
   выстрела в склон рампы — на склоне на высоте пули, у попадания в стену или грань насыпи — на грани. Точка удара
   (`endPositionX/Y`) остаётся исходной».
6. **L1.** Метод `_surfaceK()` переименовать в `_debrisSurface()` (вызов — в `_onTracerComplete`) и переписать его
   комментарий:

   > Коэффициент проекции поверхности под мировой точкой для осколков: на склоне рампы — высота склона
   > (`rampRuns.heightAt`, та же, что у вершин клина), иначе null — пол уровня конца. Нужен выстрелу в склон
   > (`W1_HIT_SLOPE`) и попаданию в танк на рампе: танк виден лучам обоих уровней, а нарисован на своём `z`.
   > Грани насыпи и стене не нужен — у них искры в своём слое на высоте ствола (`_impactHost`).

   Имена вида `_surfaceKFor` не годятся: правило ESLint запрещает две заглавные подряд.

### 5.2. Тесты — `tests/client/parts/effects/ShotEffectController.test.js`

1. **Фейк сервиса — через настоящие функции.** Импорт `rampSurfaceAt`, `rampSlopeAt`, `rampFaceAt` из
   `src/client/rampSurface.js`, `W1_HIT_SLOPE`, `W1_HIT_EMBANKMENT_FACE` — из `snapshotFields.js`:
   ```js
   // подъём 0 → 1 вдоль +x на [64, 128], полоса по y 16..80
   const runs = [
     { axis: 0, sign: 1, from: 0, to: 1, min: 64, max: 128, crossMin: 16, crossMax: 80 },
   ];
   const makeRampRuns = () => ({
     heightAt: vi.fn((level, x, y) => rampSurfaceAt(runs, level, x, y)),
     slopeAt: vi.fn((level, x, y) => rampSlopeAt(runs, level, x, y)),
     faceAt: vi.fn((...args) => rampFaceAt(runs, ...args)),
   });
   ```
   Прежние ожидания блока «осколки на склоне рампы» (y = 40) не меняются.
2. **Строка блока «осколки на склоне рампы».** `[10, 40, 120, 40, 10, 40, 1, 1, 0, 0]`, комментарий: «попадание в
   танк на склоне у верха рампы: танк виден лучам обоих уровней, и его осколки лежат на склоне». Код 1 — тело: на
   высоте склона осколки верны именно здесь.
3. **Новый блок `describe('ShotEffectController: выстрел в насыпь рампы')`.** Хелпер сдвига сцены — как
   `rampShot`, камера `{ x: 0, y: 40 }`, `renderer` как в блоке.
   - **«склон: конец на склоне на высоте пули, осколки там же».** Строка `[10, 40, 76, 40, 10, 40, W1_HIT_SLOPE, 1,
0, 0]`: ядро остановило пулю на x = 76, склон там `12/64`. После `run()`:
     - `tracer.endPositionX ≈ reproject(76, 40, camera, 0, (12 / 64) * parallax.shear).x`;
     - `tracer._stopLine` равен `{ axis: 'x', coord: tracer.endPositionX }`;
     - `controller.endPositionX === 76`;
     - после `finishTracer`: `impact.parent === controller`, `impact.x === 76`.
   - **«грань насыпи к камере: конец на высоте ствола, искры в слое shot-impact».** Строка `[96, 100, 96, 80, 96,
100, W1_HIT_EMBANKMENT_FACE, 1, 0, 0]` (выстрел на север в борт `y = 80`), камера южнее (`camY` > 80):
     - `controller.zIndex === levelZ(OCCLUDER_BASE_Z + 0.5, 0)`;
     - `tracer.endPositionY ≈ reproject(96, 80, camera, 0, tracer.height * parallax.shear).y`;
     - после `finishTracer`: `impact.parent.label === 'shot-impact'`.

     Хелпер сдвига сцены для этого теста задаёт центр камеры `(96, 200)`: `position.set(400 − 96, 300 − 200)`.

   - **«грань насыпи от камеры: обрыв на силуэте»**: камера севернее борта. Конец трассера — `crossingDistance` с
     `kLine = (0 + volume) · shear`, где `volume = (96 − 64)/64 = 0.5`.
   - **«без сервиса rampRuns — прежнее поведение»**: для обеих строк конец в исходной точке, `_stopLine` — `null`
     (или линия стены, если есть `volumes`).
   - **«код 1 — конец не переносится»**: строка с кодом 1 у склона — конец в исходной точке.
4. Команда: `npx vitest run tests/client`.

---

## Этап 6. Документация en/ru и CHANGELOG (L2) ✅ выполнен

Правило `CLAUDE.md`: парные страницы `docs/en/` и `docs/ru/` правятся одной правкой.

1. **`docs/en/architecture.md` / `docs/ru/architecture.md`.** Абзац из efb097a (en: «Debris of a hit that lands on
   a ramp lies on the drawn slope.», ru: «Осколки попадания на склоне рампы лежат на нарисованном склоне.») заменить
   двумя абзацами.
   - en:
     > Debris of a hit lies on the surface under it. A tank on a ramp is hit on the level of the ray's segment but
     > is drawn at its own `z`. So `ImpactEffect` takes `surfaceK(x, y)` from the controller: the projection of the
     > ramp surface under a world point, computed by `rampRuns.heightAt(level, x, y)` in
     > `src/client/rampSurface.js`. The value is `lerp(from, to, progress)`, the height of the wedge's vertices and
     > of the core's tank `z`, or `null` off a ramp. Every frame the controller's `onRender` calls
     > `ImpactEffect.project`, which moves each piece into the projection of its own point (`reproject`). The
     > height is re-read only while a piece flies.
     >
     > A shot into a ramp's embankment ends where the core stopped the bullet (`core/src/shot_height.rs`, see
     > [core.md](core.md)); the row's `wasHit` tells how. Code 2 (`W1_HIT_SLOPE`) means the slope's top: the
     > slope's height there IS the bullet's height. `_slopeEnd` lifts the tracer's end onto the slope
     > (`rampRuns.slopeAt`, `reproject`) with the slope's contour line as its `stopLine`, and the debris lies
     > there. Code 3 (`W1_HIT_EMBANKMENT_FACE`) means a side or the end face entered from outside below its top.
     > `_wallAt` takes that face from `rampRuns.faceAt`, and from there the shot is drawn exactly like a wall hit:
     > on the face at gun height, cut at the face's silhouette when the face turns away, sparks in `shot-impact`.
   - ru:
     > Осколки попадания лежат на поверхности под собой. Танк на рампе поражается на уровне сегмента луча, а
     > нарисован на своём `z`. Поэтому `ImpactEffect` получает от контроллера `surfaceK(x, y)` — проекцию
     > поверхности рампы под мировой точкой. Её считает `rampRuns.heightAt(level, x, y)` в
     > `src/client/rampSurface.js`: `lerp(from, to, progress)`, та же высота, что у вершин клина и у `z` танка
     > в ядре, или `null` вне рампы. Каждый кадр `onRender` контроллера вызывает `ImpactEffect.project`, и тот
     > переносит каждый осколок в проекцию его собственной точки (`reproject`). Высота перечитывается, только
     > пока осколок летит.
     >
     > Выстрел в насыпь рампы кончается там, где ядро остановило пулю (`core/src/shot_height.rs`, см.
     > [core.md](core.md)); как именно — говорит `wasHit` строки. Код 2 (`W1_HIT_SLOPE`) — склон сверху: высота
     > склона в точке и есть высота пули. `_slopeEnd` поднимает конец трассера на склон (`rampRuns.slopeAt`,
     > `reproject`), линия равной высоты склона становится его `stopLine`, и там же лежат осколки. Код 3
     > (`W1_HIT_EMBANKMENT_FACE`) — борт или торец, в который луч вошёл снаружи ниже его верха. `_wallAt` берёт
     > эту грань у `rampRuns.faceAt`, и дальше выстрел рисуется ровно как в стену: на грани на высоте ствола, с
     > обрывом на силуэте, когда грань отвёрнута, и с искрами в `shot-impact`.
2. **`docs/en/core.md` / `docs/ru/core.md`.**
   - В схеме модулей (≈ стр. 39) добавить `shot_height.rs  # bullet height and ramp embankments for hitscan`
     (ru — по-русски).
   - В раздел «Shooting and explosions across levels» / его ru-пару добавить подраздел о `shot_height.rs`:
     - модель пули: `bullet_line` (высота ствола `barrelHeight` модели, вдоль склона у стоящего на нём);
     - `embankment_hit` и его три правила: грань, склон, верхний торец;
     - коды `HIT_*`;
     - лучи хоста фильтруются `levels_interaction_on_ramp(level_group(level))` — без стражей рамп; вместо
       «Each segment is filtered with `level_interaction(segment.level)`» написать именно это;
     - та же модель у `ShotPredictor` (`RenderState::slope_vec`) и у ботов (не стреляют, если насыпь ближе цели).
   - В абзаце про `ShotPredictor` («`ShotPredictor` cuts its ray with the same `ray_segments()`…») добавить: насыпь —
     `first_embankment_hit`, код в строке — число `HIT_*`, а не `bool`.
3. **`docs/en/configuration.md` / `docs/ru/configuration.md`.**
   - Раздел `### models.js`: `barrelHeight: 2.4` — высота ствола в мировых единицах, на ней летит пуля hitscan;
     держится парой с `tankModel.barrelHeight`/`tracer.height` рендера (страховочный тест).
   - В предложении о сервисе `rampRuns` после `heightAt(level, x, y)` описать `slopeAt(level, x, y)` →
     `{ height, axis }` и `faceAt(level, x, y, dx, dy, tolerance)` → `{ face, volume }`.
   - В абзаце «The 2.5D level travels with the shot blocks as well…» / его ru-паре — коды `wasHit`: 0 промах, 1 тело
     или стена, 2 склон, 3 грань насыпи.
4. **`docs/en/gameplay.md` / `docs/ru/gameplay.md`**, таблица правил луча («A ray always travels at the shooter's
   level…»). Строку «Tank on a ramp» дополнить и добавить новую:
   - en: «**Ramp embankment** | A bullet flies at the shooter's gun height; on a slope the barrel follows the slope.
     A ramp's slope, sides and upper end stop it wherever the embankment is higher than the bullet. So a tank high
     up a ramp cannot be hit from the ground, a tank at its foot can, and a side shot hits the embankment face at
     gun height. A shot from the slab goes on down the ramp.»
   - ru: «**Насыпь рампы** | Пуля летит на высоте ствола стрелка; на склоне ствол идёт вдоль склона. Склон, борта и
     верхний торец рампы останавливают её там, где насыпь выше пули. Поэтому танк высоко на рампе с земли не
     поразить, у подножия — можно, а выстрел в борт попадает в грань насыпи на высоте ствола. Выстрел с плиты идёт
     вниз по рампе дальше.»
   - «Tank on a ramp» (en) / «Танк на рампе» (ru): дописать «…if the bullet reaches it over the embankment» /
     «…если пуля дошла до него над насыпью».
5. **`CHANGELOG.md`**, `## [Unreleased]`.
   - `### Changed`:
     ```markdown
     - Bullets fly at the shooter's gun height: a ramp's slope, sides and upper
       end stop them where the embankment is higher, so a tank high up a ramp
       can no longer be hit from the ground.
     ```
   - `### Fixed` — существующий пункт efb097a заменить тремя:
     ```markdown
     - A shot into a ramp ends on the slope or on the embankment face at gun
       height, with its debris or sparks there, instead of at the ramp's top
       edge or on the ground by its side; debris on a slope no longer slides
       across it as the camera moves.
     - Your own shots no longer fly through a ramp in prediction: they stop
       where the host stops them.
     - A tank on a bridge can shoot down the ramp that leads onto it; the shot
       used to stop at the bridge edge.
     ```

---

## Этап 7. Прошлый план в `plan/done/`, итоговая проверка (L3) ✅ выполнен

> Закрыт 2026-09-28. Шаг 1 выполнен: `plan/ramp-debris-parallax.md` в `plan/done/`. Итоговая и ручная проверка
> (шаги 2–3) перенесены в этап 6 плана `plan/bullet-flight-level/`. Пункты «с моста вниз по рампе пуля идёт
> дальше» и «со склона вверх — конец у верхней кромки» тем планом отменены: пуля с моста не падает, а выстрел
> со склона уходит над плитой.

1. `plan/ramp-debris-parallax.md`: этап 7 отметить «✅ выполнен» в таблице и у заголовка (пользователь прогнал
   eslint, тесты и сборку, всё зелёное), затем `git mv plan/ramp-debris-parallax.md plan/done/`.
2. Команды — все зелёные:
   ```bash
   npm run core:test
   npm run core:build
   npx eslint .
   npm test -- --silent
   npm run build
   npm run sim:scenarios
   ```
3. Вручную: `npm run dev`, карта `downtown`, день и ночь, с ботами.
   - **С земли вверх по рампе** моста (`RAMP_S`) и по `RAMP_E`: трассер и осколки у подножия, на высоте ствола.
     Осколки не ползут, пока танк объезжает рампу.
   - **Танк наверху рампы** с земли не поражается (трассер упирается в склон), у подножия — поражается. Боты с
     земли по танку наверху рампы не стреляют.
   - **В борт сбоку:** конец и искры на грани насыпи на высоте ствола; с камерой за насыпью — обрыв на силуэте.
     У самого подножия пуля перелетает низкий борт.
   - **Со склона:** вверх — конец у верхней кромки; вниз и поперёк — пуля уходит дальше.
   - **С моста вниз по рампе:** пуля идёт по рампе и дальше.
   - Стена и ящик — как раньше; свой и чужой трассеры совпадают.
4. Перенести этот план в `plan/done/` (`git mv`), без коммита.

---

## За рамками

- **Пуля со склона не выходит на плиту выше.** Выстрел со склона вверх остаётся на нижнем уровне: `ray_segments`
  не поднимает луч на плиту, над которой он летит. Поэтому такой выстрел кончается у верхнего торца, как и
  сегодня со стражем. Чтобы пуля продолжала полёт над плитой, `ray_segments` должен узнать высоту пули — это
  отдельная задача.
- **Рендер держит высоту ствола константой для `downtown`.** `tracer.height = 0.19` посчитан от
  `tankModel.levelHeight = 12.8`. На карте с другой высотой уровня конец на грани стены или насыпи рисуется чуть
  выше или ниже точки ядра. Конец на склоне (код 2) не страдает: он берёт высоту склона.
- **Следы гусениц на склоне** (`Tracks._updateLayers`, проекция на целый уровень) не проверялись.
