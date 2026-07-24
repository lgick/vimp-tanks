import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import noConsecutiveCapsPlugin from 'eslint-plugin-no-consecutive-caps';
import globals from 'globals';

export default [
  // базовые рекомендованные правила ESLint
  js.configs.recommended,

  // отключение правил ESLint, конфликтующих с Prettier
  eslintConfigPrettier,

  {
    plugins: {
      'no-consecutive-caps': noConsecutiveCapsPlugin,
    },
  },

  // конфиги корня (vite.config.js, eslint.config.js, скрипты сборки)
  {
    files: ['*.js', '*.cjs', '*.mjs', 'scripts/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.es2023,
        ...globals.node,
      },
    },
    rules: {
      'no-console': 'off',
    },
  },

  // исходники игры: браузер (client/) + Worker/Node (host/) + данные/конфиг
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.es2023,
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      'no-console': 'off',
    },
  },

  // конфигурация для тестов (Vitest)
  {
    files: ['tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.browser,
        // глобалы Vitest (globals: true в vitest.config.js)
        describe: 'readonly',
        it: 'readonly',
        expect: 'readonly',
        vi: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
    },
  },

  // общие правила для всего проекта
  {
    rules: {
      'no-unused-vars': 'off',
      eqeqeq: ['error', 'always'],
      curly: ['error', 'all'],
      'no-else-return': 'warn',
      'no-var': 'error',
      'prefer-const': 'warn',
      'object-shorthand': ['warn', 'properties'],
      'arrow-body-style': ['warn', 'as-needed'],
      camelcase: 'error',
      'no-consecutive-caps/no-consecutive-caps': [
        'error',
        { exceptions: ['VX', 'VY', 'RTT', 'URL', 'RTC', 'URI'] },
      ],
    },
  },

  // игнорируемые файлы и директории
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'build/**',
      'core/pkg-node/**', // сгенерированный wasm-pack glue (nodejs)
      'core/pkg-web/**', // сгенерированный wasm-pack glue (web)
      'target/**', // артефакты cargo
      'src/data/maps/json/**', // сгенерированные JSON-карты (maps:export)
      '**/.*',
      '**/_*',
    ],
  },
];
