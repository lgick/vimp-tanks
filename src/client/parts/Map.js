import { Container, Sprite, Assets, Ticker } from 'pixi.js';
import { degToRad } from 'vimp-engine/lib/math.js';
import { levelZ } from '../levelZ.js';
import { createHoleFilter, setHoleUniforms } from '../seeThrough.js';
import { bakeTileLayer } from './bakeTileLayer.js';
import {
  C_X,
  C_Y,
  C_ANGLE,
  C_LEVEL,
} from '../snapshotFields.js';

// ниже этой силы дыра неотличима от её отсутствия: фильтр снимается совсем,
// чтобы слой не платил за проход, которого не видно
const HOLE_EPSILON = 0.01;

export default class Map extends Container {
  constructor(data, _assets, dependencies) {
    super();

    // хранение Promise, который возвращает Assets.load()
    this._baseTexturePromise = null;
    this._assetUrl = null; // URL для возможной выгрузки

    this._renderer = dependencies.renderer;
    this._imageBase = null;

    // где локальный игрок (сервис игры, src/client/levelView.js): нужен
    // только слоям уровня >= 1 — они уступают ему видимость
    this._levelView = dependencies.levelView || null;
    this._level = 0;
    this._targetAlpha = 1;

    // режим 'hole': фильтр «дыры» и её сила (0 — игрок не под слоем).
    // Фильтр создаётся лениво: слоёв уровня >= 1 на карте может не быть
    // вовсе, а программу шейдера тогда компилировать не за что
    this._holeFilter = null;
    this._holeStrength = 0;
    this._holeAttached = false;

    // мировая позиция динамического тела: alpha ящика считается по ней,
    // а sprite.x живёт в НЕмасштабированных координатах контейнера
    this._worldX = 0;
    this._worldY = 0;

    this.scale = data.scale;

    this.sprite = null;
    this.mapSprite = null; // спрайт для "запеченной" карты

    // База ассетов активной игры — движок отдаёт её сервисом assetsBase
    // (объявлен в componentDependencies, src/config/client.js). Картинки
    // карт везёт сам пакет игры: assets/img/ -> dist/img/, а движок ни одного
    // игрового файла не раздаёт. Без базы вышел бы запрос на
    // "undefinedimg/tiles.png" — полотно осталось бы пустым без единой
    // ошибки, поэтому промах ловим здесь и вслух.
    //
    // Логируем, а не бросаем: конструктор вызывается из рендер-тика
    // (renderTick -> applyGameData -> GameCtrl.parse -> фабрика), где на всём
    // пути нет ни одного try/catch — исключение оборвало бы создание всех
    // остальных сущностей этого кадра. Тот же паттерн «громко в лог, ничего
    // наружу», что у createStatic/createDynamic ниже
    if (typeof dependencies.assetsBase !== 'string') {
      console.error(
        'Map: сервис assetsBase недоступен — карта останется пустой. ' +
          'Объявите assetsBase в componentDependencies и запустите игру ' +
          'на vimp-engine >= 0.9.0',
      );

      return;
    }

    this._imageBase = `${dependencies.assetsBase}img/`;

    // если статические данные
    if (data.type === 'static') {
      this._assetUrl = `${this._imageBase}${data.spriteSheet.img}`;
      this._baseTexturePromise = Assets.load(this._assetUrl);

      // data состоит из:
      // layer - слой,
      // tiles - массив с названиями тайлов,
      // spriteSheet - объект с данными картинки (например, PIXI.Spritesheet),
      // map - двумерный массив карты,
      // step - размер шага.
      this._map = data.map;
      this._tiles = data.tiles;
      this._level = data.level || 0;
      this._floor = data.floor || [];
      this._spriteSheetData = data.spriteSheet;
      this._step = data.step;
      this.zIndex = levelZ(Number(data.layer) || 1, this._level);

      // прозрачность считает только плита моста: вешать колбэк на слои
      // уровня 0 значило бы звать его каждый кадр на каждый статический
      // слой ради выхода по первой же строке.
      //
      // `onRender` у Container — аксессор, а не метод: присваивание здесь
      // проходит через его сеттер (в конструкторе renderGroup ещё null, но
      // RenderGroup.addChild сам подхватит `_onRender` при добавлении на
      // сцену)
      if (this._level >= 1) {
        // на слоёной карте локальный танк показывает бейдж уровня; кроме
        // самих слоёв про «слоистость» карты никто на клиенте не знает
        this._levelView?.markLayered();
        this.onRender = () => this._updateSeeThrough();
      }

      this.createStatic();
    }
    // если динамические данные
    else if (data.type === 'dynamic') {
      this._assetUrl = `${this._imageBase}${data.img}`;
      this._baseTexturePromise = Assets.load(this._assetUrl);

      this._level = data.level || 0;
      this._layer = Number(data.layer) || 2;
      this.zIndex = levelZ(this._layer, this._level);
      this._rotation = degToRad(data.angle);
      this._width = data.width;
      this._height = data.height;
      this._x = data.position[0];
      this._y = data.position[1];
      this._worldX = this._x * this.scale.x;
      this._worldY = this._y * this.scale.y;

      // ящик на мосту обязан гаснуть вместе с плитой и падать с неё видимо:
      // уровень тела теперь меняется на лету (строка `c1`/`c2` везёт
      // `level` с этапа 3), поэтому колбэк нужен ЛЮБОМУ динамическому телу,
      // а не только тому, что родилось наверху.
      //
      // `onRender` — аксессор Container, назначается свойством (см. ниже)
      if (this._levelView) {
        this.onRender = () => this._updateDynamicSeeThrough();
      }

      this.createDynamic();
    }
  }

