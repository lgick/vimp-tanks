# Техническое задание: Реализация автономного запуска (`npm run dev`) в `vimp-tanks`

## 1. Контекст и цель

Репозиторий `vimp-tanks` (`@vimp-games/tanks`) является плагином игры «Танки» для движка `vimp-engine`.
Ранее запуск игры локально требовал обязательного клонирования репозитория движка `vimp-engine`, настройки `npm link` и запуска мастер-сервера с экраном лобби и авторизацией.

**Цель доработки**:

1. Сделать репозиторий `vimp-tanks` полностью самодостаточным для локальной разработки: команда `npm run dev` в папке `vimp-tanks` должна открывать браузер с работающей одиночной игрой с ботами (без скачивания репозитория `vimp-engine`, без мастер-сервера и без авторизации).
2. Сохранить полную совместимость с существующей сборкой плагина (`npm run build`), чтобы игра по-прежнему могла собираться в `dist/` и подключаться в `vimp-engine` как динамический плагин для общего лобби или Dedicated Server.

> **Предусловие**: В пакете `vimp-engine` уже реализован `vimp-engine/standalone` (функция `startStandaloneGame`) и экспортирован базовый CSS (`vimp-engine/style.css`).

---

## 2. Структура изменений в `vimp-tanks`

```
vimp-tanks/
├── index.html                   <-- [НОВЫЙ] HTML-каркас для Vite dev-сервера
├── src/
│   └── standalone.js            <-- [НОВЫЙ] Точка входа автономного запуска игры
├── vite.config.js               <-- [ИЗМЕНЕНИЕ] Разделение режимов: dev-сервер vs build плагина
├── package.json                 <-- [ИЗМЕНЕНИЕ] Добавление скрипта "dev": "vite"
└── docs/en/getting-started.md   <-- [ИЗМЕНЕНИЕ] Обновление инструкции по локальному запуску
```

---

## 3. Пошаговый план реализации

---

### ЭТАП 1: Создание HTML-каркаса и точки входа Standalone

#### Задача 1.1: Создать `index.html` в корне проекта

Создать файл `index.html`, который Vite будет использовать как точку входа при запуске локального dev-сервера:

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>VIMP Tanks (Standalone Dev)</title>
    <!-- Базовые стили HUD и UI движка -->
    <link
      rel="stylesheet"
      href="./node_modules/vimp-engine/src/client/style.css" />
    <!-- Игровые стили танков, панелей и цветов команд -->
    <link rel="stylesheet" href="./src/client/tanks.css" />
    <style>
      body,
      html {
        margin: 0;
        padding: 0;
        width: 100%;
        height: 100%;
        overflow: hidden;
        background-color: #111;
        font-family: monospace;
      }
      #game-container {
        width: 100%;
        height: 100%;
        position: relative;
      }
    </style>
  </head>
  <body>
    <div id="game-container"></div>
    <script type="module" src="/src/standalone.js"></script>
  </body>
</html>
```

---

#### Задача 1.2: Создать `src/standalone.js`

Создать скрипт инициализации игры в автономном режиме:

```javascript
import { startStandaloneGame } from 'vimp-engine/standalone';
import hostPlugin from './host/index.js';
import clientPlugin from './client/index.js';

// Импорт URL скомпилированного WASM-файла для браузера через Vite
import wasmUrl from '../core/pkg-web/vimp_tanks_core_bg.wasm?url';

const container = document.getElementById('game-container') || document.body;

