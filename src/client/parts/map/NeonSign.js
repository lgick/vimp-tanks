import { Sprite } from 'pixi.js';
import { offsetPoint } from '../../parallax.js';
import { brightness, cellSeed } from '../../neonFlicker.js';
import { getNeonTextures, releaseNeonTextures } from './neonCache.js';
import { parallax as parallaxConfig } from '../../../config/render.js';

// Неоновая вывеска карты (`game.signs`): два аддитивных спрайта — ореол
// (`glow`) и ядро (`core`) — из общего неонового кэша, цвет — `tint`.
//
// Где рисуется:
// - ночью спрайты отдаются в эмиссивный слой сервиса освещения
//   (`lighting.addEmissive`) и светят поверх затемнения, а вывеска
//   дополнительно заводит источник света своего цвета (`sign.light`).
//   Эмиссив живёт в координатах сцены, поэтому позицию и масштаб проекции
//   вывеска ставит сама каждую отрисовку;
// - без ночи (или при `lighting.enabled = false`) `addEmissive` возвращает
//   `false`: спрайты остаются в контейнере `animated` своего слоя, в
//   координатах грида, и параллакс с прозрачностью им даёт слой.
//
// Строится в асинхронной сборке слоя, то есть ПОСЛЕ синхронного
// `acquireMap` в конструкторе `MapLayer`: к этому моменту сервис уже знает,
// ночная ли карта, и результат `addEmissive` верен.
export default class NeonSign {
  // `sign` — элемент `game.signs`; `step`/`scale` — грид слоя; `animated` —
  // контейнер слоя для дневного режима; `lighting` — сервис или null
  constructor({ sign, renderer, lighting, animated, step, scale, level }) {
    const [col, row] = sign.cell || [0, 0];

    this._sign = sign;
    this._renderer = renderer;
    this._lighting = lighting || null;
    this._level = level;
    this._seed = cellSeed(col, row, level);
    this._scale = scale;
    this._light = null;

    // центр клетки: в единицах грида (дневной режим) и в мировых (эмиссив)
    this._gridX = (col + 0.5) * step;
    this._gridY = (row + 0.5) * step;
    this._worldX = this._gridX * scale.x;
    this._worldY = this._gridY * scale.y;

    const textures = getNeonTextures(renderer, sign);

    this.glow = this._sprite(textures.glow);
    this.core = this._sprite(textures.core);

    this.emissive =
      Boolean(this._lighting?.addEmissive(this.glow, level)) &&
      this._lighting.addEmissive(this.core, level);

    if (this.emissive) {
      if (sign.light) {
        this._light = this._lighting.addLight({
          kind: 'radial',
          level,
          x: this._worldX,
          y: this._worldY,
          z: level,
          radius: sign.light.radius ?? 0,
          color: sign.color ?? 0xffffff,
          intensity: sign.light.intensity ?? 1,
        });
      }
    } else {
      // ореол мог уйти в эмиссив, а ядро — нет (сервис сменил карту между
      // вызовами): вывеска целиком остаётся у слоя
      this._lighting?.removeEmissive(this.glow);
      this.glow.position.set(this._gridX, this._gridY);
      this.core.position.set(this._gridX, this._gridY);
      animated.addChild(this.glow, this.core);
    }
  }

  _sprite(texture) {
    const sprite = new Sprite(texture);

    sprite.anchor.set(0.5);
    sprite.blendMode = 'add';
    sprite.tint = this._sign.color ?? 0xffffff;
    sprite.angle = this._sign.angle || 0;

    return sprite;
  }

  // `t` — время анимаций (секунды) или null, когда анимации выключены;
  // `camera` — центр камеры кадра; `levelView` — прозрачность эмиссива;
  // `roofAlpha` — прозрачность крыши под вывеской (null — не на крыше):
  // крыша непрозрачна, пока не закрывает танк, и вывеска обязана гаснуть
  // вместе с ней, а не по кругу вокруг игрока
  update(t, camera, levelView, roofAlpha = null) {
    const light = t === null ? { core: 1, glow: 1 } : brightness(t, this._seed, this._sign.flicker);

    if (!this.emissive) {
      this.glow.alpha = light.glow;
      this.core.alpha = light.core;

      return;
    }

    const k = this._level * parallaxConfig.shear;
    const point = offsetPoint(this._worldX, this._worldY, camera, k);
    let see = 1;

    if (roofAlpha !== null) {
      see = roofAlpha;
    } else if (levelView) {
      see = levelView.alphaFor(this._level, point.x, point.y, 0);
    }

    for (const sprite of [this.glow, this.core]) {
      sprite.position.set(point.x, point.y);
      sprite.scale.set(this._scale.x * (1 + k), this._scale.y * (1 + k));
    }

    this.glow.alpha = see * light.glow;
    this.core.alpha = see * light.core;

    if (this._light) {
      this._lighting.updateLight(this._light, {
        intensity: (this._sign.light.intensity ?? 1) * light.glow,
      });
    }
  }

  // Снимает источник, эмиссив и спрайты. Текстуры кэша отдаёт возвращаемый
  // колбэк: слой зовёт его после того, как парт снят со сцены
  destroy() {
    if (this._lighting) {
      if (this._light) {
        this._lighting.removeLight(this._light);
        this._light = null;
      }

      this._lighting.removeEmissive(this.glow);
      this._lighting.removeEmissive(this.core);
    }

    for (const sprite of [this.glow, this.core]) {
      sprite.parent?.removeChild(sprite);
      sprite.destroy({ texture: false, textureSource: false });
    }

    const renderer = this._renderer;
    const sign = this._sign;

    this._lighting = null;
    this._renderer = null;

    return () => releaseNeonTextures(renderer, sign);
  }
}
