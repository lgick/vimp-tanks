# Этап 5. Пояснение про фикстуры Rust, итоговая проверка, закрытие плана ✅ выполнен

## 5.1 Пояснение про фикстуры

`docs/en/core.md` → `## Tests`, `docs/ru/core.md` → `## Тесты`: абзац после таблицы — фикстуры Rust
(`flat_config_json()` в `core/tests/sim.rs`, `config_json()` в `core/src/client/predictor.rs`, хелперы `model()` в
`motion.rs`, `tank.rs`, `bots/test_support.rs`, `config.rs`) **намеренно** описывают танк на 260 (`size` 2): они
проверяют формулы и паритет хоста с репликой, а не баланс. Игровые значения (`models.js`, `weapons.js`, `game.js`)
проверяет JS-харнесс `tests/core/core.test.js` (прыжок с бустера на `downtown`, калибровка отброса `w1`).
Синхронизировать фикстуры с `models.js` не нужно. В CHANGELOG не пишется.

## 5.2 Итоговая проверка

```bash
npx eslint . --quiet
(cd core && cargo test --workspace -q)
npm run core:build
npx vitest run --reporter=dot
npm run build
npm run sim:scenarios 2>&1 | grep -E "^===|❌|failed"
npm run sim:scenarios -- --determinism 2>&1 | grep -E "❌|failed"
```

## 5.3 Сверка изменений

- `git status --short` / `git diff --stat` — только файлы этапов.
- Каждая правка в `docs/en/` имеет пару в `docs/ru/`.
- `CHANGELOG.md → [Unreleased]`: `### Added` — `hitResponse` (этап 3); `### Changed` — таран (1), `npm run dev`
  (2), отброс `w1` (4). Порядок подразделов: `Added` перед `Changed`.
- `CLAUDE.md` не менялся (новых команд нет).

## 5.4 Отчёт и закрытие

1. Итоговый отчёт пользователю по-русски: что сделано по этапам, подобранные числа (`impulseMagnitude`,
   `hitResponse`), что поменялось в сценариях, «Замечания без правок» из `README.md`, список ручных проверок.
2. Отметить этап «✅ выполнен» в этом файле и в `README.md`.
3. Перенести каталог плана: `plan/hit-knockback-ram/` → `plan/done/hit-knockback-ram/` (`git mv`, если файлы под
   git; иначе `mkdir -p plan/done && mv`). Не коммитить.
