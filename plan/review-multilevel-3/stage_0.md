# Этап 0. Базовая линия и связка репозиториев ✅ выполнен

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

Цель — эталон, с которым сравнивается каждый следующий этап.

1. Убедиться, что рабочие деревья обоих репозиториев чистые
   (`git status --short` — пусто, кроме этого файла плана).
2. Прогнать полный набор в **E** и записать числа сюда же, в этот пункт:

```bash
cd /Users/dmitry/Sites/my/vimp
cargo test --workspace      # ожидается ~194 теста
cargo clippy --workspace    # известное предупреждение `the loop variable y` — было и до правок
npx eslint .
npx vitest run              # ожидается ~2332 теста
```

Записано (2026-09-11):

- `cargo test --workspace` — **194 passed, 0 failed** (+ 0 doc-tests);
- `cargo clippy --workspace` — **1 warning**, ровно известное
  `needless_range_loop` на `packages/engine/core/src/map.rs:1769`
  («the loop variable y is only used to index work»), других нет;
- `npx eslint .` — чисто, код выхода 0;
- `npx vitest run` — **185 файлов, 2382 passed, 0 failed** (плана ждал ~2332,
  расхождение — просто более свежее дерево, все тесты зелёные).

3. Прогнать полный набор в **T** и записать числа:

```bash
cd /Users/dmitry/Sites/my/vimp-tanks
npm run core:test           # ожидается 238 + 45
npx eslint .
npm test                    # ожидается ~303
npm run build
npx vimp-contract --strict  # ожидается 36/36
npm run sim:scenarios       # ожидается 12/12, exit 0
```

Записано (2026-09-11), версия репозитория `@vimp-games/tanks 0.19.1`:

- `npm run core:test` — **238 passed** (`vimp-tanks-core`) + **45 passed**
  (интеграционные), 0 failed;
- `npx eslint .` — чисто, код выхода 0;
- `npm test` — **29 файлов, 303 passed**, 0 failed;
- `npm run build` — успешно, `dist/manifest.json` версии `957118e6aeaed6c9`,
  карты: canopy, garden, overpass, pool mini, terraces;
- `npx vimp-contract --strict` — **37 passed, 0 failed** (0 error, 0 warning),
  0 skipped (плана ждал 36/36; проверок в контракте стало на одну больше);
- `npm run sim:scenarios` — **all 12 scenario(s) green**, код выхода 0.

4. Связать репозитории на время работы: в `T core/Cargo.toml` добавить

```toml
[patch.crates-io]
vimp-engine-core = { path = "/Users/dmitry/Sites/my/vimp/packages/engine/core" }
```

   и, если нужен локальный движок в JS — `npm link vimp-engine`.
   **Оба снимаются на этапе 6.**

   **Отклонение от плана.** `[patch.crates-io]` положен не в
   `T core/Cargo.toml`, а в корневой `T Cargo.toml`. Причина: `core` —
   member воркспейса, и cargo такой патч молча игнорирует с предупреждением
   «patch for the non root package will be ignored, specify patch at the
   workspace root». В корне патч применяется: `cargo metadata` пишет
   `Adding vimp-engine-core v0.15.0 (/Users/dmitry/Sites/my/vimp/packages/engine/core)`,
   `Cargo.lock` обновлён. На этапе 6 снимать из корневого `Cargo.toml`.

   `npm link vimp-engine` уже стоял: `node_modules/vimp-engine ->
   ../../vimp/packages/engine`.

   После подключения патча `npm run core:test` перепрогнан — те же
   **238 + 45 passed**, 0 failed.

Критерий этапа: все команды зелёные, числа записаны.

