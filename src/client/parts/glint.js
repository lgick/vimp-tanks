import { Sprite } from 'pixi.js';
import { lighting as lightingConfig } from '../../config/render.js';

// Засвет (`lighting.glints`): блик на стороне предмета, обращённой к
// сильнейшему источнику. Один код на `Tank` и `MapObject`: запрос к
// сервису, спрайт-градиент `glintTexture` и маска-силуэт предмета.

// сильнейший источник в мировой точке предмета или null: засвет
// выключен, текстуры нет, день или предмет вне экрана
export function glintHit(lighting, { x, y, z, level, reach, exclude = null }) {
  const asset = lighting?.texture('glint');

  if (!lightingConfig.glints?.enabled || !asset || !lighting.isNight()) {
    return null;
  }

  if (!lighting.onScreen(x, y, z, reach)) {
    return null;
  }

  return lighting.lightsAt(x, y, level, 1, exclude)[0] || null;
}

// пара «блик + маска» в `parent`: заводится на первом попадании
export function ensureGlint(glint, parent, texture) {
  if (glint) {
    return glint;
  }

  const sprite = new Sprite(texture);
  const mask = new Sprite();

  sprite.anchor.set(0.5);
  sprite.blendMode = 'add';
  sprite.mask = mask;
  parent.addChild(mask, sprite);

  return { sprite, mask };
}

export function hideGlint(glint) {
  if (glint) {
    glint.sprite.visible = false;
  }
}

// блик к источнику: `size` — размер предмета (единицы контейнера), по
// нему масштаб градиента; поворот `rotation` — в осях контейнера
export function placeGlint(glint, { hit, asset, x, y, rotation, size }) {
  const { sprite } = glint;
  const glints = lightingConfig.glints;

  sprite.texture = asset.texture;
  sprite.visible = true;
  sprite.position.set(x, y);
  sprite.rotation = rotation;
  sprite.scale.set((size * glints.size) / asset.contentSize);
  sprite.tint = hit.color;
  sprite.alpha = Math.min(1, glints.intensity * hit.strength);
}
