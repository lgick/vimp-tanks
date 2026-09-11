# Этап 1. Движок: общая геометрия стражей, NaN, буферы, нав-граф ✅ выполнен

> Часть плана `plan/review-multilevel-3/` — см. индекс
> [README.md](README.md) (контекст, таблица пунктов, принятые решения,
> критерии приёмки). Этот файл самодостаточен для исполнения этапа.
>
> **E** = `/Users/dmitry/Sites/my/vimp` (крейт `vimp-engine-core` + npm
> `vimp-engine`), **T** = `/Users/dmitry/Sites/my/vimp-tanks` (npm
> `@vimp-games/tanks`).
> Коммитов не делать. Любая функциональная правка обновляет `docs/en/` И
> `docs/ru/` и `CHANGELOG.md` под `## [Unreleased]` в том же изменении.
> Пороги `divergence.thresholds` в `tests/scenarios/*.json` не трогать.

Файлы: `packages/engine/core/src/map.rs`,
`packages/engine/core/src/client/collision.rs`,
`packages/engine/core/src/nav/navigation.rs`,
`packages/engine/core/CHANGELOG.md`, `docs/en/core.md`, `docs/ru/core.md`.

## 1.1 Д1а — `ramp_guards` как единственный источник геометрии

**Проблема.** `GameMap::create_ramp_guards`
(`packages/engine/core/src/map.rs:1460-1530`) и
`Predictor::resolve_world` (`T core/src/client/predictor.rs:1007-1100`)
считают одно и то же тремя десятками строк каждый:

- толщину борта `step * 0.1` (E `map.rs:1469`) ↔ `levels.tile_size() * 0.1`
  (T `predictor.rs:1013`) — числа совпадают только потому, что
  `GameMap::step == MapLevels::tile_size` (оба `cfg.step * scale`,
  `map.rs:1368`, `map.rs:1369-1378`);
- склейку полос одной горки по `run.block` (E `map.rs:1474-1483` ↔
  T `predictor.rs:1017-1026`);
- три бокса: два борта по `cross_min`/`cross_max` во всю длину прогона и
  торец толщиной `thickness` на «неправильном» конце
  (`far = if run.sign > 0 { run.max } else { run.min }`)
  (E `map.rs:1508-1512` ↔ T `predictor.rs:1056-1060`).

Совпадение проверяется только косвенно — отладочными сценариями. Правка в
движке молча разводит предсказание с сервером.

**Решение.** Вынести формулу в публичную функцию крейта, рядом с
`body_filter`/`level_group`/`ramp_guard_interaction` (`map.rs:638-691`):

```rust
/// Один страж прогона рампы: бокс без поворота и уровень, для тел которого
/// он существует (`ramp_guard_interaction`). Формула ОДНА на хост и на
/// клиентскую реплику: копия расходится молча — ровно так расходилось
/// предсказание до этой функции.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RampGuard {
    /// центр бокса в мировых единицах
    pub x: f32,
    pub y: f32,
    pub half_w: f32,
    pub half_h: f32,
    /// уровень, с которого начинается прогон: страж существует только для
    /// тел этого уровня
    pub low: u8,
}

/// Борта и «неправильный» торец каждого БЛОКА горки. Одноуровневая карта
/// даёт пустой список: число и порядок тел старой карты обязаны остаться
/// прежними.
pub fn ramp_guards(levels: &MapLevels) -> Vec<RampGuard>
```

Тело функции — точный перенос `create_ramp_guards:1463-1514`:

1. `if !levels.is_layered() { return Vec::new(); }`
2. `let thickness = levels.tile_size() * 0.1;`
3. склейка блоков: `Vec<(u16, RampRun)>`, для каждого `run` из
   `levels.runs()` — найти по `run.block`, расширить `cross_min`/`cross_max`
   (`min`/`max` соответственно), иначе положить `run.clone()`;
4. на каждый блок — три `RampGuard` в том же порядке, что сейчас:
   борт `cross_min`, борт `cross_max`, торец `far`.

`create_ramp_guards` становится циклом по `ramp_guards(&self.levels)`:

```rust
fn create_ramp_guards(&mut self, world: &mut PhysicsWorld) {
    for guard in ramp_guards(&self.levels) {
        let body = world.insert_body(
            RigidBodyBuilder::fixed().translation(Vector::new(guard.x, guard.y)),
        );

        world.insert_collider(
            ColliderBuilder::cuboid(guard.half_w, guard.half_h)
                .friction(DEFAULT_FRICTION)
                .restitution(DEFAULT_RESTITUTION)
                .collision_groups(ramp_guard_interaction(guard.low)),
            Some(body),
        );

        self.static_bodies.push(body);
        self.static_levels.push(guard.low);
    }
}
```

