import { Sprite, Assets } from 'pixi.js';
import { degToRad } from 'vimp-engine/lib/math.js';
import { levelZ, renderLevel } from '../../levelZ.js';
import { cameraCenter } from '../../camera.js';
import { applyParallax } from '../../parallax.js';
import {
  lighting as lightingConfig,
  parallax as parallaxConfig,
} from '../../../config/render.js';
import { baseScale } from './tileGrid.js';
import DebrisEffect from '../effects/DebrisEffect.js';
import {
  C_X,
  C_Y,
  C_ANGLE,
  C_Z,
  C_LEVEL,
  C_STATE,
} from '../../snapshotFields.js';

// байт `state` строки тела: 0 — цел, 1 — повреждён, 2 — разрушен
export const STATE_INTACT = 0;
export const STATE_DAMAGED = 1;
export const STATE_DESTROYED = 2;

// база zIndex обломков: под танками, на уровне следов (src/client/levelZ.js)
const DESTROYED_LAYER = 1;
// база zIndex разлёта щепок: слой эффектов
const DEBRIS_LAYER = 2;
// пятно копоти крупнее тела: взрыв выжигает и землю вокруг
const SCORCH_SCALE = 1.4;

// Динамическое тело карты (ящик, проп): точечная сущность со своим
// спрайтом, своим `update` и одной alpha на всё тело. Стратегия рисует В
// КОНТЕЙНЕР парта: ей нужны и дети, и zIndex, и alpha самого парта.
//
// Состояние пропа едет байтом `state` строки кадра. Картинки состояний —
// `img` (цел), `game.imgDamaged`, `game.imgDestroyed`; без картинки
// повреждённый остаётся на `img`, а разрушенный рисуется процедурной
// копотью (`scorchTexture`). Все эти текстуры — общие ассеты: ни одна не
// выгружается (`Assets.unload` запрещён, см. architecture.md)
export default class MapObject {
  constructor(container, data, dependencies, imageBase, assets = {}) {
    this._container = container;
    this._renderer = dependencies.renderer;
    this._soundManager = dependencies.soundManager || null;
    this._assets = assets || {};

    // где локальный игрок (сервис игры, src/client/levelView.js)
    this._levelView = dependencies.levelView || null;

    // ночь (src/client/lighting/): засвет пропа и его тень в лучах фонарей.
    // `_glint` — `{ sprite, mask }`, заводится на первом кадре ночи
    this._lighting = dependencies.lighting?.enabled
      ? dependencies.lighting
      : null;
    this._glint = null;

    // масштаб карты держим числами: у тела сам контейнер несёт `data.scale`,
    // а в мир переводит базовый масштаб, а не текущий (его каждый кадр
    // пересчитывает параллакс)
    this._baseScale = baseScale(data.scale);

    // тело живёт в мировых координатах: масштаб носит сам контейнер, а
    // параллакс своего уровня добавляется к нему тем же трансформом
    container.scale = data.scale;

    this._assetUrl = `${imageBase}${data.img}`;
    this._baseTexturePromise = Assets.load(this._assetUrl);

    // картинки состояний пропа (необязательные)
    this._damagedUrl = data.game?.imgDamaged
      ? `${imageBase}${data.game.imgDamaged}`
      : null;
    this._destroyedUrl = data.game?.imgDestroyed
      ? `${imageBase}${data.game.imgDestroyed}`
      : null;

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

    // состояние из кадра; `null` — кадра ещё не было: первый кадр со
    // `state = 2` (подключение посреди раунда) показывает обломки сразу,
    // без разлёта и звука
    this._state = null;

    this.sprite = null;
    this._scorch = null;

    // разлёты щепок — соседи парта на сцене: снимает их сам парт
    this._effects = new Set();

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

      // кадр мог принести состояние раньше базовой текстуры
      if (this._state !== null && this._state !== STATE_INTACT) {
        this._showState(this._state);
      }
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

    this._updateGlint();
    this._updateCaster();

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
    this._rotation = data[C_ANGLE];

    this._z = data[C_Z] || 0;

    // ящик может уехать на мост и упасть с него: уровень едет строкой
    // кадра, и порядок отрисовки обязан ехать за ним. Уровень ОТРИСОВКИ
    // ведёт высота (`renderLevel`): пока тело падает, хост держит `level`
    // тем уровнем, с которого оно сорвалось (`map::step_body_level`)
    const level = renderLevel(data[C_LEVEL], this._z);

    if (level !== this._level) {
      this._level = level;
      this._container.zIndex = levelZ(this._drawLayer(), level);

      // тело вернулось на землю: сдвиг высоты обязан сняться, иначе ящик
      // так и останется висеть в проекции уровня, с которого упал
      if (!level && !this._z) {
        applyParallax(this._container, null, 0, this._baseScale);
      }
    }

    const state = data[C_STATE] || STATE_INTACT;

    if (state !== this._state) {
      const firstFrame = this._state === null;

      this._state = state;
      this._showState(state);

      if (state === STATE_DESTROYED && !firstFrame) {
        this._burst();
      }
    }

    this._placeScorch();
  }

