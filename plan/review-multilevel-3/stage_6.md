# Этап 6. Полный прогон, документация, журналы, релизы

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

