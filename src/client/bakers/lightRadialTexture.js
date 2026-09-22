import { Graphics, BlurFilter, Rectangle } from 'pixi.js';
import blurMargin, { blurPadding } from './blurMargin.js';

// Кольца радиального спада: `rings` непересекающихся колец от центра к
// краю, прозрачность каждого — по функции `alphaAt(t)`, где `t` — доля
// радиуса середины кольца. Кольца не перекрываются, поэтому прозрачность
// точная, а лёгкое размытие поверх убирает ступени
export function drawRadialRings(graphics, center, radius, rings, alphaAt) {
  for (let i = 0; i < rings; i += 1) {
    const inner = (radius * i) / rings;
    const outer = (radius * (i + 1)) / rings;
    const alpha = alphaAt((i + 0.5) / rings);

    if (alpha <= 0) {
      continue;
    }

    graphics.circle(center, center, outer);
    graphics.fill({ color: 0xffffff, alpha });

    if (inner > 0) {
      graphics.circle(center, center, inner);
      graphics.cut();
    }
  }
}

// Радиальное пятно света: белый центр, плавный спад к прозрачному краю без
// жёсткой кромки. Цвет и силу даёт tint/alpha источника.
// params.radius - радиус пятна, params.rings - колец спада,
// params.blur - размытие против ступеней
// возвращает { texture, contentSize } — contentSize: диаметр пятна
export default function lightRadialTexture(params, renderer) {
  const { radius, rings = 32, blur = 2, quality = 10 } = params;
  const graphics = new Graphics();
  const margin = blurMargin(blur);
  const textureSize = (radius + margin) * 2;
  const center = textureSize / 2;

  // спад (1 - t)² — свет сходит на нет к краю, центр не пересвечен плато
  drawRadialRings(graphics, center, radius, rings, t => (1 - t) * (1 - t));

  const filter = new BlurFilter({ strength: blur, quality });

  // область фильтра шире рамки: мусор пула с края не попадёт в текстуру
  filter.padding = blurPadding(blur);
  graphics.filters = [filter];

  const texture = renderer.generateTexture({
    target: graphics,
    frame: new Rectangle(0, 0, textureSize, textureSize),
  });

  graphics.destroy(true);

  return { texture, contentSize: radius * 2 };
}
