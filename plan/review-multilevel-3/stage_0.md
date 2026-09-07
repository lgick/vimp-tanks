# Этап 0. Базовая линия и связка репозиториев

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

4. Связать репозитории на время работы: в `T core/Cargo.toml` добавить

```toml
[patch.crates-io]
vimp-engine-core = { path = "/Users/dmitry/Sites/my/vimp/packages/engine/core" }
```

   и, если нужен локальный движок в JS — `npm link vimp-engine`.
   **Оба снимаются на этапе 6.**

Критерий этапа: все команды зелёные, числа записаны.

