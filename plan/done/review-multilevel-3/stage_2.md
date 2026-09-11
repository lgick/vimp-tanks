# Этап 2. Танки: ядро реплики ✅ выполнен

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

Файлы: `core/src/client/predictor.rs`, `core/src/client/predicted_set.rs`,
`core/src/level.rs`, `core/Cargo.toml`, `CHANGELOG.md`.

Перед началом: `core/Cargo.toml` → `vimp-engine-core = "<версия из этапа 1>"`,
`[patch.crates-io]` пока оставить (снимается на этапе 6),
`npm run core:build`.

## 2.1 Д2 — от стражей рампы освобождается только свой танк

**Проблема (реальный дефект).** `core/src/client/predictor.rs:1062-1068`:

```rust
for index in 0..movable {
    // страж существует только для тел уровня, с которого
    // прогон начинается, и законно поднимающийся проходит
    // его насквозь (`map::body_filter`)
    if !masks[index].intersects(level_group(low)) || (index == 0 && climbing) {
        continue;
    }
```

`climbing` — это `self.level_state.on_ramp()` (`predictor.rs:1012`), то есть
состояние СВОЕГО танка, а `index == 0` — он же. Хост освобождает ЛЮБОЕ
тело, законно едущее по прогону: `map::body_filter(mask, on_ramp)`
(E `map.rs:652-654`) снимает бит `RAMP_GUARD_GROUP` из фильтра, и танки
получают этот фильтр в `core/src/tank.rs:561-563`.

Хуже: предсказанные тела и не могут знать, что они на прогоне.
`PredictedBody::collision_mask` (`core/src/client/predicted_set.rs:191-193`)
считает маску через `body_collision_mask(&BodyLevelState { level, z,
falling })`, а в движковой `BodyLevelState` фазы рампы нет вовсе
(E `map.rs:1274-1282`).

**Следствие.** Чужой танк, законно поднимающийся по прогону, у наблюдателя
упирается в борт или в верхний торец, которых на хосте для него не
существует: рывок и залипание на горке — ровно там, где рампа и должна
работать. Воспроизведение: `npm run dev`, карта `terraces`, два игрока,
один смотрит, как второй едет вверх по `rampSteep`.

**Решение.**

1. Провести признак «стою на прогоне» в предсказанное тело. Источник —
   КАРТА под позицией тела, а не его состояние: тем же приёмом этап 4
   плана `prediction-drift` чинил замороженный газ
   (`predictor.rs:573`, `levels.ramp_at(x, y)`). Признак кладётся в
   `PredictedBody` рядом с `level`/`z`/`falling`:

```rust
// core/src/client/predicted_set.rs, struct PredictedBody
/// Тело стоит на клетке прогона рампы: стражи прогона его не держат —
/// то же правило, что у хоста (`map::body_filter`). Считается по КАРТЕ
/// под позицией тела, а не по его состоянию: `BodyLevelState` фазы
/// рампы не знает, а хост пропускает тело по факту клетки.
pub on_ramp: bool,
```

   Заполняется там же, где `set_level_state` / шаг правил уровня тела:
   после `step_body_level` спросить `levels.ramp_at(body.x, body.y)`.
   Если у `PredictedBodies` нет доступа к `MapLevels` — передать его
   параметром в `capture`/шаг (в `Predictor::resolve_world` `self.levels`
   уже под рукой, `predictor.rs:961`).

2. Заменить проверку индекса общим правилом:

```rust
let on_ramp = |index: usize| {
    if index == 0 {
        self.level_state.on_ramp()
    } else {
        bodies[index - 1].on_ramp
    }
};

...

if !masks[index].intersects(level_group(low)) || on_ramp(index) {
    continue;
}
```

   Локальная переменная `climbing` (`predictor.rs:1012`) больше не нужна.

**Тесты** (`core/src/client/predictor.rs`, `mod tests`, рядом с
`replica_climbs_the_ramp:1909` и `replica_drives_onto_a_wide_ramp:1859`):

- `a_predicted_body_on_the_run_passes_the_guard` — предсказанное тело в
  клетке прогона проезжает верхний торец;
- `a_predicted_body_off_the_run_is_held_by_the_side_guard` — тело того же
  уровня рядом с прогоном в борт упирается (защита от «сняли стражей всем»).

## 2.2 Д1б + Д3 — стражи считаются один раз на карту

**Проблема.** `predictor.rs:1007-1100` каждый шаг заново собирает
`Vec<RampRun>` с клонированием и `find` по нему (O(n²)), затем считает три
бокса на блок. Данные зависят только от карты, а шаг — 120 Гц плюс каждый
шаг реплея реконсиляции.

**Решение.**

1. В `Predictor` добавить поле:

```rust
/// Стражи прогонов рампы текущей карты: геометрия зависит только от неё,
/// а шаг зовётся 120 раз в секунду плюс на каждом шаге реплея. Считается
/// движком (`map::ramp_guards`) — формула одна на хост и на реплику.
guards: Vec<vimp_engine_core::map::RampGuard>,
```

2. В `Predictor::set_map` (`predictor.rs:351`) заполнять его:
   `self.guards = vimp_engine_core::map::ramp_guards(&levels);`
   (и очищать в `reset`, если там сбрасывается карта).

3. Блок `predictor.rs:1007-1100` сжимается до:

