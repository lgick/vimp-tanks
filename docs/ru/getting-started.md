# Локальная настройка (игра-плагин)

Этот репозиторий собирает `@vimp-games/tanks` — игру-плагин для
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

`pixi.js` — **peer-зависимость**, не вшивается в бандл: client-сборка
экстернализирует его (`vite.config.js`), и в рантайме он обязан
резолвиться в тот же экземпляр модуля, что использует движок — через
import map на host-странице. Две независимые копии PixiJS (движок и
плагин, каждый со своей вшитой копией) падают в рантайме: у каждой копии
свой реестр расширений/пайпов и свои счётчики uid, объекты одной копии
(например, `Container`/`Filter` из baker'ов этого плагина) не валидны для
рендерера другой. Сам import map настраивается на стороне движка — см. его
[client.md](https://github.com/lgick/vimp-engine/blob/main/docs/ru/client.md).

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
хоста/клиент. Если собран `core/pkg-node/`, `build:manifest` дополнительно
копирует его в `dist/core-node/` и объявляет `entries.wasmNode` на эту
копию: публикуется только `dist`, поэтому манифест с путём наружу работал
бы в чекауте и ломался в установленном пакете (`npm run check:pack`
страхует это и висит на `prepack`).

## Игра локально (`npm run dev`)

Самый короткий цикл не требует ни чекаута движка, ни мастера:
[standalone SDK](https://github.com/lgick/vimp-engine/blob/main/docs/ru/standalone.md)
движка крутит авторитетный хост, клиент и этот плагин в одной вкладке
браузера — без экрана лобби и без OAuth.

```bash
npm run core:build      # WASM (для dev нужен только core/pkg-web/)
npm run audio:process   # звуки → build/sounds/ (нужен ffmpeg; необязательно)
npm run dev             # dev-сервер Vite, открывает вкладку
```

Вкладка входит гостем (`Tanker`, ник переопределяется в
`localStorage.vimp_dev_nick`), голосует за `team1` и просит четырёх ботов —
все опции лежат в `index.html` и `src/standalone.js`
(`startStandaloneGame`, карта, `assetsBase`). Звуки берутся из `/build/`,
поэтому без `npm run audio:process` они просто молчат; матч работает в
любом случае. WebRTC в этом режиме не используется вовсе.

`npm run build` здесь **не** нужен: Vite отдаёт `src/**` и
`core/pkg-web/*.wasm` напрямую. Сборка плагина и `dist/` нужны только для
контура с мастером ниже.

## Игра локально против локальной копии движка

Чтобы разрабатывать против локальной, неопубликованной копии этого
плагина, соберите его один раз и свяжите оба чекаута **друг с другом**:

```bash
cd vimp-tanks && npm run core:build && npm run build   # WASM + dist/ (манифест, карты, звуки)

cd vimp-tanks && npm link                     # регистрирует @vimp-games/tanks глобально
cd vimp-engine/packages/engine && npm link    # регистрирует vimp-engine глобально

cd vimp-engine && npm link @vimp-games/tanks  # движок ← плагин
cd vimp-tanks && npm link vimp-engine         # плагин ← движок

cd vimp-engine && npm run dev
```

Обратный линк важен не меньше прямого: без него импорты `vimp-engine/*` из
этого плагина резолвятся в registry-копию внутри его собственного
`node_modules` — второй экземпляр модулей со своим, молча разъезжающимся
`ENGINE_API_VERSION`. Учтите, что `npm install` в любом из репозиториев
заменяет симлинки registry-копиями, поэтому две команды `npm link <имя>`
после установки нужно повторить.

В dev движок отдаёт `src/**` и `core/pkg-web/*.wasm` этого плагина напрямую
через Vite `/@fs/` (HMR), поэтому правки JS клиента/хоста вообще не требуют
пересборки; `dist/` всё равно читается один раз при старте мастера — ради
манифеста, карт и звуков, отсюда начальный `npm run build`. Полный разбор,
что пересобирать после какой правки — в
[getting-started.md](https://github.com/lgick/vimp-engine/blob/main/docs/ru/getting-started.md#цикл-разработки)
движка.

С `pixi.js` в dev тоже ничего настраивать не нужно: Vite резолвит
bare-специфер `pixi.js` из этого плагина в ту же оптимизированную копию,
которой пользуется сам движок. Import map (см. «Установку» выше) держит эту
гарантию единственного экземпляра в прод-сборках.

Затем откройте несколько вкладок браузера на дев-сервере движка — одна
создаёт комнату, остальные заходят из лобби (учтите: все вкладки одного
профиля браузера делят identity-токен, то есть это один и тот же игрок). См.
[getting-started.md](https://github.com/lgick/vimp-engine/blob/main/docs/ru/getting-started.md#локальный-мультиплеер)
движка.

Ботов удобно добавлять чат-командой `/bot 5` (см.
[gameplay.md](gameplay.md#чат-клавиша-c-и-команды)).

## Тесты

Стек: **Vitest** + happy-dom + coverage-v8. `vitest.config.js` делит
прогон на два проекта:

- `tanks` — `tests/host/{hostPlugin,botCommand,TanksBotManager}.test.js`,
  `tests/client/**` (`tanksClientPlugin.test.js`, `parts/**` — звуковой
  контракт `Tank`/`Bomb`), `tests/config/**`,
  `tests/scripts/**` (хелперы build-скриптов, напр.
  `tests/scripts/rangeToPattern.test.js`) — окружение happy-dom;
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

## Отладочные сценарии (headless-матч)

В движке есть headless-раннер (`vimp-sim`): он замыкает контур
«хост → бинарный кадр → `ClientCore` → hot-буфер → сцена» в одном
Node-процессе и проверяет 12 контрактов. Нужен собранный плагин — `dist/` с
`entries.wasmNode`, то есть `core/pkg-node/`, собранный **до**
`npm run build`, который копирует его в `dist/core-node/`:

```bash
npm run core:build:node          # node-сборка ядра → core/pkg-node/
npm run build                    # dist/ + manifest.json (копирует dist/core-node/)
npm run sim:scenarios            # все tests/scenarios/*.json, один вердикт
npm run sim:scenarios -- --determinism   # + совпадающий повтор (хеши кадров)
npm run sim -- --scenario tests/scenarios/movement.json   # один сценарий
```

Код возврата и есть вердикт, поэтому это рабочий цикл после правок
движения, снапшот-схемы или панели. Сценарии:

| Файл | Что покрывает |
| --- | --- |
| `movement.json` | езда, повороты, башня; дрейф предикта с тугими порогами |
| `combat.json` | двое игроков, оба оружия, взрывы, карта с динамикой (`c1`) |
| `round.json` | боты, friendly fire, смерть → конец раунда → респаун (инвариант 10) |

Калибровка порогов и формат сценария — в
[debugging.md](https://github.com/lgick/vimp-engine/blob/main/docs/ru/debugging.md)
движка.

Раннер крутит **настоящее** ядро, поэтому ему нужна та же версия
`vimp-engine-core`, что и сборке движка. При работе с локальным чекаутом
движка патчите cargo локально — коммитить это **нельзя**:

```toml
# Cargo.toml, корень workspace
[patch.crates-io]
vimp-engine-core = { path = "../vimp/packages/engine/core" }
```

---

[Следующая: Архитектура →](architecture.md)
