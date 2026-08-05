import { describe, it, expect } from 'vitest';
import { isNodeCore } from '../../src/nodeCore.js';

// Ветка выбора ядра общая для обеих половин плагина: ошибка здесь уводит
// headless-прогон на другую сборку ядра, чем браузер.

describe('isNodeCore', () => {
  it('file:-URL nodejs-глюe — это node-ядро', () => {
    expect(isNodeCore('file:///games/tanks/core-node/vimp_tanks_core.js')).toBe(
      true,
    );
  });

  it('.wasm-ассет браузера — нет', () => {
    expect(isNodeCore('/games/tanks/assets/vimp_tanks_core_bg.wasm')).toBe(
      false,
    );
  });

  it('кэш-бастер в URL не ломает определение', () => {
    expect(isNodeCore('/games/tanks/core-node/vimp_tanks_core.js?v=1')).toBe(
      true,
    );
    expect(isNodeCore('/games/tanks/assets/core_bg.wasm?v=1')).toBe(false);
  });

  it('отсутствие URL — это браузерный путь', () => {
    expect(isNodeCore(undefined)).toBe(false);
  });
});
