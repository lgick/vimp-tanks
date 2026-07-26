# Локальная настройка (игра-плагин)

Этот репозиторий собирает `@vimp/tanks` — игру-плагин для
[движка VIMP](https://github.com/lgick/vimp-engine). Про локальную
настройку движковой стороны (запуск мастер-сервера, лобби) — см.
[getting-started.md](https://github.com/lgick/vimp-engine/blob/main/docs/ru/getting-started.md)
движка.

## Требования

- **Node.js 24**, npm;
- **Rust-тулчейн** (`rustup` + `wasm-pack`) — обязателен для сборки
  WASM-ядра этого плагина, которое грузят браузерный хост движка и каждый
  клиент.

## Установка

```bash
git clone https://github.com/lgick/vimp-tanks.git
cd vimp-tanks
npm install
```

`vimp-engine` здесь — обычная npm-зависимость (не workspace-симлинк) —
этот плагин импортирует только публичную поверхность его `exports`
(`./lib/*`, `./config/*`, `./host/*`).

## Rust-тулчейн

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   # rustc + cargo
rustup target add wasm32-unknown-unknown
brew install wasm-pack        # или: cargo install wasm-pack
```

## Сборка

```bash
npm run core:build       # оба WASM-таргета (web + nodejs)
npm run core:build:web   # браузер/Worker → core/pkg-web/
npm run core:build:node  # Node.js (тесты) → core/pkg-node/
npm run core:test        # cargo test --workspace (crate этого репозитория)
npm run build            # полная сборка плагина: JS-бандлы client+host, ассеты, manifest.json → dist/
```

`npm run build` производит `dist/manifest.json` (`GameManifest`),
JS-бандлы клиента/хоста, экспортированный JSON карт и обработанные
звуковые ассеты (`npm run audio:process`, нужен ffmpeg) — всё, что мастер
движка отдаёт под `/games/tanks/*` и что динамически импортируют Worker
хоста/клиент.

## Игра локально против локальной копии движка

Чтобы разрабатывать против локальной, неопубликованной копии этого
плагина:

```bash
# в vimp-tanks/
npm run build          # или минимум npm run core:build + build:client + build:host
npm link                # регистрирует @vimp/tanks глобально

# в vimp-engine/
npm link @vimp/tanks    # или: "@vimp/tanks": "file:../vimp-tanks" в package.json
npm run dev
```

Затем откройте несколько вкладок браузера на дев-сервере движка — одна
создаёт комнату, остальные заходят из лобби. См.
[getting-started.md](https://github.com/lgick/vimp-engine/blob/main/docs/ru/getting-started.md#локальный-мультиплеер)
движка.

Ботов удобно добавлять чат-командой `/bot 5` (см.
[gameplay.md](gameplay.md#чат-клавиша-c-и-команды)).

## Тесты

Стек: **Vitest** + happy-dom + coverage-v8. `vitest.config.js` делит
прогон на два проекта:

- `tanks` — `tests/host/{hostPlugin,botCommand,TanksBotManager}.test.js`,
  `tests/client/tanksClientPlugin.test.js`, `tests/config/**` (окружение
  happy-dom);
- `integration` — `tests/host/HostGame.test.js` + `tests/core/**`
  (реальное ядро, окружение node; **пропускается**, если `core/pkg-node/`
  не собран).

Тесты лежат в `tests/` и зеркалят `src/`. JS↔WASM харнесс Rust-ядра —
`tests/core/` (см. [core.md](core.md)). Правило проекта: **любое
изменение кода завершается зелёными `npx eslint .` и `npm test`**; при
правке движения в ядре или `models.js` обязателен cargo-паритет реплики
предикта (`npm run core:test`).

CI (`.github/workflows/test.yml`) гоняет два job'а: `lint` (только
eslint); `tanks` (`cargo test -p vimp-tanks-core` + `core:build:web` +
`core:build:node` + оба Vitest-проекта — `vimp-engine` здесь ставится из
npm registry, а не из workspace-симлинка).

---

[Следующая: Архитектура →](architecture.md)
