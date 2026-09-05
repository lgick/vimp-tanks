# Этап 0. Базовая линия и связка репозиториев ✅ выполнен

**Репо:** E + T. **Зависимости:** нет. **Код не меняется.**

## Зачем

Все последующие этапы сверяют числа с этим. Без зафиксированной базы
невозможно отличить «сломал я» от «было сломано».

## 0.1 Базовая линия E (`/Users/dmitry/Sites/my/vimp`)

```bash
cd /Users/dmitry/Sites/my/vimp
cargo test --workspace          # ожидание: 159 тестов, 0 упавших
npx eslint .                    # ожидание: 0 ошибок
npx vitest run --reporter=dot    # ожидание: ~2318 тестов, 0 упавших
```

Записать в конец этого файла фактические числа и версии:

```bash
grep '^version' packages/engine/core/Cargo.toml   # ожидание: 0.12.0
node -p "require('./packages/engine/package.json').version"  # ожидание: 0.31.0
grep -c 'patch.crates-io' Cargo.toml || true      # ожидание: 0 (патча нет)
```

`cargo clippy --workspace` прогнать отдельно и записать базовую линию:
на момент составления плана в `physics.rs` есть 4 доэтапные ошибки
`approx_constant`. Новых быть не должно; старые не чинить (вне рамок).

## 0.2 Базовая линия T (`/Users/dmitry/Sites/my/vimp-tanks`)

```bash
cd /Users/dmitry/Sites/my/vimp-tanks
npm run core:test               # ожидание: 42 теста
npx eslint .                    # ожидание: 0
npm test                        # ожидание: ~235 тестов
npm run build                   # должен пройти без ошибок
npx vimp-contract --strict      # ожидание: 36 проверок, 0 ошибок
npm run sim:scenarios           # ожидание: 11 сценариев зелёные
```

Версии:

```bash
node -p "require('./package.json').version"        # ожидание: 0.18.1
grep '^version' core/Cargo.toml                    # ожидание: 0.12.0 (крейт игры)
node -p "require('./package.json').dependencies['vimp-engine']"  # ^0.31.0
```

## 0.3 Связка репозиториев

Этапы 3—6 идут против **локального** движка, поэтому симлинки нужны в обе
стороны:

```bash
cd /Users/dmitry/Sites/my/vimp/packages/engine && npm link
npm link vimp-engine && npm link
cd /Users/dmitry/Sites/my/vimp && npm link @vimp-games/tanks
```

Проверка: `ls -l node_modules/vimp-engine` в T должен показать симлинк.
После связки **повторить `npm test` в T** — рабочие деревья от `npm link`
меняться не должны.

Крейт движка на этапах 1 и 3 берётся из реестра (0.12.0). Патч
`[patch.crates-io]` в `core/Cargo.toml` танков **не заводить**: `wasm-pack`
его не принимает, и `npm run build` молча соберёт не тот код. Локальный
крейт подключается только после публикации этапа 2 сменой версии.

## 0.4 Хвосты журналов

Проверить, что `## [Unreleased]` в `CHANGELOG.md` обоих репозиториев пуст
(последние релизы закрыты). Если нет — закрыть предыдущую секцию датой
релиза и открыть пустой `## [Unreleased]` сверху.

## Критерии приёмки

- [x] Все команды 0.1 и 0.2 зелёные, числа записаны ниже.
- [x] Симлинки созданы, `npm test` в T после связки по-прежнему зелёный.
- [x] `## [Unreleased]` пуст в обоих репо.

## Фактические числа

Снято 2026-09-05.

### E (`/Users/dmitry/Sites/my/vimp`)

| Команда | Ожидание | Факт |
| --- | --- | --- |
| `cargo test --workspace` | 159 тестов, 0 упавших | **159 passed, 0 failed** (+ 0 doc-тестов) |
| `npx eslint .` | 0 ошибок | **0 ошибок** |
| `npx vitest run --reporter=dot` | ~2318 тестов | **2318 passed, 183 файла, 0 упавших** |
| `packages/engine/core/Cargo.toml` version | 0.12.0 | **0.12.0** |
| `packages/engine/package.json` version | 0.31.0 | **0.31.0** |
| `grep -c 'patch.crates-io' Cargo.toml` | 0 | **0** |

`cargo clippy --workspace`: **0 ошибок, 1 предупреждение** —
`needless_range_loop` (`packages/engine/core/src/map.rs:1501`, переменная `y`
используется только как индекс `work`). Ожидавшихся четырёх ошибок
`approx_constant` в `physics.rs` **нет** (см. «Отклонения»). Базовая линия
клиппи: `1 warning`, новых быть не должно.

### T (`/Users/dmitry/Sites/my/vimp-tanks`)

| Команда | Ожидание | Факт |
| --- | --- | --- |
| `npm run core:test` | 42 теста | **42 passed, 0 failed** |
| `npx eslint .` | 0 | **0 ошибок** |
| `npm test` | ~235 тестов | **237 passed, 25 файлов, 0 упавших** |
| `npm run build` | без ошибок | **зелёный**, manifest `ebdbe9ac742f0d93`, карты: canopy, garden, overpass, pool mini, terraces |
| `npx vimp-contract --strict` | 36 проверок, 0 ошибок | **36 passed, 0 failed (0 error, 0 warning), 0 skipped** |
| `npm run sim:scenarios` | 11 сценариев зелёные | **all 11 scenario(s) green** |
| `package.json` version | 0.18.1 | **0.18.1** |
| `core/Cargo.toml` | 0.12.0 | версия крейта игры **0.1.0**; `vimp-engine-core = "0.12.0"` |
| зависимость `vimp-engine` | ^0.31.0 | **^0.31.0**, но в `devDependencies` |

### Связка

- `vimp-tanks/node_modules/vimp-engine -> ../../vimp/packages/engine` (симлинк был на месте, пересоздан `npm link vimp-engine`).
- `vimp/node_modules/@vimp-games/tanks -> ../../../vimp-tanks` (создан).
- `npm test` в T после связки: **237 passed**.
- Рабочие деревья обоих репозиториев после связки чистые (`git status --porcelain` пуст).

### Журналы

`## [Unreleased]` пуст в `vimp-tanks/CHANGELOG.md`,
`vimp/packages/engine/CHANGELOG.md` и `vimp/packages/engine/core/CHANGELOG.md`.
Правки не потребовались.

## Отклонения от плана

1. **Клиппи-база другая.** Вместо четырёх ошибок `approx_constant` в
   `physics.rs` — ноль ошибок и одно предупреждение `needless_range_loop`
   в `map.rs:1501`. Причина: план составлялся до релиза 0.12.0, в котором
   константы уже были поправлены. Не чиню (вне рамок), база записана выше.
2. **`core/Cargo.toml` версия 0.1.0, а не 0.12.0.** В плане перепутаны
   собственная версия крейта игры и версия зависимости `vimp-engine-core`.
   Значение, которое проверялось по существу (зависимость), равно 0.12.0.
3. **`vimp-engine` лежит в `devDependencies`, а не в `dependencies`.**
   Это ожидаемо для плагина (движок — хост), команда из плана падала на
   `require(...).dependencies`; факт снят через `devDependencies`.
4. **В `CHANGELOG.md` танков нет секции `## [0.18.1]`.** Релиз 0.18.1
   (коммит `0423270`) поменял только `package.json`. Критерий этапа —
   пустой `## [Unreleased]` — выполнен, поэтому журнал не трогал.
5. **Числа тестов чуть выше плановых** (T: 237 против ~235). Расхождение
   в пределах «~», код не менялся.
