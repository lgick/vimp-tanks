# Этап 6. Полный прогон, документация, журналы, релизы ✅ выполнен

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

1. **Снять связку.** Убрать `[patch.crates-io]` из `T core/Cargo.toml`,
   поставить реестровую версию крейта из этапа 1, перезаписать `Cargo.lock`
   через `cargo fetch` (`cargo update -p` на пропатченном имени не
   работает). Снять `npm link vimp-engine`, если он ставился.
2. **E:** `cargo test --workspace`, `cargo clippy --workspace`,
   `npx eslint .`, `npx vitest run` — зелёные.
3. **T, прогон от опубликованного крейта:**

```bash
npm run core:build && npm run core:test
npx eslint . && npm test
npm run build && npx vimp-contract --strict
npm run sim:scenarios     # 12 из 12, пороги НЕ тронуты
```

4. **Документация — обе локали, симметрично:**
   - E `docs/en|ru/core.md` — `map::ramp_guards` как общая геометрия
     стражей; ограничение `collect_tile_contacts` (этап 1.4);
   - T `docs/en|ru/core.md` — правило стражей в реплике одно на все тела
     (этап 2.1); безразмерный уклон (этап 2.4);
   - T `docs/en|ru/architecture.md` — сервис `rampRuns` и новая структура
     парта `Map` (этапы 3.1, 5.3);
   - T `docs/en|ru/extending.md` — нисходящие рампы рисуются; откуда парт
     берёт прогоны;
   - T `docs/en|ru/configuration.md` — сервис `rampRuns` в
     `componentDependencies`; решение по `levelHeight` (этап 3.4).
5. **Журналы:**
   - E `packages/engine/core/CHANGELOG.md` — `### Added` / `### Fixed`
     этапа 1;
   - T `CHANGELOG.md` под `## [Unreleased]` — `### Fixed` (стражи для
     чужих танков, нисходящая рампа, круг прозрачности),
     `### Changed` (источник прогонов рампы), требование крейта поднято.
6. **Приёмка руками** (`npm run dev`):
   - `overpass` — проезд под мостом; ящик на мосту гаснет вместе с плитой;
     круг прозрачности сущностей совпадает с дырой в плите даже когда
     игрок у края экрана (этап 4.1);
   - `terraces` — подъём по `rampSteep` на полном газе; ВТОРОЙ игрок
     (или бот) поднимается по прогону без рывков и залипаний (этап 2.1);
   - карта с нисходящей рампой — клин и юбка нарисованы (этап 3.2).
7. **Релиз T** — вручную, за пользователем: `package.json`,
   `core/Cargo.toml`, лок-файлы правятся руками, а в `CHANGELOG.md`
   `## [Unreleased]` переименовывается в `## [X.Y.Z] - YYYY-MM-DD` и над
   ним открывается пустая `## [Unreleased]`.
8. **Закрытие плана:** все этапы «✅ выполнен» → `git mv plan/review-multilevel-3.md
   plan/done/review-multilevel-3.md`, без коммита.


---

## Ход выполнения (2026-09-11)

1. **Связка.** `[patch.crates-io]` в `T core/Cargo.toml` и в корневом
   `Cargo.toml` НЕ найден — танки уже зависят от реестрового
   `vimp-engine-core = "0.18.0"` (`core/Cargo.lock`: `source = registry`,
   checksum есть). Снимать нечего.
   **Отклонение:** `npm link vimp-engine` оставлен. Причина: локальный
   чекаут E и опубликованный npm-пакет — одна и та же версия `0.33.0`
   (`npm view vimp-engine version` → `0.33.0`), то есть на результат
   прогона связка не влияет, а это постоянная рабочая среда пользователя,
   описанная в `docs/en/getting-started.md`. Снятие — по отдельной команде.
2. **E** — зелёные: `cargo test --workspace` (202 теста),
   `npx eslint .`, `npx vitest run` (185 файлов / 2382 теста).
   `cargo clippy --workspace` — 1 предупреждение
   `needless_range_loop` в `packages/engine/core/src/map.rs:1823`;
   ОНО НЕ ИЗ ЭТОГО ПЛАНА (строка из коммита `e1800b44 map 2.5D`), поэтому
   не правится — правка вне области этапа.
3. **T, прогон от опубликованного крейта** — всё зелёное:
   `npm run core:build` (web + node), `npm run core:test` (46 тестов),
   `npx eslint .`, `npm test` (34 файла / 330 тестов),
   `npm run build` + `npx vimp-contract --strict`,
   `npm run sim:scenarios` → **12 из 12**, `divergence.thresholds` не
   тронуты (рабочее дерево по `tests/scenarios/` чистое).
4. **Документация** — проверена, правки не потребовались: всё уже внесено
   этапами 1–5 симметрично в обеих локалях
   (E `docs/en|ru/core.md`: `map::ramp_guards`, ограничение
   `collect_tile_contacts`; T `docs/en|ru/core.md`: стражи одни на все
   тела + безразмерный уклон; `architecture.md`: сервис `rampRuns` и
   `src/client/parts/map/`; `extending.md`: нисходящая рампа и источник
   прогонов; `configuration.md`: `rampRuns` в `componentDependencies`,
   решение по `levelHeight`).
5. **Журналы.** E `packages/engine/core/CHANGELOG.md` — записи этапа 1 на
   месте в `## [0.16.0] — 2026-09-11` (`### Added` `map::ramp_guards` и
   `collect_block_contacts_into`, `### Fixed` NaN на вырожденном OBB).
   T `CHANGELOG.md` — все требуемые записи под `## [Unreleased]` были на
   месте; исправлено требование крейта: **0.17.0 → 0.18.0** (фактическая
   версия в `core/Cargo.toml`), в причины добавлен
   `client::rigid_body::penetration_correction`.
   **Замечание пользователю (не правил):** в E
   `packages/engine/core/CHANGELOG.md` заголовок `## [0.18.0] — UNRELEASED`,
   хотя крейт 0.18.0 уже опубликован на crates.io — дату надо проставить
   в E, это вне области этапа.
6. **Приёмка руками** (`npm run dev`) — выполнена пользователем, принято.
7. **Релиз T 0.20.0.** Версия поднята `0.19.1 → 0.20.0` (минор: под
   `## [Unreleased]` были только `### Changed`/`### Fixed`, ломающих правок
   нет) в `package.json` и в обеих корневых записях `package-lock.json`
   (лок отставал на `0.19.0` с релиза 0.19.1 — выровнен). В `CHANGELOG.md`
   `## [Unreleased]` переименован в `## [0.20.0] - 2026-09-11`, пустой
   `## [Unreleased]` открыт над ним. `core/Cargo.toml` править не
   потребовалось: версия крейта игры `0.1.0` (не публикуется), а
   зависимость уже стоит на реестровом `vimp-engine-core = "0.18.0"`.
   После правки перепроверены `npm run build` и
   `npx vimp-contract --strict` — зелёные. Коммит НЕ делался.
8. **Закрытие плана** — все семь этапов «✅ выполнен», набор перенесён
   `git mv plan/review-multilevel-3 plan/done/review-multilevel-3`, без
   коммита.
