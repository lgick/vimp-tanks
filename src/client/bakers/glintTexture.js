import { Graphics, BlurFilter, Rectangle } from 'pixi.js';
import blurMargin, { blurPadding } from './blurMargin.js';

// Засвет: градиент «край → центр» в квадрате `2 · radius`. Ярче всего у
// края `+x`, к центру сходит на нет, левая половина пустая. Потребитель
// поворачивает `+x` к источнику и режет блик силуэтом предмета (маска),
// цвет и силу даёт tint/alpha.
// params.radius - полуразмер квадрата, params.strips - полос градиента,
// params.blur - против ступеней
// возвращает { texture, contentSize } — contentSize: сторона квадрата
export default function glintTexture(params, renderer) {
  const { radius, strips = 16, blur = 2, quality = 10 } = params;
  const graphics = new Graphics();
  const margin = blurMargin(blur);
  const textureSize = (radius + margin) * 2;
  const center = textureSize / 2;

  // полосы-прямоугольники не перекрываются: прозрачность каждой точная
  for (let i = 0; i < strips; i += 1) {
    const x0 = (radius * i) / strips;
    const x1 = (radius * (i + 1)) / strips;
    const t = (i + 0.5) / strips;

    graphics.rect(center + x0, center - radius, x1 - x0, radius * 2);
    graphics.fill({ color: 0xffffff, alpha: t * t });
  }

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
