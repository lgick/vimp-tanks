import { Graphics, BlurFilter, Rectangle } from 'pixi.js';
import blurMargin from './blurMargin.js';

// Тень танка — СИЛУЭТ корпуса, а не круг: круглая тень с мягким ореолом
// вылезала из-под углов вращающегося корпуса и читалась как серый кружок
// рядом с машиной.
//
// params.width - длина фигуры (вдоль курса), в пропорции корпуса
// params.height - ширина фигуры (поперёк курса)
// params.radius - скругление углов
// params.blur - сила размытия (мягкий край, а не второй силуэт)
// params.color - цвет заливки
// params.quality - количество проходов размытия
// renderer - PIXI рендерер
// возвращает { texture, contentSize }, где contentSize - ЧЁТКАЯ длина
// фигуры: по ней потребитель нормирует масштаб, чтобы запас под размытие
// не влиял на видимый размер (тот же контракт, что у blurredCircleTexture)
export default function tankShadowTexture(params, renderer) {
  const { width, height, radius, blur, color, quality = 20 } = params;
  const graphics = new Graphics();
  const margin = blurMargin(blur);
  const textureWidth = width + margin * 2;
  const textureHeight = height + margin * 2;

  graphics.roundRect(margin, margin, width, height, radius);
  graphics.fill(color);

  const filter = new BlurFilter({ strength: blur, quality });

  // без явного padding Pixi рендерит размытие лишь на 2 * strength вокруг
  // фигуры и обрезает его раньше рамки, каким бы большим ни был холст
  filter.padding = margin;
  graphics.filters = [filter];

  const texture = renderer.generateTexture({
    target: graphics,
    frame: new Rectangle(0, 0, textureWidth, textureHeight),
  });

  graphics.destroy(true);

  return { texture, contentSize: width };
}
