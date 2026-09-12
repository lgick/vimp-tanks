// Наклон корпуса в 2.5D: углы квада спрайта, повёрнутого по тангажу и
// крену. Отдельный модуль, потому что формула нужна трём мешам танка
// (корпус, пушка, остов) и обязана быть проверяемой без PixiJS.
//
// Наклон — поворот лежащего в плоскости карты квада вокруг локальных осей
// корпуса с последующей ортографической проекцией ТОЙ ЖЕ формулой высоты,
// что и весь 2.5D (`src/client/parallax.js`): точка, поднявшаяся на высоту
// `h`, отъезжает от центра на `h * shear`.

/**
 * Углы квада спрайта, наклонённого по тангажу и крену.
 *
 * @param {object} p
 * @param {number} p.width      ширина спрайта в экранных единицах
 * @param {number} p.height     высота спрайта
 * @param {number} p.anchorX    0..1
 * @param {number} p.anchorY    0..1
 * @param {number} p.rotation   собственный поворот спрайта (пушка), рад
 * @param {number} p.pitch      продольный наклон, рад
 * @param {number} p.roll       поперечный наклон, рад
 * @param {number} p.shear      parallax.shear
 * @param {number} p.lift       экранный подъём поднявшегося края, доля
 *   его высоты
 * @returns {number[]} [x0,y0, x1,y1, x2,y2, x3,y3] — левый верх, правый
 *   верх, правый низ, левый низ: порядок, которого ждёт
 *   `PerspectiveMesh.setCorners`
 */
export function tiltCorners({
  width,
  height,
  anchorX,
  anchorY,
  rotation,
  pitch,
  roll,
  shear,
  lift,
}) {
  const u0 = -anchorX * width;
  const u1 = (1 - anchorX) * width;
  const v0 = -anchorY * height;
  const v1 = (1 - anchorY) * height;

  // обход по часовой: левый верх → правый верх → правый низ → левый низ
  const quad = [
    [u0, v0],
    [u1, v0],
    [u1, v1],
    [u0, v1],
  ];

  const cosR = Math.cos(rotation);
  const sinR = Math.sin(rotation);
  const cosP = Math.cos(pitch);
  const sinP = Math.sin(pitch);
  const cosB = Math.cos(roll);
  const sinB = Math.sin(roll);

  const out = [];

  for (const [su, sv] of quad) {
    // собственный поворот спрайта (пушка): наклон идёт по осям КОРПУСА,
    // поэтому поворот применяется первым
    const u = su * cosR - sv * sinR;
    const v = su * sinR + sv * cosR;

    // тангаж вокруг локального X (поперёк корпуса): экранный `+v` — это
    // «назад», а поднимается нос, отсюда минус у высоты
    const vp = v * cosP;
    const h1 = -v * sinP;

    // крен вокруг локального Y (вдоль корпуса)
    const up = u * cosB;
    const h2 = u * sinB;

    // высота точки в ЭКРАННЫХ единицах и её доля в высоте спрайта,
    // переведённая в тот же безразмерный сдвиг, которым живёт весь 2.5D
    const h = h1 + h2;
    const k = height ? (h / height) * shear : 0;

    // `lift` — насколько поднявшаяся часть корпуса уезжает вверх по
    // экрану: без него наклон читается только сжатием и выглядит как
    // «сплющивание»
    out.push(up * (1 + k), vp * (1 + k) - h * lift);
  }

  return out;
}

/**
 * Множитель яркости корпуса по его наклону. Наклон поворачивает нормаль
 * корпуса; её проекция на направление света и есть яркость. Функция
 * чистая и не знает про PixiJS — числа приходят параметрами.
 *
 * @param {object} p
 * @param {number} p.angle    курс корпуса, рад
 * @param {number} p.pitch    продольный наклон, рад
 * @param {number} p.roll     поперечный наклон, рад
 * @param {number[]} p.lightDir  направление света в экранных осях
 * @param {number} p.shading  глубина эффекта (0 — выключено)
 * @returns {number} множитель яркости, около 1.0
 */
export function tiltShade({ angle, pitch, roll, lightDir, shading }) {
  if (!shading) {
    return 1;
  }

  // наклон корпуса = поворот его нормали. Малые углы: наклон вокруг
  // локального X даёт составляющую вдоль курса, вокруг Y — поперёк
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  // нормаль в экранных осях (её вертикальная составляющая нам не нужна:
  // свет задан в плоскости экрана)
  const nx = -Math.sin(pitch) * cos - Math.sin(roll) * sin;
  const ny = -Math.sin(pitch) * sin + Math.sin(roll) * cos;

  const len = Math.hypot(lightDir[0], lightDir[1]) || 1;
  const dot = (nx * lightDir[0] + ny * lightDir[1]) / len;

  return 1 + dot * shading;
}

/**
 * Умножает тинт `0xRRGGBB` на скаляр поканально. Нужен, чтобы светотень
 * наклона легла ПОВЕРХ тинта уровня, а не заменила его.
 *
 * @param {number} tint   исходный цвет 0xRRGGBB
 * @param {number} factor множитель яркости
 * @returns {number} новый цвет 0xRRGGBB
 */
export function scaleTint(tint, factor) {
  const channel = shift => {
    const value = Math.round(((tint >> shift) & 0xff) * factor);

    return Math.min(0xff, Math.max(0, value));
  };

  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
}
