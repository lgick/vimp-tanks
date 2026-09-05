import { parallax } from '../config/render.js';

// Шаг zIndex между уровнями 2.5D-карты. Порядок отрисовки внутри уровня
// задают базовые zIndex партов; шаг обязан быть больше любого базового,
// иначе слой моста провалится под наземный навес (src/config/render.js).
export const LEVEL_Z_STRIDE = parallax.levelZStride;

export const levelZ = (base, level) => base + LEVEL_Z_STRIDE * (level || 0);
