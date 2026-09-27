import { Graphics } from 'pixi.js';
import blurMargin from './blurMargin.js';
import bakeBlurred from './bakeBlurred.js';
import { coneProfile } from '../lighting/lightMath.js';

// Конус фары: клин от вершины к широкому концу, яркость спадает по длине,
// края мягкие (размытие). Вершина — в точке (margin, середина высоты), то
// есть на нормированной оси это (0, 0.5) содержимого; потребитель ставит
// якорь в неё.
// params.length - длина клина, params.halfWidth - полуширина на конце,
// params.strips - полос спада по длине, params.blur - мягкость краёв
// возвращает { texture, length, halfWidth, margin }
export default function headlightConeTexture(params, renderer) {
  const { length, halfWidth, strips = 24, blur = 4, quality = 10 } = params;
  const graphics = new Graphics();
  const margin = blurMargin(blur);
  const width = length + margin * 2;
  const height = (halfWidth + margin) * 2;
  const apexX = margin;
  const apexY = height / 2;

  // полосы-трапеции не перекрываются: прозрачность каждой точная
  for (let i = 0; i < strips; i += 1) {
    const x0 = (length * i) / strips;
    const x1 = (length * (i + 1)) / strips;
    const h0 = (halfWidth * i) / strips;
    const h1 = (halfWidth * (i + 1)) / strips;
    const t = (i + 0.5) / strips;
    // яркий у фары, к концу луча сходит на нет
    const alpha = coneProfile(t);

    graphics.poly([
      apexX + x0,
      apexY - h0,
      apexX + x1,
      apexY - h1,
      apexX + x1,
      apexY + h1,
      apexX + x0,
      apexY + h0,
    ]);
    graphics.fill({ color: 0xffffff, alpha });
  }

  const texture = bakeBlurred(renderer, graphics, {
    blur,
    quality,
    width,
    height,
  });

  return { texture, length, halfWidth, margin };
}
