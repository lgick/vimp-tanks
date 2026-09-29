# План: исправления по код-ревью задачи bots-ai

> **Контекст.** Задача `plan/bots-ai/` (новый ИИ ботов) закоммичена: игра — `3a7b695`, движок —
> `93e7ba9c`, `1e50c435` (+ релизные `0537ae16`, `8f9e2f60`, `64f4c946`, `712e9102`, `e1c789b6`, `e501e7a6`).
> Движок уже выпущен: `vimp-engine-core` **0.23.1**, `vimp-engine` **0.35.6**. Выпуск игры через
> `npm run release` (из репо движка) упал на шаге `npm run sim:scenarios`. Ниже — причина, остальные находки
> ревью и пошаговые исправления.
>
> **Этот план самодостаточен**: исполнителю не нужен другой контекст, кроме файлов, на которые он ссылается.
> Номера строк даны по текущему состоянию (игра `3a7b695` + незакоммиченные правки релиза); если строки
> сдвинулись, место ищется по фрагменту кода (`grep -n`).

## Репозитории и правила

| Обозначение | Путь                                | Что публикуется                              |
| ----------- | ----------------------------------- | -------------------------------------------- |
| **T** (игра)  | `/Users/dmitry/Sites/my/vimp-tanks` | npm `@vimp-games/tanks`, ИИ в `core/src/bots/` |
| **E** (движок) | `/Users/dmitry/Sites/my/vimp`       | крейт `vimp-engine-core`, npm `vimp-engine`    |

- **Коммиты не делать.** Всё остаётся в рабочем дереве; коммитит и выпускает пользователь.
  **`npm run release` исполнитель не запускает** — это публикация, её делает пользователь.
- Правила репо T: `CLAUDE.md` в корне (доки `docs/en` + зеркало `docs/ru` в той же правке; `CHANGELOG.md` —
  английский, `## [Unreleased]`; тесты, рефакторинг и `docs/` записями журнала не являются).
- Комментарии в коде — на русском, как в окружающем коде. Rust: `rustfmt` только для новых файлов, в
  существующих держать окружающий стиль. JSON/MD/JS — Prettier по `~/.prettierrc.mjs`
  (`npx prettier --write <файл>`), но только для новых файлов и новых строк: существующие доки Prettier
  целиком не проходят, их не переформатировать.
- Тихие команды: `cargo test --workspace -q`, `npm test -- --silent`, `npx eslint . --quiet`.
- Выполненный этап помечается «✅ выполнен» в его заголовке. Когда выполнены все этапы, файл переносится в
  `plan/done/` (`git mv`, если он в git, иначе `mv`).

**Рекомендуемый порядок:** этап 1 → этап 2 → повторный `npm run release` (пользователем) → этап 3. Этап 1
обязателен для релиза. Этап 2 правит логику, которая иначе уйдёт в релиз с ошибками. Этап 3 — чистка, её можно
делать после релиза.

## Итоги ревью

| #   | Важность | Где | Суть | Критерий |
| --- | -------- | --- | ---- | -------- |
| 1   | 🔴 блокер релиза | `tests/scenarios/round.json` | `predictionDrift` падает: новый бот находит игрока и попадает в него, импульс hitscan клиент не предсказывает | работоспособность |
| 2   | 🔴 релиз | `.cargo/config.toml`, `Cargo.lock` | локальный `[patch]` движка не снят; `Cargo.lock` закоммичен в `3a7b695` без `source`/`checksum` крейта | работоспособность, безопасность поставки |
| 3   | 🟠 | `CHANGELOG.md` | «Requires `vimp-engine-core` 0.23.0 … `vimp-engine` 0.35.5» — на деле нужны 0.23.1 и 0.35.6 | документированность |
| 4   | 🟠 логика | `brain.rs::pick_retreat_point` | при исчерпанном бюджете поиска сравниваются несравнимые числа: стоимость маршрута и эвристика (бывает отрицательной) | работоспособность |
| 5   | 🟠 логика | `brain.rs::wants_bomb` | при `friendlyFire` бот кладёт бомбу, не глядя на союзника рядом — взрыв ранит своего | работоспособность |
| 6   | 🟡 | `tanks.rs` `ai_clock` | часы досок команд (`f32`) не сбрасываются при смене карты: на долгоживущем хосте теряют точность и останавливаются, роли и фокус замерзают | масштабируемость |
| 7   | 🟡 (по желанию) | `tanks.rs::on_ai_tick` | общий бюджет поисков маршрута всегда первыми берут одни и те же боты | масштабируемость |
| 8   | 🟡 (по желанию) | `perception.rs::update_damage` | урон от падения и своей бомбы приписывается ближайшему врагу | работоспособность |
| 9   | 🟢 | `tanks.rs`, `navigator.rs`, `geom.rs`, `team.rs` | мёртвый код под `#[allow(dead_code)]`, устаревшие комментарии | поддерживаемость, читаемость |
| 10  | 🟢 | `config.rs` ↔ `src/config/game.js` | таблица пресетов продублирована, синхронность ничем не проверяется | DRY, тестируемость |
| 11  | 🟢 | `brain.rs`, `navigator.rs` | повторяющиеся фрагменты: `max_speed`, разворот корпуса на месте, сборка `PathQuery` | DRY |
| 12  | 🟢 процесс | отчёты этапов 4–7 | вывод «`round.json` падает и на HEAD» неверен: сравнение делалось без пересборки `dist/` и `core/pkg-*` | стандартизация процесса |

Что проверено в ходе ревью и в правке не нуждается: A\* на двоичной куче и эвристика (стоимость ребра ≥ его
длины, эвристика состоятельна), `find_route`/`PathQuery`/`nearest_node_on`/`has_clear_corridor_on` в движке,
детерминизм (случайность только через `game.rng`, обход в порядке `id`), сериализация мозга
(`#[serde(default)]` у новых полей, старый дамп читается), валидация `coreParams.bots`, линия огня.

