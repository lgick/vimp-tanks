# Этап 7 (T + E). Приёмка, производительность, выпуск

**Цель.** Доказать, что задача решена целиком: боты не зависают на всех картах, находят и атакуют цель,
играют командой и отступают. Производительность в норме, детерминизм цел. Временный patch снят, игра переведена
на выпущенный крейт.

---

## 7.1. Регрессионный набор (`core/tests/sim.rs`) ✅ выполнен

Общий хелпер `run_bot_match(map_json, per_team: usize, seconds: f32) -> MatchLog`:

- спавнит по `per_team` ботов на первых точках `respawns.team1/team2` карты (масштаб — `scale` карты);
- гоняет `steps` и каждые 0.5 с снимает по каждому боту позицию, `alive`, `bot_debug`;
- собирает события (`health`, `Death`).

`MatchLog` умеет:

- `longest_stall(id)` — самое длинное окно «жив, не в `Engage`/`Hold`, сместился меньше 8 ед.»;
- `damage_by_team`;
- `replans(id)`, `route_failures(id)`, `watchdog_resets(id)`.

Тесты (каждый — на `downtown`, `terraces`, `overpass`; фикстуры `tests/core/fixtures/*.json`):

| Тест                                        | Проверка                                                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `bots_never_stall_<map>`                    | 4×4 бота, 120 с: `longest_stall ≤ 6 с` у каждого; `watchdog_resets ≤ 3` у каждого                |
| `bots_fight_on_<map>`                       | 4×4, 120 с: обе команды нанесли урон; был хотя бы один `Death`                                   |
| `bots_use_levels_on_<map>` (только слоёные) | 4×4, 120 с: хотя бы один бот побывал на уровне ≥ 1 и хотя бы один — на уровне 0 после уровня ≥ 1 |
| `bot_replans_are_bounded_<map>`             | `replans ≤ 90` в минуту на бота; `route_failures / max(1, replans) < 0.1`                        |

Отдельно:

- `bot_match_is_deterministic`: `downtown`, 4×4, 60 с, дважды с нуля. Позиции всех танков совпадают бит-в-бит.
- `bot_dump_restores_identical_simulation`: по образцу `state_dump_restores_identical_simulation`
  (`sim.rs:649`), но на слоёной карте с 4 ботами. Дамп на 20 с, восстановление, ещё 20 с у обоих — позиции
  совпадают. Проверяет `#[serde(default)]` новых полей и пересборку `TeamBoard` после `deserialize`.
- `old_bot_dump_still_loads`: взять JSON дампа мозга без новых полей, вручную: `{"game_id":1,"state":"Patrolling",
…}` в форме старого `BotBrain`. `serde_json::from_value::<BotBrain>` не падает, `mode == Roam`.

Если какой-то тест не проходит, чинить поведение (пороги этапов 3–6, пресеты), а **не** ослаблять проверку. Если
причина в карте (например, узкий проход без места под корпус), описать её в отчёте и спросить пользователя.

## 7.2. Сценарии отладки (`tests/scenarios/`) ✅ выполнен

- Новый `bots_terraces.json` по образцу `bots_downtown.json`: `"map": "terraces"`, один человек `p1` в `team1`,
  `/bot 7` на тике 60, `"ticks": 7200`, `"dumpTicks": [1800, 3600, 5400, 7200]`, `"unusedSnapshotKeys": ["c2"]`,
  `"divergence": null`, свой `seed`.
- В `bots_downtown.json` поднять ботов до `/bot 7` (4 на 4 с человеком).
- Сценарии правил игры **не** утверждают (`CLAUDE.md`). Их задача — инварианты движка, детерминизм и дампы для
  ручного разбора.
- Таблицу сценариев в `docs/en/getting-started.md` (+ ru, раздел со списком `tests/scenarios/*.json`,
  стр. ≈276) дополнить строкой `bots_terraces.json`.

```bash
npm run build
npm run sim:scenarios
npm run sim -- --scenario tests/scenarios/bots_downtown.json --determinism
npm run sim -- --scenario tests/scenarios/bots_terraces.json --determinism
```

Код выхода 0. В дампах (`.debug/`) у ботов разные `mode`, `stats.stuck_events` мал, `watchdog_resets` около 0.

## 7.3. Производительность ✅ выполнен

1. Тест-замер `#[ignore]` в `core/tests/sim.rs`: `bench_bot_ai_downtown`. 10 ботов (5×5), 60 с; время
   `core.step(DT)` меряется `std::time::Instant` в сумме и отдельно для прогона без ботов (та же карта, 10
   `spawn_actor` без ИИ, стоят). Печатается среднее на шаг и разница.
   ```bash
   cargo test --release -q -p vimp-tanks-core --test sim bench_bot_ai_downtown -- --ignored --nocapture
   ```
2. Ориентир: вклад ИИ **≤ 0.5 мс на шаг** в среднем на машине разработчика (native release). В WASM медленнее
   в 1.5–2 раза: при 120 шагах/с это ≤ 12 % бюджета кадра Worker'а.