  async createDynamic() {
    try {
      const baseTexture = await this._baseTexturePromise;

      this.sprite = new Sprite(baseTexture);

      this.sprite.x = this._x;
      this.sprite.y = this._y;
      this.sprite.width = this._width;
      this.sprite.height = this._height;
      this.sprite.rotation = this._rotation;
      this.addChild(this.sprite);
    } catch (error) {
      console.error(
        `Failed to create dynamic map with asset ${this._assetUrl}:`,
        error,
      );
    }
  }

  async createStatic() {
    try {
      const bakedTexture = await bakeTileLayer({
        baseTexture: await this._baseTexturePromise,
        spriteSheetData: this._spriteSheetData,
        map: this._map,
        tiles: this._tiles,
        step: this._step,
        renderer: this._renderer,
      });

      // один большой спрайт из "запеченной" текстуры
      this.mapSprite = new Sprite(bakedTexture);
      this.addChild(this.mapSprite);
    } catch (error) {
      console.error(
        `Failed to create static map with asset ${this._assetUrl}:`,
        error,
      );
    }
  }

  // прозрачность плиты моста над локальным игроком: в GTA 2 игрок под
  // эстакадой продолжает видеть свою машину. Считается по НАШЕМУ гриду
  // уровня: парт уже знает и карту слоя, и список тайлов пола.
  //
  // Зовётся из колбэка `onRender`, который конструктор кладёт СВОЙСТВОМ
  // (см. там же): метод с этим именем на прототипе подкласса затенил бы
  // аксессор Container.prototype.onRender, сеттер не отработал бы и PixiJS
  // не позвал бы ничего — фича молча мертва
  _updateSeeThrough() {
    if (!this._levelView || !this.mapSprite) {
      return;
    }

    const cfg = this._levelView.cfg;
    // сглаживание по времени тикера общего приложения
    const dt = Ticker.shared.deltaMS / 1000;
    const rate = Math.min(1, cfg.fadeRate * dt);

    // путь отхода: гаснет весь слой целиком (прежнее поведение)
    if (this._levelView.mode === 'layer') {
      const under =
        this._levelView.level < this._level &&
        this._hasFloorAt(this._levelView.x, this._levelView.y);

      this._targetAlpha = under ? cfg.layerAlpha : 1;
      this.alpha += (this._targetAlpha - this.alpha) * rate;

      return;
    }

    // режим 'hole': проверки пола нет — дыра ездит за игроком, и её край
    // сам показывает, где кончается плита
    const above = this._levelView.level < this._level;

    this._holeStrength += ((above ? 1 : 0) - this._holeStrength) * rate;
    this._updateHole(cfg);
  }