---

## Этап 1. Разблокировать релиз игры ✅ выполнен

> **Итог выполнения.** 1.2–1.4, 1.6, 1.7 сделаны; 1.5 не делался — решение пользователя (только игра).
> Отступления: (а) `cargo update -p vimp-engine-core --precise 0.23.1` сразу после снятия patch падает с
> «did not match any packages» — в закоммиченном локе крейт записан как path-пакет; лок перерешён
> `cargo fetch` (изменилась только запись крейта: 0.23.1 + `source`/`checksum`), после этого команда
> релиз-скрипта снова проходит; (б) по п. 7.6.6 плана bots-ai обновлён абзац версий в
> `docs/{en,ru}/getting-started.md` (было 0.12.0 / 0.31.0); (в) `round_respawn.json` отформатирован Prettier.

### 1.1. Причина падения `round.json`

Проверено при ревью:

- На ревизии `bc6188e` (релиз 0.22.12, до bots-ai) `round.json` проходит: 294 реконсиляции, **0** превышений,
  max |Δ| по всем компонентам = 0. Ревизия собиралась в отдельном worktree с полным `core:build` + `build`
  против того же `node_modules` (`vimp-engine` 0.35.6).
- На текущем коде: 2 превышения, `serverTime` 14000 и 14400 мс, `replayed 0 input(s)` (игрок ничего не жмёт),
  у игрока `vx` −293 и −32 при предсказанных 0 и 5.3.
- В сценарии бот (`/bot 1 team2`) и игрок `p1` на `pool mini`. Старый бот не знал о враге дальше ~612 ед. и за
  15 с до игрока не доезжал. Новый знает всех врагов по «радару», находит `p1` и к 14-й секунде попадает в него.
  Попадание hitscan даёт импульс (`TanksSim::process_hitscan`, `core/src/tanks.rs:1895–1896`,
  `apply_impulse_at_point`). В кадре на конце прогона виден трассер `w1` от бота (≈266, 429) к игроку
  (≈53, 308).
- Документация движка (`vimp/docs/en/debugging.md`, раздел «Prediction divergence detector») прямо называет
  этот случай: столкновения, импульсы взрывов и телепорты клиентская реплика не моделирует; такие события
  держат вне сценария, который следит за дрейфом, или выключают детектор (`"divergence": null`). Та же политика
  записана в `docs/en/getting-started.md` игры: «разделить сценарии лучше, чем ослабить порог».

Все остальные шаги релиза зелёные (проверено: `core:build`, `build`, `eslint`, `npm test` — 1128 тестов,
`cargo test` — 490 + 123, `npm run sim`).

### 1.2. Исправление сценариев

Разделить сценарий на два: `round.json` остаётся про ботов и жизненный цикл раунда, дрейф отключается; новый
`round_respawn.json` сохраняет покрытие дрейфа через конец раунда и респаун — без ботов, двумя игроками.

1. `tests/scenarios/round.json`: заменить строку
   ```json
   "divergence": { "thresholds": [3, 3, 0.06, 25, 25, 1.5, 0.15, 0.06], "angles": [2] },
   ```
   на
   ```json
   "divergence": null,
   ```
   Больше в файле ничего не менять.

2. Создать `tests/scenarios/round_respawn.json`:
   ```json
   {
     "version": 1,
     "seed": 4242,
     "map": "pool mini",
     "room": { "friendlyFire": true },
     "participants": [
       { "id": "p1", "name": "P1", "model": "m1" },
       { "id": "p2", "name": "P2", "model": "m1" }
     ],
     "timeline": [
       { "tick": 0, "op": "join", "who": "p1", "team": "team1" },
       { "tick": 0, "op": "join", "who": "p2", "team": "team2" },
       { "tick": 200, "op": "key", "who": "p1", "action": "down", "name": "nextWeapon" },
       { "tick": 240, "op": "key", "who": "p1", "action": "down", "name": "fire" },
       { "tick": 290, "op": "key", "who": "p1", "action": "down", "name": "fire" },
       { "tick": 340, "op": "key", "who": "p1", "action": "down", "name": "fire" },
       { "tick": 390, "op": "key", "who": "p1", "action": "down", "name": "fire" },
       { "tick": 440, "op": "key", "who": "p1", "action": "down", "name": "fire" },
       { "tick": 490, "op": "key", "who": "p1", "action": "down", "name": "fire" },
       { "tick": 540, "op": "key", "who": "p1", "action": "down", "name": "fire" },
       { "tick": 590, "op": "key", "who": "p1", "action": "down", "name": "fire" }
     ],
     "unusedSnapshotKeys": ["c1", "c2", "w1"],
     "divergence": { "thresholds": [3, 3, 0.06, 25, 25, 1.5, 0.15, 0.06], "angles": [2] },
     "ticks": 1800,
     "dumpTicks": [600, 1800]
   }
   ```
   Это прежний `round.json` без команды `/bot` и со вторым игроком в `team2`, чтобы раунд завершился
   победой. `w1` в `unusedSnapshotKeys`, потому что без бота из пушки никто не стреляет. Черновик сценария
   прогнан при ревью: `predictionDrift` ✅ (296 + 446 реконсиляций, max |Δ| = 0), `roundLifecycle` ✅.
   Единственным замечанием было `snapshotKeysUsed` по `w1`, его закрывает `unusedSnapshotKeys`.
   `scripts/run-scenarios.js` подхватывает все `tests/scenarios/*.json`, регистрировать сценарий нигде не нужно.

