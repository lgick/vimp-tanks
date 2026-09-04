import { Container, Graphics, Rectangle, Text } from 'pixi.js';
import { LEVEL_COLORS } from '../levelColors.js';

// создаёт значок уровня для СВОЕГО танка: кружок в цвете уровня с его
// номером. Печётся по одной текстуре на уровень (индекс массива = уровень),
// потому что уровень меняется на лету, а Text в каждом кадре — это заново
// растеризованный шрифт
//
// params.radius - радиус кружка
// params.fontSize - размер цифры (векторное качество, масштаб даёт парт)
// params.borderWidth - толщина обводки
// params.borderColor - цвет обводки
// params.textColor - цвет цифры
// renderer - PIXI рендерер
export default function levelBadgeTexture(params, renderer) {
  const { radius, fontSize, borderWidth, borderColor, textColor } = params;
  const size = (radius + borderWidth) * 2;
  const center = size / 2;

  return LEVEL_COLORS.map((color, level) => {
    const container = new Container();
    const graphics = new Graphics();

    graphics
      .circle(center, center, radius)
      .fill(color)
      .stroke({ width: borderWidth, color: borderColor });

    const label = new Text({
      text: `${level}`,
      style: { fontFamily: 'Arial', fontSize, fill: textColor },
    });

    label.anchor.set(0.5);
    label.x = center;
    label.y = center;

    container.addChild(graphics, label);

    const texture = renderer.generateTexture({
      target: container,
      frame: new Rectangle(0, 0, size, size),
    });

    container.destroy({ children: true });

    return texture;
  });
}