Литерала `0.1` вне `ramp_guards` остаться не должно (`grep -n "0\.1" packages/engine/core/src/map.rs`).

**Тесты** (`packages/engine/core/src/map.rs`, `mod tests`):

- существующие `ramp_guard_*` и `wide_ramp_is_fenced_as_one_block` обязаны
  остаться зелёными без правок — это доказательство, что перенос точный;
- новый `ramp_guards_match_the_created_colliders`: на `wide_guard_config()`
  число `RampGuard` совпадает с приростом `static_body_count()`, а центры и
  полуразмеры — с трансформами вставленных коллайдеров;
- новый `ramp_guards_of_a_flat_map_are_empty`.

## 1.2 Д5 — NaN на вырожденном OBB со спекулятивным контактом

**Проблема.** `collision.rs:123-145`, `contact_point` делит на
`tolerance = CONTACT_MANIFOLD_RATIO * (a.half_w + a.half_h)`
(`collision.rs:172`). У тела с нулевыми полуразмерами это ноль: `best - proj`
тоже ноль, `0.0 / 0.0` даёт `NaN`, `NaN > 0.0` ложно, поэтому `sum_weight`
остаётся нулём и наружу уходит `cx/cy = NaN`. Дальше NaN расползается по
скоростям реплики без единой строки в консоли.

Раньше путь был закрыт: SAT отсекал такое тело на `overlap <= 0`
(тест `degenerate_box_is_a_miss`, `collision.rs:834`). С предсказанием
условие стало `overlap <= -prediction` (`collision.rs:310`) и вырожденный
бокс проходит насквозь.

**Решение.** Ранний выход в `obb_vs_obb_within` (перед вызовом
`contact_point`) и в `obb_manifold`:

```rust
let tolerance = CONTACT_MANIFOLD_RATIO * (a.half_w + a.half_h);

// вырожденный бокс: допуск нулевой, точка контакта выродилась бы в NaN и
// молча разошлась бы по скоростям реплики
if tolerance <= f32::EPSILON {
    return None;
}
```

В `obb_manifold` проверка ставится сразу после `separating_axis` — оба
пути отката (`clipped.is_none()`, `len == 0`) зовут `obb_vs_obb_within`,
поэтому одной проверки в начале достаточно, но она обязана быть и там, и
там: `obb_manifold` умеет вернуть точку из клиппинга, не заходя в
`contact_point`.

**Тест** (`collision.rs`, `mod tests`): расширить `degenerate_box_is_a_miss`
вариантом с `prediction`:

```rust
assert!(obb_vs_obb_within(&degenerate, &b, 6.0).is_none());
assert!(obb_manifold(&degenerate, &b, 6.0).is_none());
```

## 1.3 Д4а — сбор контактов без аллокации

**Проблема.** `collect_block_contacts` (`collision.rs:479`) возвращает
`Vec<BlockContact>` — по вектору на каждый уровень каждого тела каждый шаг
симуляции реплики (120 Гц плюс каждый шаг реплея реконсиляции).

**Решение** (аддитивное, не ломающее):

```rust
/// То же, что `collect_block_contacts`, но пишет в переданный буфер:
/// клиентский шаг зовёт сбор по несколько раз за кадр, и вектор на каждый
/// вызов — чистая нагрузка на аллокатор. Буфер НЕ очищается — вызывающий
/// решает, копит он контакты шага или начинает заново.
pub fn collect_block_contacts_into(
    obb: &Box2,
    blocks: &[StaticBlock],
    prediction: f32,
    out: &mut Vec<BlockContact>,
)
```

`collect_block_contacts` становится обёрткой: создаёт `Vec::new()`, зовёт
`_into`, возвращает. Тесты `block_contact_matches_the_host_collider_on_the_long_wall`,
`block_and_tile_collection_differ_on_a_long_wall`,
`block_collection_sees_the_wall_through_the_prediction_gap` остаются как
есть — они проверяют обёртку. Один новый тест: `_into` дописывает в
непустой буфер, не затирая его.

## 1.4 Д13 — ограничение `collect_tile_contacts` зафиксировать

**Проблема.** `collision.rs:418` остался на одноточечном `obb_vs_obb` без
предсказания, тогда как `collect_block_contacts` перешёл на манифольд с
зазором. Игра, собирающая контакты потайлово, получает ровно ту
рассинхронизацию с хостовым `soft_ccd_prediction`, ради которой всё
делалось; в тесте `block_and_tile_collection_differ_on_a_long_wall`
(`collision.rs:571`) это зафиксировано как ожидаемое поведение.