3. Документация — таблица сценариев и абзац про `divergence: null`.

   `docs/en/getting-started.md` (таблица, строка `round.json`, ≈стр. 267):
   ```md
   | `round.json` | bots, friendly fire, death → round end → respawn (invariant 10); the drift detector is off (see below) |
   | `round_respawn.json` | two players, friendly fire: a self-bomb death → round end → respawn, with the `movement.json` drift thresholds — the prediction survives a round restart |
   ```
   В том же файле, в абзаце «Most of them run with the same drift thresholds…», сразу после предложения
   «`downtown_props.json` (a barrel blast), `bots_downtown.json` and `bots_terraces.json` set `null` for the same
   reason.» добавить:
   ```md
   So does `round.json`: the bot hunts the player by radar and hits him, and a hitscan hit pushes the tank
   with an authoritative-only impulse. The round restart keeps its drift coverage in `round_respawn.json`,
   the same run with a second player instead of the bot.
   ```

   `docs/ru/getting-started.md` (≈стр. 268 и абзац «Большинство идёт с теми же порогами дрейфа…»):
   ```md
   | `round.json` | боты, friendly fire, смерть → конец раунда → респаун (инвариант 10); детектор дрейфа выключен (см. ниже) |
   | `round_respawn.json` | двое игроков, friendly fire: смерть от своей бомбы → конец раунда → респаун, с порогами дрейфа `movement.json` — предсказание переживает перезапуск раунда |
   ```
   После предложения «`downtown_props.json` (взрыв бочки), `bots_downtown.json` и `bots_terraces.json` ставят
   `null` по той же причине.» добавить:
   ```md
   Так же и `round.json`: бот находит игрока по радару и попадает в него, а попадание hitscan толкает танк
   импульсом, который есть только у хоста. Покрытие дрейфа при перезапуске раунда осталось у `round_respawn.json` —
   того же прогона со вторым игроком вместо бота.
   ```

   `CHANGELOG.md` не трогать: сценарии — тесты.

### 1.3. Снять локальный patch движка и привести `Cargo.lock` в порядок

**Проблема.** В корне T лежит `.cargo/config.toml`:
```toml
# ВРЕМЕННО (plan/bots-ai): локальный движок до релиза vimp-engine-core. Снять в этапе 7.
[patch.crates-io]
vimp-engine-core = { path = "../vimp/packages/engine/core" }
```
Пока он есть:

- `npm run core:build` релиза собирает WASM из исходников чекаута движка, а не из опубликованного крейта.
  Незакоммиченная правка в `../vimp` уехала бы в npm.
- `Cargo.lock` держит `vimp-engine-core` без `source`/`checksum`. **Так он уже закоммичен в `3a7b695`**, вопреки
  прямому запрету плана bots-ai (у `bc6188e` строки `source`/`checksum` были). Релизный коммит скрипта
  (`gameCommitPaths` включает `Cargo.lock`) повторил бы это. CI без `--locked` молча перерешивает зависимость,
  поэтому ошибка не видна, но лок не пиннит контрольную сумму крейта.

**Шаги (репо T):**

1. Удалить `.cargo/config.toml` (и пустой каталог `.cargo/`).
2. Из `.git/info/exclude` удалить строку `.cargo/` (последняя строка файла; строки-примеры git не трогать).
3. Проверить, что `core/Cargo.toml` содержит `vimp-engine-core = "0.23.1"`. Это уже так после упавшего
   релиза. Версия **обязана** быть 0.23.1: в 0.23.0 нет фикса `find_route` (штрафные зоны на прямой
   видимости), и с ней падает `flanker_route_avoids_the_direct_line`.
4. `cargo update -p vimp-engine-core --precise 0.23.1` (нужна сеть).
5. Проверить `Cargo.lock`:
   ```bash
   grep -n -A4 'name = "vimp-engine-core"' Cargo.lock
   ```
   Должны появиться `source = "registry+https://github.com/rust-lang/crates.io-index"` и `checksum = "…"`.
6. `npm run core:build`: пересобрать `core/pkg-web` и `core/pkg-node` против крейта с crates.io.
7. Незакоммиченные правки упавшего релиза в `package.json`/`package-lock.json` (`vimp-engine` ^0.35.6) **не
   откатывать**: скрипт релиза ставит то же самое сам.

### 1.4. `CHANGELOG.md`

В `## [Unreleased]` → `### Changed` заменить пункт
```md
- Requires `vimp-engine-core` 0.23.0 (hull-aware bot routes); rebuilt against
  `vimp-engine` 0.35.5.
```
на
```md
- Requires `vimp-engine-core` 0.23.1 (hull-aware bot routes; route penalty
  zones are honoured on a direct line of sight); rebuilt against `vimp-engine`
  0.35.6.
```
Скрипт релиза в этот раздел ничего не добавит: его запись «Rebuilt against …» подставляется только в пустой
`[Unreleased]` (`scripts/release/steps.js`, `publishGame` → `dateChangelog({ fallback })`). Поэтому строку
нужно поправить руками.

### 1.5. (По согласованию с пользователем) Защита в релиз-скрипте движка — не делается (решение пользователя)

Репо **E**, `scripts/release/steps.js`, функция `publishGame` — перед `shell.check('npm run core:build' …)`.
Отказывать в релизе игры, если у неё активен локальный patch:

```js
// локальный [patch] крейта: WASM и Cargo.lock ушли бы в релиз от чекаута
// движка, а не от опубликованной версии (plan bots-ai-review, 1.3)
const cargoConfig = path.join(dir, '.cargo', 'config.toml');

if (
  (await exists(cargoConfig)) &&
  /^\s*\[patch\./m.test(await readFile(cargoConfig, 'utf8'))
) {
  throw new Error(
    `${game.name}: .cargo/config.toml содержит [patch] — снимите локальный patch перед релизом`,
  );
}
```

`exists` в файле уже есть. Импорт `readFile` проверить (`grep -n "import" scripts/release/steps.js`) и при
необходимости добавить из `node:fs/promises`. Тест добавить рядом с существующими тестами релиз-скрипта
(`grep -rln "publishGame" /Users/dmitry/Sites/my/vimp --include='*.test.js'`), по их образцу. Оформление и
журнал — по `CLAUDE.md` движка. **Не делать без явного «да» пользователя**: это другой репозиторий.

### 1.6. Учёт плана bots-ai

