import { Container } from 'pixi.js';

const warmedUpRenderers = new WeakSet();

// PixiJS v8's RenderTargetSystem binds its root render target lazily, on
// the renderer's first render() call. Baking runs right after app.init(),
// before the engine's ticker has produced that first frame, so
// generateTexture() on a display object with .filters crashes deep inside
// the filter pipeline (RenderTargetSystem.getGpuRenderTarget reads .uid off
// a null target). Doing one throwaway render forces that lazy setup.
export default function warmUpRenderer(renderer) {
  if (warmedUpRenderers.has(renderer)) {
    return;
  }

  renderer.render(new Container());
  warmedUpRenderers.add(renderer);
}