**Решение (принято): поведение не менять, ограничение задокументировать.**
Потребителя, которому нужно предсказание по тайлам, сегодня нет, а новый
неиспользуемый API хуже честной докстроки. Дописать в докстроку
`collect_tile_contacts`:

```
/// ВНИМАНИЕ: предсказания (`soft_ccd_prediction` хоста) этот сбор НЕ
/// поддерживает — контакт рождается только по факту перекрытия, и на
/// быстром касательном ударе он разойдётся с сервером. Слоёная карта
/// обязана собирать стены через `collect_block_contacts`: он видит ту же
/// склеенную геометрию, по которой хост поставил коллайдеры.
```

и ту же оговорку — в `docs/en/core.md` и `docs/ru/core.md`, в раздел про
клиентские контакты.

## 1.5 Д14 — лишний клон прогонов в нав-графе

**Проблема.** `packages/engine/core/src/nav/navigation.rs:269`:

```rust
for run in levels.runs().to_vec() {
```

Клон всего вектора прогонов на каждой загрузке карты. `levels: &MapLevels`
— отдельный параметр, не связанный с `&mut self`, поэтому конфликта
заимствований, ради которого клон появился, скорее всего нет.

**Решение.** Заменить на `for run in levels.runs()` и собрать. Если
borrow-checker всё же возражает (например, из-за замыкания `point`,
захватывающего `run` по ссылке), — перебирать по индексам:

```rust
for index in 0..levels.runs().len() {
    let run = levels.runs()[index].clone();
    ...
}
```

Клонируется одна запись вместо всего вектора. Путь не горячий (загрузка
карты), поэтому правка косметическая — но и цена её нулевая.
Тесты нав-графа (`mod tests` в том же файле, `ramp_*`) обязаны остаться
зелёными без изменений.

## 1.6 Проверка и выпуск этапа 1

```bash
cd /Users/dmitry/Sites/my/vimp
cargo test --workspace && cargo clippy --workspace && npx eslint . && npx vitest run
```

- `packages/engine/core/CHANGELOG.md`, `## [Unreleased]`:
  - `### Added` — `map::ramp_guards` / `map::RampGuard`,
    `client::collision::collect_block_contacts_into`;
  - `### Fixed` — NaN точки контакта на вырожденном OBB при
    `prediction > 0`.
- `docs/en/core.md` + `docs/ru/core.md` (симметрично):
  - почему геометрия стражей живёт в крейте и кто её зовёт;
  - ограничение `collect_tile_contacts` (см. 1.4).
- Релиз: `npm run release -- --only=crate` (минор — новый публичный API).
  Preflight не пропускает `[patch.crates-io]` в выбранной игре, поэтому
  крейт публикуется ПЕРВЫМ проходом, отдельно от игр.
- Если менялась JS-часть движка (в этом этапе — нет), отдельным проходом
  выпускается `vimp-engine`.

Критерий этапа: все команды зелёные, крейт опубликован, версия записана
сюда.

### Результат ✅

- `cargo test --workspace` — 197 тестов зелёные; `cargo clippy --workspace`
  — без новых предупреждений (единственное, `needless_range_loop` в
  `map.rs` во флуд-заливке, было до этапа); `npx eslint .` чисто;
  `npx vitest run` — 185 файлов / 2382 теста зелёные.
- **Опубликован `vimp-engine-core 0.16.0`** (2026-09-11, релиз выполнен
  пользователем вручную). Этап 2 берёт эту версию в
  `T core/Cargo.toml`.

### Отклонения от плана

- **1.5.** Borrow-checker возражений не имеет: вместо перебора по индексам
  с клоном одной записи прошёл прямой `for run in levels.runs()` — клона
  нет вовсе.
- **1.1.** `place` внутри `ramp_guards` сразу собирает `RampGuard`, а не
  кортеж `(Vector, f32, f32, u8)`: структура и есть результат функции,
  промежуточный кортеж был бы лишним. Числа не меняются — существующие
  `ramp_guard_*` и `wide_ramp_is_fenced_as_one_block` зелёные без правок.
- **1.2.** Проверка вырожденного бокса в `obb_manifold` стоит сразу после
  `separating_axis`, как и предписано; в `obb_vs_obb_within` она вынесена
  в общий `tolerance`, который дальше передаётся в `contact_point`.

