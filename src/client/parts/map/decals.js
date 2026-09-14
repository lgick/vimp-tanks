import { Sprite } from 'pixi.js';
import { frameIndex } from './animatedTiles.js';

// Декали слоя карты (`game.decals`): вентиляторы на крышах и прочие мелкие
// анимированные спрайты в центре клетки. Живут в контейнере `animated`
// слоя, в немасштабированных координатах грида — параллакс и прозрачность
// слоя достаются им вместе с `layerRoot`.
//
// `kind: 'rotate'` — вращение `rps` оборотов в секунду по общим часам;
// `kind: 'frames'` — смена кадров, как у анимированных тайлов.

// Элементы карты, которыми владеет слой `(level, layer)`: ровно один
// владелец на вывеску и декаль
export function ownedBy(items, level, layer) {
  return (items || []).filter(
    item => (item.level || 0) === level && Number(item.layer) === layer,
  );
}

export function buildDecals(items, sheet, step, animated) {
  const decals = [];

  for (const item of items) {
    const [col, row] = item.cell || [0, 0];
    const frames = item.kind === 'frames' ? item.frames || [item.frame] : [item.frame];
    const textures = frames.map(frame => sheet.textures[`frame${frame}`]).filter(Boolean);

    if (textures.length === 0) {
      console.warn(`Decal at [${col}, ${row}]: frame not found in the sprite sheet`);
      continue;
    }

    const sprite = new Sprite(textures[0]);

    sprite.anchor.set(0.5);
    sprite.position.set((col + 0.5) * step, (row + 0.5) * step);
    animated.addChild(sprite);

    decals.push({ item, sprite, textures, frame: 0 });
  }

  return decals;
}

// позы декалей в момент `t` (секунды)
export function updateDecals(decals, t) {
  for (let i = 0; i < decals.length; i += 1) {
    const decal = decals[i];

    if (decal.item.kind === 'rotate') {
      decal.sprite.rotation = (decal.item.rps || 0) * 2 * Math.PI * t;
      continue;
    }

    if (decal.item.kind === 'frames') {
      const frame = frameIndex(t, decal.item.fps, decal.textures.length);

      if (frame !== decal.frame) {
        decal.frame = frame;
        decal.sprite.texture = decal.textures[frame];
      }
    }
  }
}

// текстуры принадлежат тайл-листу слоя
export function destroyDecals(decals) {
  for (const decal of decals) {
    decal.sprite.parent?.removeChild(decal.sprite);
    decal.sprite.destroy({ texture: false, textureSource: false });
  }

  decals.length = 0;
}
