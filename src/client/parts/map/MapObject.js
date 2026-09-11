import { Sprite, Assets } from 'pixi.js';
import { degToRad } from 'vimp-engine/lib/math.js';
import { levelZ, renderLevel } from '../../levelZ.js';
import { cameraCenter } from '../../camera.js';
import { applyParallax } from '../../parallax.js';
import { parallax as parallaxConfig } from '../../../config/render.js';
import { baseScale } from './tileGrid.js';
import { C_X, C_Y, C_ANGLE, C_Z, C_LEVEL } from '../../snapshotFields.js';

// Динамическое тело карты (ящик): точечная сущность со своим спрайтом,
// своим `update` и одной alpha на всё тело. Стратегия рисует В КОНТЕЙНЕР
// парта: ей нужны и дети, и zIndex, и alpha самого парта.
export default class MapObject {
  constructor(container, data, dependencies, imageBase) {
    this._container = container;
    this._renderer = dependencies.renderer;

    // где локальный игрок (сервис игры, src/client/levelView.js)
    this._levelView = dependencies.levelView || null;

    // масштаб карты держим числами: у тела сам контейнер несёт `data.scale`,
    // а в мир переводит базовый масштаб, а не текущий (его каждый кадр
    // пересчитывает параллакс)
    this._baseScale = baseScale(data.scale);

    // тело живёт в мировых координатах: масштаб носит сам контейнер, а
    // параллакс своего уровня добавляется к нему тем же трансформом
    container.scale = data.scale;

    this._assetUrl = `${imageBase}${data.img}`;
    this._baseTexturePromise = Assets.load(this._assetUrl);

    // высота тела: пока ящик падает, уровень отрисовки ведёт она, а не
    // `level` строки (`renderLevel`)
    this._z = data.level || 0;
    this._level = data.level || 0;
    this._layer = Number(data.layer) || 2;
    container.zIndex = levelZ(this._layer, this._level);
    this._rotation = degToRad(data.angle);
    this._width = data.width;
    this._height = data.height;
    this._x = data.position[0];
    this._y = data.position[1];

    // мировая позиция тела: alpha ящика считается по ней, а sprite.x живёт
    // в НЕмасштабированных координатах контейнера
    this._worldX = this._x * this._baseScale.x;
    this._worldY = this._y * this._baseScale.y;

    this.sprite = null;

    // ящик на мосту обязан гаснуть вместе с плитой и падать с неё видимо:
    // уровень тела меняется на лету (строка `c1`/`c2` везёт `level`),
    // поэтому колбэк нужен ЛЮБОМУ динамическому телу, а не только тому,
    // что родилось наверху
    this.needsRender = Boolean(this._levelView);

    this._create();
  }

  async _create() {
    try {
      const baseTexture = await this._baseTexturePromise;

      // парт мог быть уничтожен, пока грузился ассет: смена карты сносит
      // старые парты в том же тике, в котором создаёт новые
      if (this._container.destroyed) {
        return;
      }

      this.sprite = new Sprite(baseTexture);

      this.sprite.x = this._x;
      this.sprite.y = this._y;
      this.sprite.width = this._width;
      this.sprite.height = this._height;
      this.sprite.rotation = this._rotation;
      this._container.addChild(this.sprite);
    } catch (error) {
      console.error(
        `Failed to create dynamic map with asset ${this._assetUrl}:`,
        error,
      );
    }
  }

  // ящик: точечная сущность, ей хватает одной alpha на всё тело. Заодно
  // затемняется, если игрок над ним (единый признак «ниже — темнее»), и
  // висит над землёй на своём уровне — тем же параллаксом, что и плита,
  // на которой стоит
  render() {
    if (!this._levelView || !this.sprite) {
      return;
    }

    const container = this._container;

    container.alpha = this._levelView.alphaFor(
      this._level,
      this._worldX,
      this._worldY,
      this._z,
    );
    container.tint = this._levelView.tintFor(this._level);

    // ящик на земле сдвига не имеет, но падающий — имеет: у него уровень
    // уже нулевой, а высота ещё нет
    if (!this._level && !this._z) {
      return;
    }

    // параллакс ведёт ВЫСОТА, а не уровень: иначе падающий ящик не
    // опускался бы вовсе и «телепортировался» на нижний слой в момент
    // касания — то же правило, что у корпуса танка
    applyParallax(
      container,
      this._levelView.camera() ??
        cameraCenter(container.parent, this._renderer),
      this._z * parallaxConfig.shear,
      this._baseScale,
    );
  }

  update(data) {
    if (this.sprite) {
      // `scale` у динамики пересчитывается параллаксом каждый кадр,
      // поэтому в мир переводит базовый масштаб карты, а не текущий
      this.sprite.x = data[C_X] / this._baseScale.x;
      this.sprite.y = data[C_Y] / this._baseScale.y;
      this.sprite.rotation = data[C_ANGLE];
    }

    this._worldX = data[C_X];
    this._worldY = data[C_Y];

    this._z = data[C_Z] || 0;

    // ящик может уехать на мост и упасть с него: уровень едет строкой
    // кадра, и порядок отрисовки обязан ехать за ним. Уровень ОТРИСОВКИ
    // ведёт высота (`renderLevel`): пока тело падает, хост держит `level`
    // тем уровнем, с которого оно сорвалось (`map::step_body_level`)
    const level = renderLevel(data[C_LEVEL], this._z);

    if (level !== this._level) {
      this._level = level;
      this._container.zIndex = levelZ(this._layer, level);

      // тело вернулось на землю: сдвиг высоты обязан сняться, иначе ящик
      // так и останется висеть в проекции уровня, с которого упал
      if (!level && !this._z) {
        applyParallax(this._container, null, 0, this._baseScale);
      }
    }
  }

  // спрайт тела — обычный ребёнок контейнера: его освобождает `super.destroy`
  // парта (`children: true`). Здесь снимаются только ссылки
  destroy() {
    this.sprite = null;
    this._baseTexturePromise = null;
    this._assetUrl = null;
    this._renderer = null;
    this._levelView = null;
  }
}
