import { defineConfig } from 'vitest/config';

// Конфигурация Vitest для @vimp/tanks (перенесено из монорепо движка,
// Этап A3 плана отделения движка). Два проекта:
//   - tanks:       игровые модули (host-плагин, ClientPlugin) в happy-dom
//   - integration: интеграция поверх реального Rust-ядра
//                   (tests/host/HostGame.test.js + tests/core/**;
//                   пропускается, если core/pkg-node не собран —
//                   см. npm run core:build)
export default defineConfig({
  test: {
    globals: true,

    projects: [
      {
        extends: true,
        test: {
          name: 'tanks',
          environment: 'happy-dom',
          include: [
            'tests/host/hostPlugin.test.js',
            'tests/host/botCommand.test.js',
            'tests/host/TanksBotManager.test.js',
            'tests/client/tanksClientPlugin.test.js',
            'tests/config/**/*.test.js',
          ],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          environment: 'node',
          include: ['tests/host/HostGame.test.js', 'tests/core/**/*.test.js'],
        },
      },
    ],

    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.js'],
      exclude: [
        '**/_*/**', // игнорируемые директории (префикс _)
        '**/_*.js', // игнорируемые файлы (префикс _)
        '**/index.js', // ре-экспорты
        'src/data/**', // статические игровые данные (карты, баланс)
      ],
    },
  },
});