- `plan/bots-ai/stage_7.md`: заголовок `## 7.6.` пометить «✅ выполнен». Блок «⏳ Заблокирован» заменить
  строкой «Выполнено в `plan/bots-ai-review.md`, этап 1: крейт 0.23.1, patch снят, `Cargo.lock` с
  `checksum`».
- `plan/bots-ai/README.md`: этап 7 остаётся «⏳», пока пользователь не подтвердит ручную проверку 7.4.
  Архивирование 7.8 — только после этого.

### 1.7. Проверка этапа 1

```bash
cd /Users/dmitry/Sites/my/vimp-tanks
ls -a | grep -c '^.cargo$'          # 0
npm run core:build
npm run build
npx eslint . --quiet
npm test -- --silent
npm run core:test -- -q
npm run sim
npm run sim:scenarios               # все зелёные, round.json: predictionDrift ⏭️
npm run sim -- --scenario tests/scenarios/round_respawn.json --no-write   # predictionDrift ✅, roundLifecycle ✅
npm run check:pack
git status --short                  # нет .cargo/; Cargo.lock — только бамп крейта с source/checksum
```

Отчёт пользователю: что можно коммитить и перезапускать `npm run release` в репо E. Движок уже выпущен,
поэтому прогон должен выпустить только игру; в скрипте есть режим `--only=games`.

---

## Этап 2. Логические ошибки ИИ ✅ выполнен

> **Итог выполнения.** 2.1–2.3 и 2.5 сделаны; 2.4 сделан и откачен по правилу плана: с обходом по кругу
> (`ai_turn`, `rotate_left`) падает пороговый `bot_replans_are_bounded_terraces` (бот 2 — 216 перестроений за
> 120 с при пороге 180), остальные тесты зелёные. 2.5: поле `fell_at`, флаг `self_inflicted` в
> `Perception::update`/`update_damage` и в `update_mode`; тест `self_inflicted_damage_keeps_last_attacker`
> проверен красным на старой логике; доки `core.md`/`gameplay.md` в обоих языках; журнал не тронут (ИИ не выпущен).
> Новые тесты (`retreat_pick_waits_for_the_route_budget`, `retreat_pick_compares_only_routed_candidates`,
> `bomb_spares_an_ally_with_friendly_fire`, `clear_resets_team_boards`) проверены красными на старой логике.
> 2.3: `clear` зовётся при каждой смене карты (`RoundManager.createMap` → `this._game.clear()`), поэтому шаг 3
> (`f64`) не нужен. Журнал: дополнен пункт `### Fixed` про бомбу (релиза ещё не было). Доки: `core.md`
> (отход, условие бомбы, сброс досок) и `gameplay.md` (бомба) в обоих языках.

### 2.1. Точка отхода: несравнимые оценки при исчерпанном бюджете

**Где.** `core/src/bots/brain.rs`, `pick_retreat_point` (≈стр. 1225–1301).

**Проблема.** Кандидаты сортируются по эвристике `dist(pos, p) − 1.5 · (дистанция до ближайшей угрозы)`, затем
4 лучших оцениваются маршрутом (`Navigator::route_cost`). У `route_cost` три исхода: `None` — бюджет тика
кончился, `Some(None)` — маршрута нет, `Some(Some(cost))` — стоимость маршрута. Сейчас при `None` в оценку
кандидата подставляется **эвристика**:

```rust
let cost = match self.nav.route_cost(game, start, point, &params, &zones) {
    None => heuristic(point.pos),
    ...
```

Эвристика обычно отрицательна (кандидат в 100 ед. при угрозе в 300 ед. даёт 100 − 450 = −350). Стоимость
маршрута — это длина пути плюс штрафы зон угроз, она ≥ 100. Бюджет общий на всех ботов, всего 2 поиска за тик
(`BOT_ROUTE_BUDGET_PER_TICK`, `tanks.rs:178`), и в тот же тик его тратят `think` → `refresh_route_costs` этого
и других ботов. Поэтому неоценённые кандидаты (3-й и 4-й, **худшие** по эвристике) почти всегда выигрывают у
оценённых. Часто не оценён ни один. Итог: точка отхода выбирается без проверки достижимости и без обхода зон
угроз, что противоречит замыслу. Недостижимую точку `drive_retreat` не замечает: статус `Unreachable`
игнорируется. Бот стоит до перевыбора через `RETREAT_REPICK` = 1 с. Юнит-тесты это не ловят: у `Fixture`
бюджет `u32::MAX` (`test_support.rs:152`).

**Решение.**

1. Вынести ранжирование кандидатов в чистую функцию (заодно это улучшает тестируемость):
   ```rust
   /// Кандидаты отхода по эвристике «ближе к боту, дальше от угроз» (устойчиво:
   /// при равенстве — порядок сбора), не больше `RETREAT_ROUTED`.
   fn rank_retreat_candidates(
       pos: [f32; 2],
       threats: &[Contact],
       mut candidates: Vec<PathPoint>,
   ) -> Vec<PathPoint> { /* текущие heuristic + sort_by + truncate */ }
   ```
   Эвристику оставить отдельной свободной функцией `retreat_heuristic(pos, threats, p) -> f32`: она нужна и
   запасному выбору.
2. Запасную цепочку (дом дальше 1.5 тайла → точка в 6 тайлах прочь от ближайшей угрозы, ≈стр. 1277–1300)
   вынести в метод `fn fallback_retreat_point(&self, game: &BotView<'_>, me: &SelfState, threats: &[Contact]) -> Option<PathPoint>`
   без изменения логики.
