import { Graphics, BlurFilter, Rectangle } from 'pixi.js';
import blurMargin from './blurMargin.js';
import { drawRadialRings } from './lightRadialTexture.js';

// Голова фонаря (и блик фары): маленький яркий диск с ореолом. Эмиссив —
// рисуется поверх затемнения аддитивно, цвет даёт tint.
// params.core - радиус яркого диска, params.halo - радиус ореола,
// params.rings - колец ореола, params.blur - мягкость
// возвращает { texture, contentSize } — contentSize: диаметр ореола
export default function lampHeadTexture(params, renderer) {
  const { core, halo, rings = 12, blur = 1, quality = 10 } = params;
  const graphics = new Graphics();
  const margin = blurMargin(blur);
  const textureSize = (halo + margin) * 2;
  const center = textureSize / 2;
  const coreShare = core / halo;

  // внутри диска — полная яркость, снаружи ореол спадает до нуля
  drawRadialRings(graphics, center, halo, rings, t =>
    t <= coreShare ? 1 : 0.6 * (1 - (t - coreShare) / (1 - coreShare)) ** 2,
  );

  const filter = new BlurFilter({ strength: blur, quality });

  filter.padding = margin;
  graphics.filters = [filter];

  const texture = renderer.generateTexture({
    target: graphics,
    frame: new Rectangle(0, 0, textureSize, textureSize),
  });

  graphics.destroy(true);

  return { texture, contentSize: halo * 2 };
}
