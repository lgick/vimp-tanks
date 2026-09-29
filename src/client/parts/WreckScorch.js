import { Sprite } from 'pixi.js';
import { clamp } from 'vimp-engine/lib/math.js';
import { levelZ } from '../levelZ.js';
import { offsetPoint } from '../parallax.js';
import { parallax as parallaxConfig, wreckFx } from '../../config/render.js';

// как воронка (FunnelEffect): над следами (1), под танком (3)
const SCORCH_BASE_Z = 2;
const TAU = Math.PI * 2;

// Копоть остова: спрайт-сиблинг на сцене (мимо GameView.add, как
// ExplosionEffectController.run) в точке гибели; живёт до респауна.
// Владелец — WreckFire: шагает (step), проецирует (render), снимает (destroy)
export default class WreckScorch {
  constructor(stage, asset, { x, y, z, level, sizeScale }) {
    const { textures } = asset;
    const sprite = new Sprite(
      textures[Math.floor(Math.random() * textures.length)],
    );

    sprite.anchor.set(0.5);
    sprite.rotation = Math.random() * TAU;
    sprite.alpha = 0;
    sprite.zIndex = levelZ(SCORCH_BASE_Z, level);

    this.sprite = sprite;
    // точка, высота и уровень, масштаб, возраст и сила проявления
    this.x = x;
    this.y = y;
    this.z = z;
    this.level = level;
    this.scale = (wreckFx.scorch.size * sizeScale) / asset.contentSize;
    this.age = 0;
    this.alpha = 0;

    stage.addChild(sprite);
    stage.sortChildren();
  }

  // проявилась полностью
  get settled() {
    return this.age >= wreckFx.scorch.fadeIn;
  }

  step(dt) {
    const { alpha, fadeIn } = wreckFx.scorch;

    this.age += dt;
    this.alpha = alpha * (fadeIn > 0 ? clamp(this.age / fadeIn, 0, 1) : 1);
  }

  // своя проекция, как у воронки (ExplosionEffectController._applyHeight)
  render(camera, levelView) {
    const k = this.z * parallaxConfig.shear;
    const view = offsetPoint(this.x, this.y, camera, k);

    this.sprite.position.set(view.x, view.y);
    this.sprite.scale.set(this.scale * (1 + k));

    const see = levelView
      ? levelView.alphaFor(this.level, this.x, this.y, this.z)
      : 1;

    this.sprite.alpha = this.alpha * see;

    if (levelView) {
      this.sprite.tint = levelView.tintFor(this.level);
    }
  }

  destroy() {
    // в PixiJS 8 destroy снимает спрайт с родителя; текстура общая
    this.sprite.destroy({ texture: false, textureSource: false });
  }
}