3. Цикл оценки:
   ```rust
   let mut best: Option<(PathPoint, f32)> = None;
   // бюджет тика кончился раньше, чем оценены все кандидаты
   let mut starved = false;

   for point in rank_retreat_candidates(pos, &threats, candidates) {
       let cost = match self.nav.route_cost(game, start, point, &params, &zones) {
           // бюджета нет: стоимость маршрута и эвристика несравнимы
           // (эвристика бывает отрицательной) — хватит оценённых, иначе
           // выбор на следующем тике
           None => {
               starved = true;
               break;
           }
           // маршрута нет — не кандидат
           Some(None) => continue,
           Some(Some(cost)) => cost,
       };
       // … allies / seen / score — без изменений …
   }

   if starved && best.is_none() {
       // ни один кандидат не оценён: повтор на следующем тике
       // (`retreat_picked_at` не трогается), а пока — запасная точка, чтобы
       // бот не стоял
       if self.retreat_point.is_none() {
           self.retreat_point = self.fallback_retreat_point(game, me, &threats);
       }

       return;
   }

   self.retreat_picked_at = self.clock;
   self.retreat_point = best
       .map(|(point, _)| point)
       .or_else(|| self.fallback_retreat_point(game, me, &threats));
   ```
   Строку `self.retreat_picked_at = self.clock;` в начале функции **удалить**: время выбора ставится только
   после настоящей оценки.
4. `enter_mode` → ветка `BotMode::Retreat` (≈стр. 623–633): добавить
   `self.retreat_picked_at = self.clock - RETREAT_REPICK;`. Тогда первый выбор при входе в отход наступает
   сразу, даже если в прошлый раз точку выбирали меньше секунды назад и сейчас стоит запасная.

**Тесты** (`brain.rs`, модуль `tests`, по образцу `cover_point_is_hidden_from_threat`, ≈стр. 3686: та же
карта 20×20 со стенкой, бот на виду, угроза за стеной):

- `retreat_pick_waits_for_the_route_budget`: `fixture.route_budget = 0`, `brain.retreat_picked_at = -5.0`,
  вызвать `pick_retreat_point`. Проверить: `retreat_picked_at == -5.0` (выбор отложен), `retreat_point` равен
  запасной точке (`brain.fallback_retreat_point(...)`). Затем `fixture.route_budget = u32::MAX`, вызвать ещё раз:
  `retreat_picked_at == brain.clock`, точка скрыта от угрозы (`has_obstacle_between_on`, как в образце).
- `retreat_pick_compares_only_routed_candidates`: `fixture.route_budget = 1`. Ожидаемая точка — первый
  элемент `rank_retreat_candidates(pos, &threats, brain.retreat_candidates(&view, &me, &threats))`. После
  вызова `brain.retreat_point == Some(ожидаемая)`, `fixture.route_budget == 0`.

Оба теста красные на старом коде (первый — `retreat_picked_at` перезаписан, второй — выбран неоценённый
кандидат либо по эвристике). Проверить это до правки.

**Документация.** Если в `docs/en/core.md` и `docs/ru/core.md` описан выбор точки отхода
(`grep -n -i "retreat" docs/en/core.md docs/ru/core.md`), дописать в обоих языках: «кандидаты сравниваются
только по стоимости маршрута; если бюджет тика кончился раньше, чем оценён хотя бы один, выбор повторяется на
следующем тике, а бот пока едет к запасной точке (дом или прочь от угрозы)». **Журнал**: если этап 2 делается до
релиза, код не выпущен, записи не нужно. После релиза — `### Fixed`: «A retreating bot no longer picks an
unreachable or exposed retreat point when the per-tick route budget runs out.»

### 2.2. Бомба при огне по своим ранит союзника

**Где.** `core/src/bots/brain.rs`, `wants_bomb` (≈стр. 2561–2588).

**Проблема.** При `friendlyFire` взрыв ранит своих (`TanksSim::explode`, `tanks.rs:2116`:
`if friendly_fire || owner_team != team_id`). `wants_bomb` разрешает бомбу «драчуну» (`aggression > 0.8`) при
здоровье > урон + 10 и не смотрит, стоит ли рядом союзник. Общий фокус команды (этап 6) как раз сводит союзников
к одной цели вплотную, поэтому ситуация частая.

**Решение.**

1. Константа рядом с `BOMB_FF_AGGRESSION`:
   ```rust
   /// При огне по своим бомба не кладётся, если союзник своего уровня ближе
   /// стольких радиусов взрыва: за 300 мс до взрыва он успеет подъехать.
   const BOMB_ALLY_CLEARANCE: f32 = 1.5;
   ```
2. Свободная функция рядом с `bomb_weapon`:
   ```rust
   /// Союзник своего уровня ближе `BOMB_ALLY_CLEARANCE · radius`: своя бомба при
   /// огне по своим ранила бы его. Плита моста взрыв экранирует — чужой уровень
   /// не в счёт.
   fn ally_in_blast(game: &BotView<'_>, me: &SelfState, radius: f32) -> bool {
       let Some(team) = game.tank_team(me.id) else {
           return false;
       };
       let reach = BOMB_ALLY_CLEARANCE * radius;

       game.tanks.iter().any(|(&id, tank)| {
           id != me.id
               && tank.team_id == team
               && tank.is_alive()
               && game.tank_level(id) == me.level
               && game
                   .tank_position_rounded(id)
                   .is_some_and(|pos| dist_sq(pos, me.pos_array()) < reach * reach)
       })
   }
   ```
   `game.tanks`, а не `TeamBoard`: доска обновляется раз в 0.1 с, здесь нужна текущая позиция. `any` от порядка
   обхода не зависит, детерминизм сохраняется.
3. В `wants_bomb` финальное выражение заменить на:
   ```rust
   if game.friendly_fire && ally_in_blast(game, me, radius) {
       return false;
   }

   !game.friendly_fire
       || (self.profile.aggression > BOMB_FF_AGGRESSION
           && game.tank_health(me.id) > damage + 10.0)
   ```
   Проверка касается обоих случаев: и ближнего боя, и преследователя на отходе.

