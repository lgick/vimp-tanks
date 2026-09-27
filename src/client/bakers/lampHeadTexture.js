import { Graphics } from 'pixi.js';
import blurMargin from './blurMargin.js';
import bakeBlurred from './bakeBlurred.js';
import { drawRadialRings } from './lightRadialTexture.js';

// Голова фонаря: маленький яркий диск с ореолом. Рисуется аддитивно под
// танком (светильник в асфальте), цвет даёт tint.
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

  const texture = bakeBlurred(renderer, graphics, {
    blur,
    quality,
    width: textureSize,
    height: textureSize,
  });

  return { texture, contentSize: halo * 2 };
}
