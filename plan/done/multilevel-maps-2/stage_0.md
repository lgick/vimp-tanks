# Этап 0. База, связка репозиториев, хвосты журналов ✅ выполнен

**Репозитории:** E + T. **Зависит от:** ничего. **Блокирует:** всё.

## Цель

Зафиксировать зелёную базовую линию (эталон регресса) и убрать хвосты
прошлых релизов, чтобы правки этой итерации не смешались с чужими.

## 0.1 Базовая линия

Прогнать и **записать вывод** — с ним сравнивается всё дальнейшее:

```bash
# E
cd /Users/dmitry/Sites/my/vimp \
  && cargo test --workspace --quiet && npx eslint . && npx vitest run

# T
cd /Users/dmitry/Sites/my/vimp-tanks \
  && npm run core:test && npx eslint . && npm test -- --silent \
  && npm run build && npm run sim:scenarios && npx vimp-contract --strict
```

Ожидания на момент составления плана: обе рабочие копии чистые, крейт
`0.11.0`, npm движка `0.30.1`, танки `0.17.1`,
`vimp-tanks/core/Cargo.toml` → `vimp-engine-core = "0.11.0"`,
`[patch.crates-io]` **отсутствует** в обоих `Cargo.toml` танков.

Если `npx vimp-contract --strict` не даёт 0 или сценарии красные — это
не задача итерации, но починить/зафиксировать причину нужно до старта.

## 0.2 Связка репозиториев

```bash
npm link
cd /Users/dmitry/Sites/my/vimp/packages/engine && npm link
cd /Users/dmitry/Sites/my/vimp && npm link @vimp-games/tanks
cd /Users/dmitry/Sites/my/vimp-tanks && npm link vimp-engine
```

Rust-патч **не коммитить** — правило записано в
`docs/en|ru/getting-started.md` после кодревью 1.1. Пользоваться флагом,
а не правкой файла:

```bash
cd /Users/dmitry/Sites/my/vimp-tanks
cargo --config 'patch."crates-io".vimp-engine-core.path="../vimp/packages/engine/core"' test --workspace
```

`wasm-pack` `--config` не принимает, поэтому `npm run core:build`,
`npm run build` и `npm run sim:scenarios` в танках будут недоступны с
момента, когда `core/Cargo.toml` потребует `0.12.0`, и до `cargo publish`
на этапе 2. Это ожидаемо и не считается регрессом.

## 0.3 Хвосты журналов

В обоих репозиториях версия пакета на патч выше последнего заголовка в
`CHANGELOG.md`:

* `vimp-engine` — `package.json` 0.30.1, последний заголовок `## [0.30.0]`,
  `## [Unreleased]` пуст;
* `@vimp-games/tanks` — `package.json` 0.17.1 (коммит `9825724`
  «chore: release 0.17.1»), последний заголовок `## [0.17.0]`, при этом
  `## [Unreleased]` **не пуст** — в нём лежат записи кодревью 2.5D.

Правило `CLAUDE.md` («releasing is manual here») требует, чтобы релизный
коммит закрывал `## [Unreleased]` датой. Действие: спросить пользователя,
чем были эти патч-релизы. При отсутствии другого ответа — закрыть
накопленное в танках как `## [0.17.1] - <дата коммита 9825724>`, открыть
пустой `## [Unreleased]`, тем же приёмом поправить движок. Отдельным
изменением, до первой правки кода.

## Проверка

Обе команды из 0.1 зелёные, рабочие деревья содержат только правку
журналов.

## Отклонения

* Базовая линия зелёная полностью, чинить ничего не потребовалось:
  E — `cargo test --workspace` 144 теста, `eslint` 0, `vitest` 2309 тестов;
  T — `core:test` 34 теста, `eslint` 0, `npm test` 198 тестов, `build`,
  `sim:scenarios` (8 сценариев), `vimp-contract --strict` 0.
* Версии на момент старта совпали с ожиданиями плана: крейт `0.11.0`,
  `vimp-engine` 0.30.1, танки 0.17.1, `vimp-engine-core = "0.11.0"` в
  `core/Cargo.toml`, `[patch.crates-io]` отсутствует.
* Связка: симлинки `vimp-tanks/node_modules/vimp-engine` →
  `../../vimp/packages/engine` и `vimp/node_modules/@vimp-games/tanks` →
  `../../../vimp-tanks` созданы, рабочие деревья от `npm link` не изменились.
* Хвосты журналов закрыты по варианту «по умолчанию из плана» (выбор
  пользователя): в танках накопленный `## [Unreleased]` (кодревью 2.5D)
  закрыт как `## [0.17.1] - 2026-09-04` (дата коммита `9825724`), сверху
  открыт пустой `## [Unreleased]`. В движке `## [Unreleased]` был пуст, а
  релиз `fede38ed` менял только версии/ссылки, поэтому добавлен заголовок
  `## [0.30.1] — 2026-09-04` с записью `### Changed` об этом служебном
  бампе плюс ссылка на тег внизу файла.