**Тест** (`brain.rs`, по образцу `bomb_only_at_close_range`, ≈стр. 3205, с хелпером `drops_bomb`):
`bomb_spares_an_ally_with_friendly_fire`. `fixture.friendly_fire = true`, бот `1` (команда 1) в (112, 112),
враг `2` (команда 2) в 30 ед. справа, `brain.profile.aggression = 0.9`. Проверить, что урон `w2` в фикстуре
≤ 89, иначе условие здоровья не пройдёт: `fixture.weapons["w2"].damage`. Случаи:
- без союзника — `drops_bomb == true` (контроль, что «драчун» бомбу кладёт);
- союзник `3` (команда 1, уровень 0) в (112 − 25, 112) — `drops_bomb == false`.

**Документация.** Раздел о бомбе ботов в `docs/en/gameplay.md` и `docs/ru/gameplay.md`
(`grep -n -i "bomb\|бомб" docs/*/gameplay.md`), в обоих языках: «при огне по своим бот не кладёт бомбу, если в
полутора радиусах взрыва на его уровне стоит союзник». **Журнал**: до релиза — дополнить существующий пункт
`### Fixed` «Bots drop a bomb only when the enemy is inside its blast radius…» фразой «…and, with friendly fire
on, never with a teammate next to them.» После релиза — отдельный пункт `### Fixed` того же смысла.

### 2.3. Часы досок команд `ai_clock` не сбрасываются при смене карты

**Где.** `core/src/tanks.rs`: поле `ai_clock: f32` (≈стр. 326), `on_ai_tick` (≈стр. 806), `clear` (≈стр. 976).

**Проблема.** `ai_clock` растёт, пока на хосте есть боты, и обнуляется только в `deserialize`. `clear()` (смена
карты) чистит `bots`, но не `team_boards`/`ai_clock`/`team_timer`. `dt` = 1/120 с, а часы в `f32`:

- после ≈9 ч часы идут на ≈6 % медленнее (округление шага);
- после ≈38 ч значение ≥ 2¹⁷ с, шаг округляется до 0.0156 с, и часы идут в ≈1.9 раза быстрее;
- после ≈58 ч значение ≥ 2¹⁸ с, шаг меньше половины ulp, и часы **останавливаются**. Тогда в
  `TeamBoard::update_roles` условие `clock - at < ROLES_INTERVAL` верно всегда, и роли больше не
  пересчитываются. В `update_focus` фокус держится, пока цель жива (`clock - focus_since < FOCUS_HOLD`).

Для выделенного сервера с ботами 24/7 это реально. Часы мозга (`BotBrain::clock`) этим не страдают: мозги
пересоздаются на каждой карте, а `mapTime` ≤ 1 ч (`roomTimeMax`, `vimp/packages/engine/src/config/hostDefaults.js`).

**Решение.**

1. Убедиться, что `GameSim::clear` зовётся при каждой смене карты:
   `vimp/packages/engine/core/src/game.rs` (`pub fn clear`, ≈стр. 412) и место его вызова в JS-хосте движка
   (`grep -rn "\.clear()" /Users/dmitry/Sites/my/vimp/packages/engine/src | grep -i core`).
2. В `TanksSim::clear` (`tanks.rs`) сразу после `self.bots.clear();` добавить:
   ```rust
   // ИИ начинается заново вместе с мозгами: доски и их часы — тоже. Иначе
   // f32-часы копились бы всё время жизни хоста и теряли точность
   // (через ≈58 ч шаг 1/120 с перестаёт их двигать)
   self.team_boards.clear();
   self.ai_clock = 0.0;
   self.team_timer = 0.0;
   ```
3. Если шаг 1 покажет, что `clear` зовётся не на каждой карте (например, при перезапуске той же карты), то
   вдобавок перевести `ai_clock` на `f64`: поле, `on_ai_tick`, передача в `TeamBoard::update` (параметр
   `clock`, поля `focus_since`/`roles_at` в `team.rs` → `f64`). Компилятор найдёт все места смешения типов.

**Тест.** `core/tests/sim.rs`: `clear_resets_team_boards`. Два бота в разных командах; гонять шаги, пока
`team_focus(team) != None` (так уже делают существующие тесты команды — найти `grep -n "team_focus"
core/tests/sim.rs`). Затем вызвать очистку ядра тем же путём, каким её зовёт движок: метод `clear` у
`GameCore`/`EngineSim`, ABI найти в `core/src/lib.rs`. Проверить `team_focus(team) == None`. На старом коде
тест красный: доска переживает `clear`.

**Документация.** `docs/en/core.md` и `docs/ru/core.md`: в описании `TeamBoard`/`ai_clock`
(`grep -n -i "team board\|TeamBoard\|ai_clock" docs/*/core.md`) добавить в обоих языках: «доски и их часы
сбрасываются вместе с ботами при смене карты (`clear`)». Журнал: до релиза не нужен; после — `### Fixed`
(«Bot team roles and focus no longer freeze on a host that has run bots for days.»).

### 2.4. (По желанию) Справедливый бюджет поисков маршрута

**Где.** `tanks.rs::on_ai_tick` (≈стр. 815–843).

**Проблема.** Боты обходятся в одном и том же порядке, а бюджет — 2 поиска на тик на всех. Первые боты всегда
тратят его раньше. В пиках (старт раунда, 7 ботов разом строят маршруты и оценивают цели) последние в порядке
ждут десятки тиков. При 16 ботах ожидание растёт.

**Решение.** Поле `ai_turn: usize` (`#[serde(skip)]`, сбрасывается в `clear` и `deserialize`). Обходить ботов
начиная с `ai_turn % ids.len()` по кругу, после тика `ai_turn += 1`. Детерминизм сохраняется. Но меняется
порядок расхода `rng`, поэтому пороговые интеграционные тесты (`hard_bots_beat_easy_bots_more_often`,
`bot_accuracy_is_human_like`, `bots_never_stall_*`) нужно прогнать заново. Если пороговый тест начнёт падать,
шаг откатить и описать в отчёте: тесты не ослаблять. Журнал не нужен (поведение внутреннее).

