import { parallax } from '../config/render.js';

// Шаг zIndex между уровнями 2.5D-карты. Порядок отрисовки внутри уровня
// задают базовые zIndex партов; шаг обязан быть больше любого базового,
// иначе слой моста провалится под наземный навес (src/config/render.js).
export const LEVEL_Z_STRIDE = parallax.levelZStride;

export const levelZ = (base, level) => base + LEVEL_Z_STRIDE * (level || 0);

// Уровень ОТРИСОВКИ тела 2.5D-карты: пока тело падает, хост держит `level`
// тем уровнем, с которого оно сорвалось (`crate::level`, `map::step_body_level`),
// и телом рисовались бы слой, тинт и прозрачность эстакады до самого
// касания. По высоте тело переходит на нижний слой на середине падения.
// Подъём правило не трогает: на рампе `level` и есть `round(z)`.
//
// Одно правило на все падающие тела — танк (`parts/Tank.js`) и ящик
// (`parts/map/MapObject.js`): вторая копия разъехалась бы молча.
export const renderLevel = (level, z) => Math.min(level || 0, Math.round(z));