// Автоматический запуск игры с локальной симуляцией в Web Worker
startStandaloneGame({
  hostPlugin,
  clientPlugin,
  wasmUrl,
  container,
  playerName: localStorage.getItem('vimp_dev_nick') || 'Tanker',
  playerModel: 'm1',
  bots: 5, // Стартовое количество ботов на карте
  roomConfig: {
    map: 'pool mini',
  },
}).catch(err => {
  console.error('[Standalone] Failed to start game:', err);
});
```

---

### ЭТАП 2: Конфигурация Vite (`vite.config.js`)

#### Задача 2.1: Доработать `vite.config.js`

Файл должен поддерживать два сценария:

1. `vite` (команда `serve` / режим `development`): поднимает локальный сервер для `index.html`.
2. `vite build` (режимы `client` и `host`): собирает бандлы библиотеки плагина в `dist/` как и раньше.

Пример обновленного `vite.config.js`:

```javascript
import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig(({ command, mode }) => {
  // 1. РЕЖИМ ЛОКАЛЬНОГО DEV-СЕРВЕРА (npm run dev)
  if (command === 'serve' || mode === 'development') {
    return {
      server: {
        port: 5173,
        open: true,
        fs: {
          // Разрешаем Vite отдавать файлы из node_modules и папки core/pkg-web
          allow: ['..'],
        },
      },
      optimizeDeps: {
        // Исключаем WASM из предварительного бандлинга
        exclude: ['vimp_tanks_core'],
      },
    };
  }

  // 2. РЕЖИМ СБОРКИ ПЛАГИНА (npm run build:client / build:host)
  const isClient = mode === 'client';
  const isHost = mode === 'host';

  return {
    build: {
      outDir: 'dist',
      emptyOutDir: false,
      lib: {
        entry: isClient
          ? path.resolve(__dirname, 'src/client/index.js')
          : path.resolve(__dirname, 'src/host/index.js'),
        name: isClient ? 'VimpTanksClient' : 'VimpTanksHost',
        fileName: () => (isClient ? 'client.js' : 'host.js'),
        formats: ['es'],
      },
      rollupOptions: {
        // pixi.js не бандлится в плагин, а резолвится как peerDependency
        external: ['pixi.js', 'pixi.js/unsafe-eval'],
      },
    },
  };
});
```

---

### ЭТАП 3: Обновление `package.json`

#### Задача 3.1: Добавить скрипт `"dev"` в `package.json`

В секцию `"scripts"` добавить команду `"dev"`:

```json
{
  "name": "@vimp-games/tanks",
  "version": "0.6.0",
  "scripts": {
    "dev": "vite",
    "build": "rm -rf dist && npm run build:client && npm run build:host && npm run build:assets && npm run build:manifest",
    "build:client": "vite build --mode client",
    "build:host": "vite build --mode host",
    "build:assets": "node ./scripts/export-maps.js && node ./scripts/copy-game-sounds.js",
    "build:manifest": "node ./scripts/build-game-manifest.js",
    "check:pack": "node ./scripts/check-pack.js",
    "prepack": "node ./scripts/check-pack.js",
    "audio:process": "node ./scripts/process-audio.js",
    "core:build": "npm run core:build:web && npm run core:build:node",
    "core:build:web": "wasm-pack build core --release --target web --out-dir pkg-web",
    "core:build:node": "wasm-pack build core --release --target nodejs --out-dir pkg-node",
    "core:test": "cargo test --workspace",
    "test": "vitest run",
    "test:watch": "vitest",
    "sim": "node ./node_modules/vimp-engine/bin/vimp-sim.js --game .",
    "sim:scenarios": "node ./scripts/run-scenarios.js"
  }
}
```

---

### ЭТАП 4: Тестирование и проверка совместимости

#### Задача 4.1: Проверка локального запуска

1. Собрать WASM-ядро: `npm run core:build`.
2. Запустить dev-сервер: `npm run dev`.
3. Убедиться, что:
   - Браузер открывает `http://localhost:5173`.
   - Танк игрока управляется (`W/A/S/D`, поворот башни `K/L`, выстрел `J`, мины `N/P`).
   - 5 ботов появляются на карте и ведут бой.
   - Звуки выстрелов и взрывов воспроизводятся.
   - Панель здоровья/патронов и таблица очков (`Tab`) корректно отображаются.

#### Задача 4.2: Проверка сборки плагина (без регрессий)

1. Выполнить сборку плагина: `npm run build`.
2. Убедиться, что скрипты сборки не сломались и генерируют валидную папку `dist/`:
   - `dist/manifest.json`
   - `dist/client.js`
   - `dist/host.js`
   - `dist/maps/`
   - `dist/sounds/`
   - `dist/core-node/`
3. Запустить проверку пакета: `npm run check:pack`.
4. Запустить тесты симулятора: `npm run sim` и `npm run sim:scenarios`.
5. Запустить тесты Vitest: `npm test`.

---

### ЭТАП 5: Обновление документации

#### Задача 5.1: Обновить `docs/en/getting-started.md`

Заменить старую инструкцию о необходимости связывания через `npm link` с `vimp-engine` на простую автономную инструкцию:

````markdown
## Local Development

To run and develop the game locally in standalone mode:

1. Build the Rust WASM core:
   ```bash
   npm run core:build
   ```
````

2. Start the local standalone development server:

   ```bash
   npm run dev
   ```

   This will open `http://localhost:5173` with a local match running in your browser against bots.

3. To build the plugin for distribution / VIMP Master catalog:
   ```bash
   npm run build
   ```

```

---

## 4. Критерии приемки (Definition of Done)

1. `npm run dev` в корне репозитория `vimp-tanks` успешно запускает игру в браузере без запущенного мастера и без ошибок в консоли.
2. `npm run build` успешно собирает плагин в `dist/` без ошибок валидации `check:pack`.
3. Все тесты `npm test`, `npm run core:test`, `npm run sim` и `npm run sim:scenarios` проходят успешно (100% green).
4. Линтер `npx eslint .` завершается без ошибок.
```