  // дыра вокруг игрока: внутри слоя нужна не одна alpha, а поле по пикселям,
  // поэтому единственный способ — фильтр. Центр приходит в пикселях кадра
  // фильтра, то есть в экранных: мировая точка умножается на трансформ сцены
  // (камера — он и есть, см. src/client/camera.js)
  _updateHole(cfg) {
    const stage = this.parent;

    if (this._holeStrength < HOLE_EPSILON || !stage) {
      if (this._holeAttached) {
        this.filters = [];
        this._holeAttached = false;
      }

      return;
    }

    if (!this._holeFilter) {
      this._holeFilter = createHoleFilter(cfg);
    }

    if (!this._holeAttached) {
      this.filters = [this._holeFilter];
      this._holeAttached = true;
    }

    setHoleUniforms(this._holeFilter, {
      centerX: this._levelView.x * stage.scale.x + stage.position.x,
      centerY: this._levelView.y * stage.scale.y + stage.position.y,
      radius: cfg.radius * stage.scale.x,
      softness: cfg.softness,
      // дыра открывается не рывком: сила перехода живёт в минимальной alpha
      minAlpha: 1 + (cfg.minAlpha - 1) * this._holeStrength,
    });
  }

  // ящик: точечная сущность, ей хватает одной alpha на всё тело. Заодно
  // затемняется, если игрок над ним (единый признак «ниже — темнее»)
  _updateDynamicSeeThrough() {
    if (!this._levelView || !this.sprite) {
      return;
    }

    this.alpha = this._levelView.alphaFor(
      this._level,
      this._worldX,
      this._worldY,
    );
    this.tint = this._levelView.tintFor(this._level);
  }

  // позиция приходит в мировых единицах, а грид слоя не масштабирован:
  // контейнер целиком носит `data.scale`, поэтому деление на масштаб живёт
  // ЗДЕСЬ (ровно как в update() для динамики), а сервис хранит мир как есть
  _hasFloorAt(worldX, worldY) {
    const col = Math.floor(worldX / this.scale.x / this._step);
    const row = Math.floor(worldY / this.scale.y / this._step);
    const tile = this._map?.[row]?.[col];

    return tile !== undefined && this._floor.includes(tile);
  }

  update(data) {
    if (this.sprite) {
      this.sprite.x = data[C_X] / this.scale.x;
      this.sprite.y = data[C_Y] / this.scale.y;
      this.sprite.rotation = data[C_ANGLE];
    }

    this._worldX = data[C_X];
    this._worldY = data[C_Y];

    // ящик может уехать на мост и упасть с него: уровень едет строкой
    // кадра, и порядок отрисовки обязан ехать за ним
    const level = data[C_LEVEL] || 0;

    if (level !== this._level) {
      this._level = level;
      this.zIndex = levelZ(this._layer, level);
    }
  }

  destroy(options) {
    if (this._holeFilter) {
      this.filters = [];
      this._holeAttached = false;
      this._holeFilter.destroy();
      this._holeFilter = null;
    }

    if (this.mapSprite) {
      this.mapSprite.destroy({
        children: true,
        texture: true,
        textureSource: true,
      });
      this.mapSprite = null;
    }

    super.destroy({
      children: true,
      texture: false,
      textureSource: false,
      ...options,
    });

    // если текстуры были загружены через Assets.load
    // и больше не нужны глобально,
    // выгрузить из кеша Assets
    if (this._assetUrl) {
      if (Assets.cache.has(this._assetUrl)) {
        Assets.unload(this._assetUrl).catch(err =>
          console.warn(
            `Failed to unload asset ${this._assetUrl} (was in cache):`,
            err,
          ),
        );
      }
    }

    // обнуление ссылок
    this.sprite = null;
    this._baseTexturePromise = null;
    this._assetUrl = null;
    this._map = null;
    this._tiles = null;
    this._floor = null;
    this._spriteSheetData = null;
    this._renderer = null;
    this._levelView = null;
  }
}
