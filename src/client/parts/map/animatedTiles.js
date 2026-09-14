import { Container, Sprite } from 'pixi.js';

// Анимированные тайлы слоя карты (`game.animatedTiles`): вода, конвейеры.
// В запекание они не попадают (`bakeTileLayer`, `exclude`) и рисуются
// живыми спрайтами — по одному на клетку, в контейнере `animated` слоя.
// Координаты — клетки грида в немасштабированных единицах, как у
// запечённого спрайта: параллакс и масштаб слою даёт `layerRoot`.
//
// Спрайты группируются по описанию: все спрайты группы разделяют номер
// кадра, и обновление — один проход по группе. Спрайты не поворачиваются:
// направление ленты уже нарисовано в кадрах.

// id тайлов, у которых есть описание анимации
export function animatedTileIds(defs) {
  return new Set(Object.keys(defs || {}).map(Number));
}

// Частота смены кадров описания. Конвейер задаёт `speed` (ед./с, та же, что
// `belt` его поверхности): шевроны сдвигаются на 1/N тайла за кадр, значит
// `fps = speed · N / (step · scale)`. `step` на клиенте не масштабирован,
// масштаб карты лежит отдельно
export function resolveFps(def, step, scale = 1) {
  if (def.speed !== undefined) {
    const count = def.frames?.length || 0;
    const tile = step * (typeof scale === 'number' ? scale : scale.x);

    return tile > 0 ? (def.speed * count) / tile : 0;
  }

  return def.fps || 0;
}

// номер кадра в момент `t` (секунды)
export function frameIndex(t, fps, count) {
  if (!(count > 0) || !(fps > 0)) {
    return 0;
  }

  return Math.floor(t * fps) % count;
}

// Спрайты анимированных тайлов слоя. `data` — `{ map, tiles, step, scale }`
// слоя, `sheet` — разобранный тайл-лист (`parseSpriteSheet`), `defs` —
// `game.animatedTiles`. Возвращает `{ container, groups }`; пустой список
// групп — у слоя анимированных тайлов нет
export function buildAnimatedTiles(data, sheet, defs) {
  const container = new Container();
  const groups = [];

  container.label = 'animatedTiles';

  if (!defs) {
    return { container, groups };
  }

  const own = new Set(data.tiles);

  for (const [key, def] of Object.entries(defs)) {
    const id = Number(key);

    if (!own.has(id)) {
      continue;
    }

    const textures = (def.frames || []).map(frame => sheet.textures[`frame${frame}`]).filter(Boolean);

    if (textures.length === 0) {
      console.warn(`Animated tile ${id}: no frames found in the sprite sheet`);
      continue;
    }

    const group = {
      id,
      fps: resolveFps(def, data.step, data.scale),
      textures,
      sprites: [],
      container: new Container(),
      frame: 0,
    };

    group.container.label = `animatedTile-${id}`;

    for (let y = 0; y < data.map.length; y += 1) {
      const row = data.map[y];

      for (let x = 0; x < row.length; x += 1) {
        if (row[x] !== id) {
          continue;
        }

        const sprite = new Sprite(textures[0]);

        sprite.x = x * data.step;
        sprite.y = y * data.step;
        sprite.cullable = true;
        group.sprites.push(sprite);
        group.container.addChild(sprite);
      }
    }

    if (group.sprites.length === 0) {
      group.container.destroy();
      continue;
    }

    container.addChild(group.container);
    groups.push(group);
  }

  return { container, groups };
}

// Кадры групп в момент `t`. `isVisible(container)` — виден ли контейнер
// группы: группа целиком вне экрана не обновляется (догоняет сразу, как
// вернётся на экран — номер кадра считается от времени, а не шагами)
export function updateAnimatedTiles(groups, t, isVisible = () => true) {
  for (let i = 0; i < groups.length; i += 1) {
    const group = groups[i];

    if (!isVisible(group.container)) {
      continue;
    }

    const frame = frameIndex(t, group.fps, group.textures.length);

    if (frame === group.frame) {
      continue;
    }

    group.frame = frame;

    const texture = group.textures[frame];

    for (let j = 0; j < group.sprites.length; j += 1) {
      group.sprites[j].texture = texture;
    }
  }
}

// Текстуры принадлежат тайл-листу слоя: спрайты их не освобождают
export function destroyAnimatedTiles(built) {
  built.container.parent?.removeChild(built.container);
  built.container.destroy({ children: true, texture: false, textureSource: false });
  built.groups.length = 0;
}
