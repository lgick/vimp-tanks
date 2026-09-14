import { describe, it, expect, vi } from 'vitest';
import {
  getNeonTextures,
  releaseNeonTextures,
} from '../../../../src/client/parts/map/neonCache.js';

// у happy-dom нет 2d-контекста для измерения текста: Text подменён
// контейнером фиксированного размера
vi.mock('pixi.js', async importOriginal => {
  const pixi = await importOriginal();

  class Text extends pixi.Container {
    get width() {
      return 60;
    }

    get height() {
      return 20;
    }
  }

  return { ...pixi, Text };
});

// Кэш неоновых текстур со счётчиком ссылок: на нуле текстуры уходят, и
// следующее взятие запекает их заново (восстановление WebGL-контекста).
describe('neonCache', () => {
  const makeRenderer = () => ({
    generateTexture: vi.fn(() => ({ destroy: vi.fn() })),
  });

  const spec = { text: 'HOTEL', color: 0xff3ad0, size: 18 };

  it('одинаковый текст и размер делят текстуры; цвет в ключ не входит', () => {
    const renderer = makeRenderer();
    const a = getNeonTextures(renderer, spec);
    const b = getNeonTextures(renderer, { ...spec, color: 0x00ff00 });

    expect(a.core).toBe(b.core);
    expect(a.glow).toBe(b.glow);
    // ядро и ореол — два снимка одного текста
    expect(renderer.generateTexture).toHaveBeenCalledTimes(2);

    releaseNeonTextures(renderer, spec);
    releaseNeonTextures(renderer, spec);
  });

  it('acquire → release all → acquire генерирует текстуру заново', () => {
    const renderer = makeRenderer();
    const first = getNeonTextures(renderer, spec);

    getNeonTextures(renderer, spec);
    releaseNeonTextures(renderer, spec);

    expect(first.core.destroy).not.toHaveBeenCalled();

    releaseNeonTextures(renderer, spec);

    expect(first.core.destroy).toHaveBeenCalledWith(true);
    expect(first.glow.destroy).toHaveBeenCalledWith(true);

    const second = getNeonTextures(renderer, spec);

    expect(second.core).not.toBe(first.core);
    expect(renderer.generateTexture).toHaveBeenCalledTimes(4);

    releaseNeonTextures(renderer, spec);
  });

  it('лишний release не падает', () => {
    expect(() => releaseNeonTextures(makeRenderer(), spec)).not.toThrow();
  });
});