  // база zIndex по состоянию: обломки лежат под танками
  _drawLayer() {
    return this._state === STATE_DESTROYED ? DESTROYED_LAYER : this._layer;
  }

  // целое тело (не копоть): только оно ловит засвет и бросает тень
  _standing() {
    return this._state !== STATE_DESTROYED || Boolean(this._destroyedUrl);
  }

  // Засвет: блик на стороне тела, обращённой к сильнейшему источнику.
  // Градиент `glintTexture` режется маской — копией спрайта тела; блик
  // ложится по центру тела поверх него
  _updateGlint() {
    const glints = lightingConfig.glints;
    const asset = this._lighting?.texture('glint');
    // строка кадра везёт угол тела: свет меряется от его центра
    const center = this._localCenter();
    const worldX = center.x * this._baseScale.x;
    const worldY = center.y * this._baseScale.y;
    const reach = Math.max(
      this._width * this._baseScale.x,
      this._height * this._baseScale.y,
    );
    const hit =
      glints?.enabled &&
      asset &&
      this.sprite.visible &&
      this._standing() &&
      this._lighting.isNight() &&
      this._lighting.onScreen(worldX, worldY, this._z, reach)
        ? this._lighting.lightsAt(worldX, worldY, this._level, 1)[0]
        : null;

    if (!hit) {
      if (this._glint) {
        this._glint.sprite.visible = false;
      }

      return;
    }

    if (!this._glint) {
      const sprite = new Sprite(asset.texture);
      const mask = new Sprite();

      sprite.anchor.set(0.5);
      sprite.blendMode = 'add';
      sprite.mask = mask;
      this._container.addChild(mask, sprite);
      this._glint = { sprite, mask };
    }

    const { sprite, mask } = this._glint;
    const body = this.sprite;

    // маска повторяет спрайт тела: текстура состояния, габариты и поворот
    mask.texture = body.texture;
    mask.position.copyFrom(body.position);
    mask.scale.copyFrom(body.scale);
    mask.rotation = body.rotation;

    sprite.texture = asset.texture;
    sprite.visible = true;
    sprite.position.set(center.x, center.y);
    sprite.rotation = hit.angle;
    sprite.scale.set(
      (Math.max(this._width, this._height) * glints.size) / asset.contentSize,
    );
    sprite.tint = hit.color;
    sprite.alpha = Math.min(1, glints.intensity * hit.strength);
  }

  // тень тела в лучах фонарей: круг с полудиагональю тела вокруг центра.
  // Копоть тени не бросает
  _updateCaster() {
    if (!this._lighting) {
      return;
    }

    if (!this._standing()) {
      this._lighting.setCaster(this, null);

      return;
    }

    const local = this._localCenter();

    this._lighting.setCaster(this, {
      x: local.x * this._baseScale.x,
      y: local.y * this._baseScale.y,
      z: this._z,
      level: this._level,
      radius:
        Math.hypot(
          this._width * this._baseScale.x,
          this._height * this._baseScale.y,
        ) / 2,
    });
  }