### 2.5. (По желанию) Урон от падения и своей бомбы приписывается врагу

**Где.** `perception.rs::update_damage` (≈стр. 367–391), `brain.rs::think`/`update_mode`.

**Проблема.** Любая потеря здоровья записывает `last_attacker` как ближайший видимый (или вообще ближайший)
контакт. Урон от прыжка с обрыва (`edge_risk`, обрывы на отходе) и от своей бомбы при огне по своим поэтому
«назначает» врага обидчиком. Дальше `choose_target` переключается на него (×0.5 к оценке), а `update_mode`
переводит бота в `Engage` («оборона при атаке»).

**Решение (набросок).** В мозге поле `#[serde(default)] fell_at: Option<f32>`: в ветке
`tank_input_locked` (`update`, ≈стр. 565) ставить `self.fell_at = Some(self.clock)`. В `think` вычислить
`self_inflicted = self.fell_at.is_some_and(|at| self.clock - at < 0.3) || (game.friendly_fire &&
self.bomb_pos.is_some() && self.clock < self.evade_until + 0.2)` и передать в `Perception::update` → в
`update_damage`. При `self_inflicted` урон учитывать (`damage_recent`, `last_damage_at`: раненый должен
отступать), но `last_attacker` не менять. В `update_mode` условие «оборона при атаке» дополнить
`&& !self_inflicted`. Тест в `perception.rs`: урон при `self_inflicted = true` не меняет `last_attacker`.

---

## Этап 3. Чистка: мёртвый код, дублирование, комментарии ✅ выполнен

> **Итог выполнения.** 3.1–3.5 сделаны. 3.1: `strength_near` оставлен — его проверяет тест
> `strength_near_counts_members`; вслед за `BotView::rules` удалено ставшее мёртвым поле `Fixture::rules`
> (`test_support.rs`). Предупреждений `dead_code` нет. Проверки 3.6 зелёные: `cargo test` 495 + 124,
> `npm test` 1129, `sim:scenarios` 20/20, детерминизм `bots_downtown`/`bots_terraces` ✅. Журнал — только
> правка формулировки 3.5.

Поведение не меняется. После этапа все тесты и `npm run sim:scenarios` должны пройти **без изменения
ожидаемых значений**.

### 3.1. Мёртвый код и устаревшие `#[allow(dead_code)]`

Этапы 3–6 закончены, а заглушки «пока не используется» остались:

| Место | Что сделать |
| ----- | ----------- |
| `tanks.rs` ≈стр. 150–152: комментарий «поля и методы для ИИ этапов 3–6 (plan/bots-ai) пока не все используются» + `#[allow(dead_code)]` над `struct BotView` | удалить оба |
| `tanks.rs` ≈стр. 182: `#[allow(dead_code)]` над `impl BotView<'_>` | удалить |
| `BotView::tank_airborne` | нигде не вызывается — удалить |
| поле `BotView::rules` | не читается — удалить поле и его инициализацию в `tanks.rs::on_ai_tick` и `bots/test_support.rs` (`BotView { … }`, ≈стр. 235) |
| `navigator.rs`: `NavStatus::Arrived` с `#[allow(dead_code)]` | удалить вариант |
| `navigator.rs`: поле `Navigator::failures` | только пишется (стр. 123, 338, 410) — удалить. Старый дамп с ключом `failures` читается: serde пропускает неизвестные поля, `deny_unknown_fields` нет |
| `navigator.rs`: `Waypoint::level` с `#[allow(dead_code)]` | удалить поле и его заполнение в `follow` |
| `geom.rs`: `#[allow(dead_code)]` у `dist` и `angle_of` | обе используются — удалить атрибуты |
| `team.rs`: `TeamBoard::strength_near` | в production-коде не вызывается; если нет и в тестах (`grep -rn strength_near core/`), удалить |

После удаления атрибутов `cargo build -p vimp-tanks-core` и `cargo test --workspace -q` не должны выдавать
`dead_code`. Если предупреждение всплыло на чём-то ещё, это тоже мёртвый код: удалить или спросить.

### 3.2. Устаревшие комментарии

- `brain.rs:19`: «константы поведения бота (из src/server/modules/bots/BotController.js)» → «константы
  поведения бота».
- `brain.rs` ≈стр. 262: «ИИ одного бота (порт BotController): навигация, прицеливание, стрельба» → «ИИ одного
  бота: восприятие, режимы, навигация, прицел и огонь».
- `tanks.rs` ≈стр. 147–150 (doc `BotView`): убрать хвост «имена полей/методов совпадают с прежним монолитным
  `GameState`, чтобы тело `BotBrain` осталось нетронутым». Написать: «Вид движковых и игровых ресурсов, которыми
  пользуется ИИ бота (`core/src/bots/`)».

### 3.3. Дублирование

1. **Максимальная скорость модели** вычисляется одинаково в `brain.rs::drive_dir` (≈стр. 2082–2086) и
   `brain.rs::aim_and_shoot` (≈стр. 2497–2501). Добавить в `impl BotView`:
   ```rust
   /// `maxForwardSpeed` модели танка, ед./с (260 — если модели нет).
   pub fn max_forward_speed(&self, game_id: u32) -> f32 {
       self.tanks
           .get(&game_id)
           .and_then(|tank| self.models.get(&tank.model))
           .map_or(260.0, |model| model.max_forward_speed)
   }
   ```
   и заменить оба места на `game.max_forward_speed(me.id)`.
2. **Разворот корпуса на месте** (`DriveCommand { right: angle > 0.0, left: angle < 0.0, ..Default }` +
   `apply_drive`) повторён в `drive_hold` (≈1474), `drive_engage` (≈1594), `drive_ramp` (≈1996),
   `run_unstuck` → `Turn` (≈2274). Добавить:
   ```rust
   /// Разворот на месте: руль в сторону знака `angle`, газ отпущен.
   fn turn_in_place(&mut self, game: &mut BotView<'_>, angle: f32) {
       self.apply_drive(
           game,
           DriveCommand {
               right: angle > 0.0,
               left: angle < 0.0,
               ..DriveCommand::default()
           },
       );
   }
   ```
   `self.stuck.reset()` оставить на местах вызова: в `run_unstuck` его нет, и так должно остаться.
