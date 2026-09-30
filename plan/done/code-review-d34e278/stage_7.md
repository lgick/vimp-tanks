# Этап 7. Итоговая проверка и закрытие плана ✅ выполнен

**Предусловие:** этапы 1–6 отмечены «✅ выполнен» в `README.md`. Если какой-то не выполнен, выполнить его или
сообщить пользователю, почему он пропущен.

## 7.1. Полный прогон

```bash
npx eslint . --quiet
cargo test --workspace -q
npm run core:build
npx vitest run --reporter=dot
npm run build                                   # после core:build: build копирует core/pkg-node
npm run sim:scenarios 2>&1 | grep -E "^===|❌|  - |passed"
npm run sim:scenarios -- --determinism 2>&1 | grep -E "❌|failed"
```

Всё зелёное. Ожидаемые приросты относительно базовой линии (`README.md`):
- `vitest`: +2 теста: `tests/config/client.test.js`, `tests/client/parts/effects/PuffEffect.test.js`;
- `cargo`: +1 юнит-тест в `surface.rs` и +1 в `core/tests/sim.rs`.

Если что-то красное, перезапустить только упавшее с подробным выводом, исправить в рамках своего этапа и
сообщить.

## 7.2. Сверка изменений

`git status --short` и `git diff --stat`. Изменены должны быть только файлы из этапов:
- этап 1 — `src/config/client.js`, `tests/config/client.test.js`, `docs/{en,ru}/configuration.md`,
  `docs/{en,ru}/extending.md`;
- этап 2 — `core/src/{surface,tank,tanks}.rs`, `core/src/client/{predictor,map_dynamics}.rs`, `core/tests/sim.rs`,
  `tests/core/core.test.js`, `docs/{en,ru}/core.md`, `CHANGELOG.md`;
- этап 3 — `tests/scenarios/*.json`, при необходимости `docs/{en,ru}/getting-started.md`;
- этап 4 — `src/config/render.js`;
- этап 5 — `src/client/parts/effects/shot/{MuzzleFlashEffect,PuffEffect}.js`,
  `tests/client/parts/effects/PuffEffect.test.js`;
- этап 6 — `tests/core/core.test.js`, `src/data/weapons.js`, `tests/client/parts/effects/MuzzleFlashEffect.test.js`.

Лишнего быть не должно: `.debug/`, временных скриптов, `Cargo.lock`, `package-lock.json`, `dist/`. `dist/` и
`core/pkg-*` в `.gitignore`. Если `.debug/` появился, его можно удалить: это отчёты раннера.

Проверить:
- `CHANGELOG.md → [Unreleased]`: одна новая запись, `### Fixed` про бустер (этап 2), после `### Changed`. Других
  новых записей нет;
- каждая правка `docs/en/*` имеет пару в `docs/ru/*` и наоборот (`git diff --stat docs`);
- `CLAUDE.md` не меняется: зависимости, сборка и команды тестов прежние.

## 7.3. Закрытие плана

1. Заголовок этого файла дополнить «✅ выполнен», в таблице `README.md` отметить этап 7.
2. Переместить каталог плана в архив, не коммитя:
   - `mkdir -p plan/done` (если нет);
   - план не отслеживается git (`git ls-files plan/code-review-d34e278` пусто) — `mv plan/code-review-d34e278 plan/done/`;
     если отслеживается — `git mv plan/code-review-d34e278 plan/done/code-review-d34e278`.
3. Исходный предварительный файл `plan/code-review-d34e278.md`, если он ещё лежит, **не удалять без согласия
   пользователя**: спросить.

## 7.4. Отчёт пользователю (по-русски, кратко)

- что сделано по этапам и итог проверок;
- что `sim:scenarios` зелёный и `npm run release` в `../vimp` можно повторить. Сам релиз не запускать;
- какие сценарии перекалиброваны и с какими новыми тиками; изменились ли факты в `getting-started.md`;
- «Замечания без правок» из `README.md`, требующие решения: пороги тарана пропов при потолке 130, боты без бомб на
  `downtown`, фикстуры Rust на 260, `npm run dev` на `pool mini`;
- что ручная проверка дыма разрыва (`npm run dev`, выстрел в стену) остаётся за пользователем.
