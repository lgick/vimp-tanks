# План «Глубокое перекрытие: реплика растаскивает рывком»

> Найдено при приёмке правила срыва по габариту корпуса
> (`core/src/level.rs`, `has_support`). Само правило ни при чём — оно лишь
> впервые завело фикстуру в этот случай.
>
> **E** = `/Users/dmitry/Sites/my/vimp` (крейт `vimp-engine-core`),
> **T** = `/Users/dmitry/Sites/my/vimp-tanks`. Коммитов не делать.

## Симптом

`npm run sim:scenarios` → `tests/scenarios/terraces_crate.json`,
контракт `predictionDrift`: `sock-p2`, |Δx| = 3.81 при пороге 3, три кадра
из 173 (serverTime 2733…2800, тик ≈ 328…336). Остальные 11 сценариев
зелёные, пороги не трогались.

## Диагноз

1. Танк сталкивает ящик в разрыв перил верхней площадки `terraces`
   (x 40..42) и сам доезжает до кромки. В падении тело несёт одну
   `STATIC_LEVEL_GROUP` (`level::LevelState::collision_mask`), то есть тел
   не видит — и приземляется ВНУТРЬ упавшего ящика. Так было всегда; с
   правилом срыва по габариту танк висит на кромке дольше, падает позже и
   теперь ложится точно на ящик.
2. Дальше стороны расходятся: хост (Rapier) растаскивает глубокое
   перекрытие постепенно — за тик тела сдвигаются на доли юнита; реплика
   (солвер движка, `E packages/engine/core/src/client/collision.rs` и его
   вызов в `T core/src/client/predictor.rs::resolve_world`) выталкивает за
   один шаг: в дампах `.debug/scene-332.json` предсказанный ящик прыгает
   с 524.3 на 528.9 по x, а танк — на 3.8 в другую сторону. Кадры это
   потом чинят, но три кадра порог пробит.

## Что проверить и сделать ✅ выполнен

1. Убедиться, что предел позиционной коррекции за шаг в солвере реплики
   действительно отсутствует (у Rapier это `erp`/`max_penetration_correction`
   и slop).
2. Ограничить коррекцию за шаг тем же законом, что у Rapier, в
   `E .../client/collision.rs` — ОДНА формула на обе стороны, как и с
   уровнями. Крейту поднять версию; **публикует пользователь вручную**.
3. Прогнать `cargo test --workspace` и `cargo clippy --workspace` в E,
   затем в T полный набор: `core:build`, `core:test`, `eslint`, `npm test`,
   `build`, `sim:scenarios` — 12/12 без правки порогов.
4. Документы: `E docs/en|ru/` (страница про клиентскую физику) и
   `E CHANGELOG.md`; в T — только если поменяется контракт.

## Заметка на будущее

Отдельный вопрос, который этот случай подсветил: падающий танк не видит
тел и может лечь внутрь ящика. Если решим это менять — правило «во что
упираться в полёте» живёт в `T core/src/level.rs`
(`LevelState::collision_mask`, ветка `Falling`).

## Результат ✅ выполнен

1. Предела действительно не было: `client::rigid_body::separate_bodies`
   разводил тела на ВСЮ глубину за шаг, без допуска и без потолка.
2. `E packages/engine/core/src/client/rigid_body.rs`: добавлены
   `contact_erp(dt)`, `penetration_correction(depth, dt)`,
   `ALLOWED_LINEAR_ERROR`, `MAX_CORRECTIVE_VELOCITY` — закон контактной
   пружины Rapier `min(erp(dt) · (depth − slop), max_corrective_velocity · dt)`
   на параметрах хоста по умолчанию (30 Гц, ζ = 5, slop 0.001,
   10 юнитов/с, `length_unit = 1`). `separate_bodies` получил `dt`
   (ломающая правка ABI) и двигает пару ровно на эту величину.
   Версия крейта → `0.18.0`, `versions.generated.json` обновлён.
   **Публикует пользователь вручную.**
3. `T core/src/client/predictor.rs::resolve_world` передаёт `dt` в развод;
   `T core/Cargo.toml` → `vimp-engine-core = "0.18.0"`.
4. Прогоны. E: `cargo test --workspace` 202, `cargo clippy --workspace`
   без новых предупреждений (старое `needless_range_loop` в `map.rs` —
   до плана), `eslint`, `vitest` 2382. T: `core:build`, `core:test`
   251 + 46, `eslint`, `npm test` 330, `build`, `vimp-contract --strict`,
   `sim:scenarios` — **12/12**, `terraces_crate` зелёный, пороги
   `divergence.thresholds` не тронуты.
5. Документы: `E docs/en|ru/core.md` (четвёртая деталь реплики —
   дозированная позиционная коррекция), `E packages/engine/core/CHANGELOG.md`
   (`0.18.0`, ⚠️ Breaking + Migration; заодно датирован выпущенный
   `0.17.0`). В T контракт не менялся, но поведение предсказания — да,
   поэтому запись в `T CHANGELOG.md` под `## [Unreleased] → Fixed`.

### Осталось за пользователем

- `[patch.crates-io]` в корневом `T Cargo.toml` ОСТАВЛЕН: без него танки не
  соберутся, пока `vimp-engine-core 0.18.0` не опубликован (0.17.0 уже на
  crates.io). Снять сразу после публикации и перепрогнать `cargo fetch` +
  полный набор.