3. **`PathQuery`** собирается одинаково в `navigator.rs::plan` (≈стр. 277–283) и `route_cost` (≈394–400).
   Свободная функция:
   ```rust
   /// Запрос маршрута бота: корпус, запас от стен, цена обрывов, зоны.
   fn path_query<'a>(params: &NavParams, zones: &'a [PenaltyZone]) -> PathQuery<'a> {
       PathQuery {
           min_width: params.hull_width,
           comfort_clearance: params.hull_half_length + 0.5 * params.tile,
           narrow_cost: 1.5,
           ledge_cost_scale: params.ledge_cost_scale,
           penalties: zones,
       }
   }
   ```

### 3.4. Пресеты ботов: одна таблица в двух местах

**Проблема.** Числа пресетов лежат в `src/config/game.js` (`coreParams.bots`) и копией в
`core/src/config.rs::default_bot_presets()` («Те же числа, что в src/config/game.js»). Синхронность ничем не
проверяется. В плане bots-ai (7.4) правка чисел прямо предусмотрена, и копии разойдутся молча.

**Решение** — по уже принятому в репо образцу фикстур карт (`tests/core/fixtures.test.js`):

1. Фикстура `tests/core/fixtures/bots.json` — ровно `JSON.stringify(gameConfig.coreParams.bots, null, 2)`
   (сгенерировать однострочником `node -e` и прогнать Prettier).
2. `tests/core/fixtures.test.js`: новый `it('bots.json совпадает с coreParams.bots', …)`, по образцу теста
   карт: `expect(fixture).toEqual(JSON.parse(JSON.stringify(gameConfig.coreParams.bots)))`.
3. `core/src/config.rs`: `BotRules` добавить `PartialEq` в `derive`. В модуль `validate_tests` добавить тест:
   ```rust
   #[test]
   fn bot_rules_default_matches_game_js() {
       // фикстура — копия coreParams.bots, её сверяет с game.js tests/core/fixtures.test.js
       let rules: BotRules =
           serde_json::from_str(include_str!("../../tests/core/fixtures/bots.json")).unwrap();

       assert_eq!(rules, BotRules::default());
   }
   ```
   Путь `include_str!` — от `core/src/config.rs`. Он работает, потому что крейт `vimp-tanks-core` на crates.io не
   публикуется. Так же поступает `core/tests/sim.rs` с фикстурами карт.
4. Комментарий у `default_bot_presets` дополнить: «синхронность с game.js проверяет
   `bot_rules_default_matches_game_js`».
5. `docs/en/configuration.md` и `docs/ru/configuration.md`, раздел `coreParams.bots`
   (`grep -n "bots" docs/*/configuration.md`), в обоих языках: «при правке пресетов обновить
   `tests/core/fixtures/bots.json` (тест подскажет расхождение)».

### 3.5. Журнал: формулировка

`CHANGELOG.md`, `### Added`, пункт «Bots play as a team: … focus the same enemy, one of three flanks, …».
Фраза «one of three flanks» неоднозначна. Заменить на «one bot in three flanks». Раздел `[Unreleased]` ещё не
выпущен, поэтому это правка текста, а не новая запись.

### 3.6. Проверка этапов 2–3

```bash
cd /Users/dmitry/Sites/my/vimp-tanks
npm run core:test -- -q        # все, включая новые тесты 2.1–2.3, 3.4
npm run core:build
npx eslint . --quiet
npm test -- --silent           # включая fixtures.test.js (bots.json)
npm run build
npm run sim:scenarios
npm run sim -- --scenario tests/scenarios/bots_downtown.json --determinism --no-write
npm run sim -- --scenario tests/scenarios/bots_terraces.json --determinism --no-write
```

Отчёт пользователю: что сделано и по каким пунктам, что осталось (2.4/2.5, если не делались), затронут ли
журнал.

---

## Уроки процесса (для следующих задач)

1. **Сравнение с базой — только в отдельном worktree с полной пересборкой.** `sim`/`sim:scenarios` гоняют
   собранный `dist/` и `core/pkg-node/`. `git stash` без `npm run core:build && npm run build` сравнивает
   старые артефакты, а не старый код. Так появился неверный вывод «`round.json` падает и на HEAD», и регрессию
   пропустили. Рабочий рецепт:
   `git worktree add <tmp> <rev>` → симлинк `node_modules` → `cp -R build/sounds <tmp>/build/` →
   `npm run core:build && npm run build` → `npm run sim -- --scenario … --no-write`.
2. **`Cargo.lock` под локальным `[patch]` не коммитится.** Признак — у `vimp-engine-core` нет строк
   `source`/`checksum`. Перед коммитом: `grep -n -A3 'name = "vimp-engine-core"' Cargo.lock`.
3. **Бюджетозависимую логику тестировать с ограниченным бюджетом.** У `Fixture` бюджет по умолчанию
   `u32::MAX`, и ветки «бюджета нет» такие тесты не проходят.

## Вне плана (рекомендации на будущее)

- В `brain.rs` ≈2400 строк production-кода. Режимы (`Retreat`/`Hold` с выбором точек, `Engage`/«змейка»,
  выход из застревания) стоит разнести по подмодулям `bots/modes/*.rs` — отдельной задачей, без изменения
  поведения.
- `attack_line` считает `fire_line` (луч по сетке, `ray_segments`, физический луч) на **каждом** тике (120 Гц)
  для каждого бота с целью, хотя восприятие и так обновляет `contact.fire_line` раз в 0.1 с. Замер 7.3 показал
  запас (≈12 мкс на шаг), поэтому это оптимизация на потом, а не дефект.
