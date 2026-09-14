import { Ticker } from 'pixi.js';
import { animationClock, quantizeTime } from '../../animationClock.js';
import { parseSpriteSheet } from '../bakeTileLayer.js';
import {
  animatedTileIds,
  buildAnimatedTiles,
  destroyAnimatedTiles,
  updateAnimatedTiles,
} from './animatedTiles.js';
import { buildDecals, destroyDecals, ownedBy, updateDecals } from './decals.js';
import NeonSign from './NeonSign.js';
import { animations as animationsConfig } from '../../../config/render.js';

// Анимированные элементы статического слоя: тайлы (`game.animatedTiles`),
// декали (`game.decals`) и неоновые вывески (`game.signs`). Как и
// `layerAssets`, модуль ничего не знает о парте: на вход — описание, на
// выход — готовое состояние, которое слой держит у себя.

// Что из анимаций достаётся слою `(level, layer)` с тайлами `tiles`.
// Считается синхронно в конструкторе: от этого зависит, нужен ли слою
// колбэк `onRender`
export function layerAnimationSpec(game, tiles, level, layer) {
  const ids = animatedTileIds(game?.animatedTiles);
  const own = new Set(tiles);

  return {
    exclude: [...ids],
    hasTiles: [...ids].some(id => own.has(id)),
    signs: ownedBy(game?.signs, level, layer),
    decals: ownedBy(game?.decals, level, layer),
  };
}

export function hasAnimations(spec) {
  return spec.hasTiles || spec.signs.length > 0 || spec.decals.length > 0;
}

// `spec` — `layerAnimationSpec`; остальное — грид слоя, его контейнер
// `animated`, рендерер и сервис освещения (или null). `isAborted()` — парт
// уже уничтожен. Возвращает состояние анимаций или null
export async function buildLayerAnimations({
  spec,
  game,
  baseTexture,
  spriteSheetData,
  map,
  tiles,
  step,
  scale,
  level,
  animated,
  renderer,
  lighting,
  isAborted,
}) {
  let sheet = null;

  if (spec.hasTiles || spec.decals.length > 0) {
    sheet = await parseSpriteSheet(baseTexture, spriteSheetData);

    if (isAborted()) {
      sheet.destroy();

      return null;
    }
  }

  const state = {
    sheet,
    tiles: null,
    decals: [],
    signs: [],
    tick: null,
  };

  if (spec.hasTiles) {
    state.tiles = buildAnimatedTiles(
      { map, tiles, step, scale },
      sheet,
      game.animatedTiles,
    );
    animated.addChild(state.tiles.container);
  }

  if (sheet) {
    state.decals = buildDecals(spec.decals, sheet, step, animated);
  }

  state.signs = spec.signs.map(
    sign =>
      new NeonSign({ sign, renderer, lighting, animated, step, scale, level }),
  );

  return state;
}

// виден ли контейнер на экране: границы в глобальных координатах полотна
function onScreen(screen) {
  if (!screen) {
    return () => true;
  }

  return container => {
    const bounds = container.getBounds();

    return (
      bounds.maxX >= 0 &&
      bounds.minX <= screen.width &&
      bounds.maxY >= 0 &&
      bounds.minY <= screen.height
    );
  };
}

// Каждая отрисовка слоя. Кадры тайлов и декалей — один раз на тик (и
// проверка экрана тоже); позиции эмиссивных вывесок — каждую отрисовку:
// они едут за камерой
export function updateLayerAnimations(state, { camera, levelView, screen }) {
  const enabled = animationsConfig.enabled;
  const t = enabled
    ? quantizeTime(animationClock.now(), animationsConfig.maxFps)
    : null;
  const tick = Ticker.shared.lastTime;

  if (enabled && state.tick !== tick) {
    state.tick = tick;

    if (state.tiles) {
      updateAnimatedTiles(state.tiles.groups, t, onScreen(screen));
    }

    updateDecals(state.decals, t);
  }

  for (let i = 0; i < state.signs.length; i += 1) {
    state.signs[i].update(t, camera, levelView);
  }
}

// Снимает всё со слоя и из сервиса освещения. Текстуры (тайл-лист слоя и
// неоновый кэш) отдаёт возвращаемый колбэк — после снятия парта со сцены
export function destroyLayerAnimations(state) {
  if (!state) {
    return () => {};
  }

  if (state.tiles) {
    destroyAnimatedTiles(state.tiles);
    state.tiles = null;
  }

  destroyDecals(state.decals);

  const releases = state.signs.map(sign => sign.destroy());
  const sheet = state.sheet;

  state.signs = [];
  state.sheet = null;

  return () => {
    releases.forEach(release => release());
    sheet?.destroy();
  };
}