```rust
for guard in &self.guards {
    let box2 = Box2 {
        x: guard.x,
        y: guard.y,
        angle: 0.0,
        half_w: guard.half_w,
        half_h: guard.half_h,
    };

    for index in 0..movable {
        if !masks[index].intersects(level_group(guard.low)) || on_ramp(index) {
            continue;
        }

        let obb = /* как сейчас */;
        let Some(manifold) = obb_manifold(&obb, &box2, prediction) else {
            continue;
        };
        let partner = sim.len();

        sim.push(static_body(box2.x, box2.y));
        geometry.push((0.0, 0.0));
        surfaces.push(MAP_SURFACE);
        push_manifold(/* ... */);
    }
}
```

   Импорт `RampRun` из `predictor.rs:29` уходит, если больше не нужен.

**Критерий:** ни один из 12 сценариев не сдвинулся ни на бит — геометрия
обязана получиться той же. Если сдвинулась, значит копия и оригинал уже
расходились: зафиксировать разницу в этом пункте и разбираться, а не
подгонять.

## 2.3 Д4б — буферы шага

**Проблема.** `resolve_world` (`predictor.rs:877-1185`) на каждый шаг
создаёт `sim`, `geometry`, `surfaces`, `bodies`, `masks`, `contacts`,
`separations` (`predictor.rs:906-954`) плюс `Vec` из
`collect_block_contacts` на каждый уровень каждого тела
(`predictor.rs:986-987`).

**Решение.** Держать буферы полями `Predictor`, брать их на время шага
через `std::mem::take`, чистить `clear()` и возвращать в конце:

```rust
// буферы шага: `resolve_world` зовётся 120 раз в секунду плюс на каждом
// шаге реплея, и вектор на каждый вызов — чистая нагрузка на аллокатор.
// Берутся через `mem::take`, потому что шаг одновременно держит `&mut
// self.sets`
sim: Vec<Body>,
geometry: Vec<(f32, f32)>,
surfaces: Vec<Surface>,
masks: Vec<Group>,
contacts: Vec<(usize, usize, Contact, Surface, ContactImpulses)>,
separations: Vec<(usize, usize, Contact)>,
block_hits: Vec<BlockContact>,
```

`collect_block_contacts` → `collect_block_contacts_into(&obb, blocks,
prediction, &mut block_hits)` с `block_hits.clear()` перед каждым вызовом.

Локальный `bodies: Vec<&mut PredictedBody>` полем сделать нельзя (он несёт
заимствования) — он остаётся локальным.

**Критерий:** поведение бит-в-бит. Паритет-тесты `mod parity`
(`predictor.rs:2472+`), 12 сценариев и `npm run core:test` не сдвинулись.
Это чисто механическая правка; если числа поехали — она сделана неверно.

## 2.4 Д10 — устаревший комментарий про единицы уклона

**Проблема.** `core/src/level.rs:51-53`:

```rust
/// Вектор уклона: уровней на мировую единицу, `(0, 0)` вне рампы.
/// Заполняется из `RampSample { dir, slope }` и только при `climbing`.
slope_vec: [f32; 2],
```

После введения `levelHeight` уклон безразмерный:
`slope: rise * self.level_height / span` (E `map.rs:1182`). Единица
«уровней на пиксель» — это ровно та корневая причина, из-за которой в
прошлой итерации промахнулись все константы подъёма (`climbGravity`,
`climbMaxSpeedFactor`, порог пыли). Комментарий, описывающий её по-старому,
вернёт следующего читателя туда же.

**Решение.** Поправить комментарий:

```rust
/// Вектор уклона: БЕЗРАЗМЕРНЫЙ тангенс подъёма по осям мира
/// (`rise * levelHeight / span`, см. `RampSample::slope` в движке),
/// `(0, 0)` вне рампы. Единица важна: до введения `levelHeight` уклон
/// мерился «уровнями на пиксель» и все константы подъёма промахивались
/// на два порядка.
```

Проверить соседей: `LevelState::grade` (`level.rs:122-127`) и
`docs/en|ru/core.md` — там та же величина описывается словами.

## Отклонение от плана

`on_ramp` заполняется не в подсистеме (после `step_body_level`), а в
`Predictor::resolve_world` — там, где тела собираются в шаг. Причина:
`step_body_level` зовёт только `MapDynamics` (тела карты), а `RemoteTanks`
берут уровень из строки кадра и шага правил уровня не делают вовсе, — то
есть ровно чужие танки, ради которых пункт Д2 и заведён, признака бы не
получили. В `resolve_world` карта (`self.levels`) под рукой, и правило одно
на все подсистемы. Поле в `PredictedBody` — как в плане.

## 2.5 Проверка этапа 2

```bash
cd /Users/dmitry/Sites/my/vimp-tanks
npm run core:build && npm run core:test && npx eslint . && npm test
npm run build && npm run sim:scenarios     # 12/12
```

`CHANGELOG.md`, `## [Unreleased]`, `### Fixed`: «стражи прогона рампы
держали чужие танки, которых хост пропускает».

**Результат.** `npm run core:test` — 240 + 45 зелёных (в т.ч. два новых
теста стражей), `npx eslint .` чисто, `npm test` — 303 зелёных,
`npm run sim:scenarios` — 12/12, пороги `divergence.thresholds` не тронуты.
Критерий 2.2 (бит-в-бит) проверен прямым сравнением: `terraces_climb` до и
после правки даёт тот же отпечаток дрейфа
`[2.2314, 0, 0, 6.3813, 0, 0, 0, 0.0208]`, 198 реконсиляций.
`core/Cargo.toml` → `vimp-engine-core = "0.16.0"`; `[patch.crates-io]`
остаётся до этапа 6.
