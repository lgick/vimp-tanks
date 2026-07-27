import { describe, it, expect, vi } from 'vitest';
import warmUpRenderer from '../../src/client/bakers/warmUpRenderer.js';

// Регресс: PixiJS v8 биндит корневой render target лениво, при первом
// renderer.render(). Бейкинг ассетов (generateTexture с .filters) идёт до
// первого тика — без прогрева RenderTargetSystem.getGpuRenderTarget падает
// на null.uid внутри filter-пайплайна.
describe('warmUpRenderer', () => {
  it('рендерит один раз для данного рендерера', () => {
    const renderer = { render: vi.fn() };

    warmUpRenderer(renderer);
    warmUpRenderer(renderer);

    expect(renderer.render).toHaveBeenCalledTimes(1);
  });

  it('прогревает независимо разные рендереры', () => {
    const rendererA = { render: vi.fn() };
    const rendererB = { render: vi.fn() };

    warmUpRenderer(rendererA);
    warmUpRenderer(rendererB);

    expect(rendererA.render).toHaveBeenCalledTimes(1);
    expect(rendererB.render).toHaveBeenCalledTimes(1);
  });
});