3. Если больше — по порядку, пересчитывая замер после каждого шага:
   - `BOT_ROUTE_BUDGET_PER_TICK` 2 → 1;
   - сглаживание маршрута раз в 0.3 с вместо 0.2;
   - `rebuild_team_boards` раз в 0.2 с;
   - кэш стоимости маршрута в `choose_target` — 3 с вместо 2.
4. Результат замера (до/после) записать в отчёт этапа.

## 7.4. Ручная проверка (`npm run dev`)

> ⏳ Ждёт пользователя: ручная игра.

На картах `downtown`, `terraces`, `overpass`, `pool mini`, `canopy`, по 3–5 минут, `/bot 7`, играя за одну
команду. Проверить:

- [ ] никто не стоит дольше нескольких секунд без причины (засада `Hold` видна: корпус и башня смотрят в проход);
- [ ] на рампы заезжают с торца, с мостов спускаются по рампам и иногда спрыгивают;
- [ ] находят врага через всю карту;
- [ ] промахиваются, но убивают; очереди; в своих не стреляют;
- [ ] раненый отъезжает задом, отстреливаясь; прячется за угол; возвращается вместе с подошедшими;
- [ ] толпой не липнут друг к другу, но и не растягиваются по одному.

Замеченные перекосы править **числами пресетов** (`src/config/game.js` → `coreParams.bots.presets` и
`default_bot_presets()` в `core/src/config.rs`: числа одни и те же в обоих местах). После правки — 7.1 и 7.2
заново. Изменения чисел описать в отчёте.

## 7.5. Документация — финальная сверка ✅ выполнен

Пройти `docs/en/gameplay.md`, `core.md`, `configuration.md`, `getting-started.md` и зеркала в `docs/ru/`:

- структура совпадает, `docs/ru/` не отстаёт от `docs/en/`;
- нет упоминаний удалённого: `BotState`, `ClearingObstacle`, `find_closest_enemy`, `bots::controller`,
  `AIM_INACCURACY` (`grep -rn` по `docs/`);
- раздел «Bots» в `gameplay.md` описывает поведение целиком и без противоречий: навигация, знание, бой, команда,
  отступление, чего бот не делает.

`CHANGELOG.md` — записи этапов 2–6 на месте под `## [Unreleased]` и не дублируют друг друга. Если записи одного
раздела про одно и то же, слить их.

`CLAUDE.md` репо: команды и стек не менялись, поэтому правок не нужно. Проверить только, что список «Change →
Page» по-прежнему верен: боты → `gameplay.md`, `core.md`.

## 7.6. Переход на выпущенный крейт и снятие patch ✅ выполнен

> Выполнено в `plan/bots-ai-review.md`, этап 1: крейт 0.23.1 (в 0.23.0 нет фикса `find_route`), patch снят,
> `Cargo.lock` с `source`/`checksum`, строка журнала и версии в `getting-started.md` (en/ru) обновлены.

Выполнять, **только когда пользователь подтвердил**, что `vimp-engine-core` с API этапа 1 опубликован (версию
назовёт он, ожидается `0.23.0`). Иначе остановиться и спросить.

1. Удалить `.cargo/config.toml` и строку `.cargo/` из `.git/info/exclude`.
2. `core/Cargo.toml`: `vimp-engine-core = "0.23.0"` (фактическая версия).
3. `cargo update -p vimp-engine-core` — `Cargo.lock` теперь указывает на crates.io, с `checksum`.
4. `npm run core:build`, чтобы пересобрать `core/pkg-web/` и `core/pkg-node/` против выпущенного крейта
   (`docs/en/getting-started.md`, раздел про бамп крейта).
5. `CHANGELOG.md`, `## [Unreleased]` → `### Changed`: «Requires `vimp-engine-core` 0.23 (navigation queries
   `find_route`).»
6. `docs/en/getting-started.md` (+ ru): если там упомянута версия крейта, которой следует релиз (≈стр. 36–40),
   обновить.
7. `git status` — в рабочем дереве нет `.cargo/`, `Cargo.lock` изменён только бампом.

## 7.7. Полная итоговая проверка

```bash
cd /Users/dmitry/Sites/my/vimp && cargo test --workspace -q && npx eslint . --quiet && npm test -- --silent
cd /Users/dmitry/Sites/my/vimp-tanks
npm run core:test -- -q
npm run core:build
npx eslint . --quiet
npm test -- --silent
npm run build
npm run sim:scenarios
```

Все команды зелёные. Отчёт пользователю на русском, коротко:

- что сделано по этапам;
- результаты 7.1–7.3 (цифры замера);
- что проверено руками;
- влияние на релиз: игра `@vimp-games/tanks` — минорный бамп (есть `### Added`), релиз ручной (`CLAUDE.md` репо,
  раздел «Changelog»).

## 7.8. Архивирование плана

Когда все этапы в таблице README отмечены «✅ выполнен»: перенести `plan/bots-ai/` целиком в
`plan/done/bots-ai/` (`git mv`, если файлы в git, иначе `mv`). Не коммитить.
