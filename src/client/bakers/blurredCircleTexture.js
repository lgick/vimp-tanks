import { Graphics } from 'pixi.js';
import blurMargin from './blurMargin.js';
import bakeBlurred from './bakeBlurred.js';

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

  const texture = bakeBlurred(renderer, graphics, {
    blur,
    quality,
    width: textureSize,
    height: textureSize,
  });

  return { texture, contentSize: radius * 2 };
}
