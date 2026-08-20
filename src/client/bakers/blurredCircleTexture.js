import { Graphics, BlurFilter, Rectangle } from 'pixi.js';
import blurMargin from './blurMargin.js';

// создаёт текстуру размытого круга (взрыв, дым, частицы попаданий)
// params.radius - Радиус круга
// params.blur - Сила размытия
// params.color - Цвет заливки (белый - для последующего tint'а)
// params.quality - Количество проходов размытия
// renderer - PIXI рендерер
// возвращает { texture, contentSize }, где contentSize - диаметр самого круга:
// по нему потребители нормируют масштаб, чтобы запас под размытие
// не влиял на видимый размер
export default function blurredCircleTexture(params, renderer) {
  const { radius, blur, color, quality = 40 } = params;
  const graphics = new Graphics();

  // круг остаётся радиусом radius, вокруг него - прозрачный запас под размытие
  const textureSize = (radius + blurMargin(blur)) * 2;
  const center = textureSize / 2;

  graphics.circle(center, center, radius);
  graphics.fill(color);

  const filter = new BlurFilter({ strength: blur, quality });

  // без явного padding Pixi рендерит размытие лишь на 2 * strength вокруг
  // фигуры и обрезает его раньше рамки, каким бы большим ни был холст
  filter.padding = blurMargin(blur);
  graphics.filters = [filter];

  const texture = renderer.generateTexture({
    target: graphics,
    frame: new Rectangle(0, 0, textureSize, textureSize),
  });

  graphics.destroy(true);

  return { texture, contentSize: radius * 2 };
}