  // картинка и порядок отрисовки состояния
  _showState(state) {
    this._container.zIndex = levelZ(this._drawLayer(), this._level);

    if (!this.sprite) {
      return; // покажет `_create`, когда загрузится базовая текстура
    }

    // разрушенный без своей картинки — копоть вместо спрайта
    if (state === STATE_DESTROYED && !this._destroyedUrl) {
      this.sprite.visible = false;
      this._showScorch();

      return;
    }

    if (this._scorch) {
      this._scorch.visible = false;
    }

    this.sprite.visible = true;

    let url = null;

    if (state === STATE_DAMAGED) {
      url = this._damagedUrl;
    } else if (state === STATE_DESTROYED) {
      url = this._destroyedUrl;
    }

    this._setTexture(
      url ? Assets.load(url) : this._baseTexturePromise,
      state,
      url ?? this._assetUrl,
    );
  }

  async _setTexture(promise, state, url) {
    try {
      const texture = await promise;

      // за время загрузки парт мог уйти со сцены, а тело — сменить
      // состояние ещё раз: старая текстура не должна перекрыть новую
      if (this._container.destroyed || !this.sprite || this._state !== state) {
        return;
      }

      this.sprite.texture = texture;
      // размер задан в единицах карты, а не в пикселях новой картинки
      this.sprite.width = this._width;
      this.sprite.height = this._height;
    } catch (error) {
      console.error(`Failed to load map object state asset ${url}:`, error);
    }
  }

  _showScorch() {
    const scorch = this._assets.scorchTexture;

    if (!scorch) {
      return;
    }

    if (!this._scorch) {
      const { textures, contentSize } = scorch;
      const sprite = new Sprite(
        textures[Math.floor(Math.random() * textures.length)],
      );

      sprite.anchor.set(0.5);
      sprite.rotation = Math.random() * Math.PI * 2;
      sprite.scale.set(
        (Math.max(this._width, this._height) * SCORCH_SCALE) / contentSize,
      );

      this._scorch = sprite;
      this._container.addChild(sprite);
    }

    this._scorch.visible = true;
    this._placeScorch();
  }

  // копоть — по центру тела, в НЕмасштабированных координатах контейнера
  _placeScorch() {
    if (!this._scorch?.visible) {
      return;
    }

    const center = this._localCenter();

    this._scorch.position.set(center.x, center.y);
  }

  // центр тела в координатах контейнера: строка кадра везёт «угол объекта»
  _localCenter() {
    const cos = Math.cos(this._rotation);
    const sin = Math.sin(this._rotation);
    const halfW = this._width / 2;
    const halfH = this._height / 2;

    return {
      x: this._worldX / this._baseScale.x + cos * halfW - sin * halfH,
      y: this._worldY / this._baseScale.y + sin * halfW + cos * halfH,
    };
  }

  // разовый разлёт щепок и треск — только на переходе в «разрушен»
  _burst() {
    const local = this._localCenter();
    const x = local.x * this._baseScale.x;
    const y = local.y * this._baseScale.y;

    this._soundManager?.registerSound('propBreak', { position: { x, y } });

    const parent = this._container.parent;
    const debris = this._assets.debrisTexture;

    if (!parent || !debris) {
      return;
    }

    const size = Math.max(
      this._width * this._baseScale.x,
      this._height * this._baseScale.y,
    );
    const effect = new DebrisEffect(
      x,
      y,
      size,
      () => {
        this._effects.delete(effect);
        effect.destroy();
      },
      debris,
    );

    effect.zIndex = levelZ(DEBRIS_LAYER, this._level);
    parent.addChild(effect);
    this._effects.add(effect);
    effect.run();
  }

  // спрайты тела (и копоть) — обычные дети контейнера: их освобождает
  // `super.destroy` парта (`children: true`). Разлёты — соседи на сцене,
  // их снимает сам парт. Здесь снимаются только ссылки
  destroy() {
    for (const effect of this._effects) {
      effect.destroy();
    }

    this._effects.clear();
    // тень в лучах — состояние сессии сервиса освещения; блик и маска —
    // дети контейнера, их снимет `super.destroy` парта
    this._lighting?.setCaster(this, null);
    this._lighting = null;
    this._glint = null;
    this.sprite = null;
    this._scorch = null;
    this._baseTexturePromise = null;
    this._assetUrl = null;
    this._renderer = null;
    this._levelView = null;
    this._soundManager = null;
  }
}
