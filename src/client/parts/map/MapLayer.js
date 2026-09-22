import { Container, Texture, Assets } from 'pixi.js';
import { levelZ } from '../../levelZ.js';
import { cameraCenter } from '../../camera.js';
import { applyParallax } from '../../parallax.js';
import { baseScale, tileGrid } from './tileGrid.js';
import { createHole, dispose as disposeHole } from './holeOverlay.js';
import { buildLayerAssets } from './layerAssets.js';
import { updateSeeThrough } from './layerSeeThrough.js';
import {
  updateHeightMesh,
  updateWallMesh,
  orderWallMesh,
} from './extrusion.js';
import { cellsOfTiles, mapKeyOf } from '../../lighting/lightMath.js';
import {
  buildLayerAnimations,
  destroyLayerAnimations,
  hasAnimations,
  layerAnimationSpec,
  updateLayerAnimations,
} from './layerAnimations.js';
import {
  parallax as parallaxConfig,
  volume as volumeConfig,
} from '../../../config/render.js';

// Статический слой карты: запечённый тайл-лист, его параллакс, экструзия
// объёма и клина рампы, прозрачность плиты моста. Стратегия рисует В
// КОНТЕЙНЕР парта: ей нужны и дети, и zIndex, и alpha, и filters самого
// парта.
export default class MapLayer {
  constructor(container, data, dependencies, imageBase, assets = {}) {
    this._container = container;
    this._renderer = dependencies.renderer;

    // где локальный игрок (сервис игры, src/client/levelView.js): нужен
    // только слоям уровня >= 1 — они уступают ему видимость
    this._levelView = dependencies.levelView || null;

    // прогоны рамп из ядра (сервис игры, src/client/index.js): по ним слой
    // строит клин горки. Источник один с физикой — второй обход грида на
    // JS расходился бы с ядром молча
    this._rampRuns = dependencies.rampRuns || null;

    // режим 'hole': фильтр «дыры» и её сила (0 — игрок не под слоем).
    // Фильтр создаётся лениво: слоёв уровня >= 1 на карте может не быть
    // вовсе, а программу шейдера тогда компилировать не за что. У слоя и у
    // его перекрывателя фильтры РАЗНЫЕ: у Pixi фильтр несёт свои uniform'ы,
    // одним на две цели не обойтись
    this._hole = createHole();
    this._occluderHole = createHole();

    // контейнер-перекрыватель: срезы объёма слоя живут не в парте, а
    // сиблингом на сцене — только так они получают zIndex ВЫШЕ динамики
    // своего уровня (см. OCCLUDER_BASE_Z). Клин рампы остаётся в парте:
    // танк, поднимающийся по горке, обязан рисоваться ПОВЕРХ её поверхности
    this._occluder = null;

    // масштаб карты держим числами: у статического слоя сам контейнер
    // остаётся единичным (мировые координаты), а `data.scale` носят его
    // дети — каждый вместе со своим сдвигом параллакса
    this._baseScale = baseScale(data.scale);

    // срезы экструзии: объём слоя и клин рампы. `{ target, k }` — контейнер
    // (или спрайт) и его высота в долях сдвига
    this._slices = [];
    this._rampTexture = null;
    // боковые текстуры объёма: по одной на тайл слоя, с повтором
    this._wallTextures = [];
    this.mapSprite = null; // спрайт для "запеченной" карты

    this._assetUrl = `${imageBase}${data.spriteSheet.img}`;
    this._baseTexturePromise = Assets.load(this._assetUrl);

    // data состоит из:
    // layer - слой,
    // tiles - массив с названиями тайлов,
    // spriteSheet - объект с данными картинки (например, PIXI.Spritesheet),
    // map - двумерный массив карты,
    // step - размер шага,
    // volume - высота слоя в уровнях (0 — плоский),
    // ramps - конфиги рамп ЭТОГО уровня как объявлены в карте.
    this._map = data.map;
    this._tiles = data.tiles;
    this._level = data.level || 0;
    this._floor = data.floor || [];

    // наборы для пофреймовых проверок (`_hasTileAt`): `includes` по
    // массиву зовётся до `volume.slices` раз на слой в кадр
    this._tileSet = new Set(this._tiles);
    this._floorSet = new Set(this._floor);

    // крыша (`game.roofs`): слой, ВСЕ тайлы которого — крыши его уровня. Она
    // не прозрачна и не снимает затемнение, пока не закрывает сам танк.
    // Крыше нужен свой рендер-слой: в смеси с плитой прозрачность решалась
    // бы одним правилом на обе
    this._roof = isRoofLayer(data.game, this._level, this._tiles);
    this._spriteSheetData = data.spriteSheet;
    this._step = data.step;
    this._layer = Number(data.layer) || 1;
    container.zIndex = levelZ(this._layer, this._level);

    // слой уровня N висит НАД землёй: его сдвиг от центра камеры — тот же
    // параллакс, что у объёмов и у танков. Без него плита моста рисуется
    // ровно в координатах асфальта и читается как глухая стена
    this._parallaxK = this._level * parallaxConfig.shear;

    // Корень слоя: запечённый спрайт и над ним контейнер `animated`
    // (анимированные тайлы, декали, дневной неон). Параллакс и масштаб
    // карты — у корня, поэтому живые спрайты едут вместе с картинкой.
    // Фильтр дыры и alpha плиты остаются на контейнере парта: в нём же
    // лежит клин рампы, и гаснуть обязаны оба
    this._layerRoot = new Container();
    this._layerRoot.label = 'layerRoot';
    this._animated = new Container();
    this._animated.label = 'animated';
    this._layerRoot.addChild(this._animated);
    applyParallax(this._layerRoot, null, this._parallaxK, this._baseScale);
    container.addChild(this._layerRoot);

    // анимации карты (`game.animatedTiles`, `signs`, `decals`), которыми
    // владеет ЭТОТ слой; строятся в `_build`
    this._animationSpec = layerAnimationSpec(
      data.game,
      this._tiles,
      this._level,
      this._layer,
    );
    this._animations = null;
    this._game = data.game;

    this._volume = Number(data.volume) || 0;

    // клин строит только тот рендер-слой, который сами тайлы рампы и
    // рисует: у карты слой земли и слой стен делят один грид
    this._ramps = (data.ramps || []).filter(ramp =>
      this._tiles.includes(ramp.tile),
    );

    this._extruding =
      volumeConfig.enabled &&
      volumeConfig.slices >= 1 &&
      (this._volume > 0 || this._ramps.length > 0);

    // грид тайлов значением: им одним отвечают на вопрос «что нарисовано
    // в этой мировой точке» (`tileGrid.tileAt`)
    this._grid = tileGrid(this._map, this._baseScale, this._step);

    // Ночь и освещение (сервис игры, src/client/lighting/). Строго СИНХРОННО,
    // до `_build` и любого await: иначе сервис станет «ночным» с задержкой,
    // и эмиссив первого кадра (неон) получит `addEmissive → false` и
    // останется без свечения. Часть не знает, какие ещё слои есть на карте, поэтому
    // «первой» не бывает — только счётчик по ключу карты; фонари создаёт
    // сам сервис
    this._lighting = dependencies.lighting?.enabled
      ? dependencies.lighting
      : null;
    this._mapKey = null;

    if (this._lighting) {
      this._lighting.registerTextures({
        radial: assets.lightRadialTexture,
        head: assets.lampHeadTexture,
      });
      this._mapKey = mapKeyOf(data);
      this._lighting.acquireMap(
        this._mapKey,
        data.game?.lighting,
        this._step,
        data.scale,
        {
          cols: Math.max(0, ...this._map.map(row => row.length)),
          rows: this._map.length,
        },
      );

      // вклад слоя в маску этажа: клетки его тайлов пола (перила уже в
      // `floor`); вклады слоёв одного уровня сервис объединяет. Крыша
      // вкладывает только свои клетки — в отдельную карту крыш
      if (this._level >= 1) {
        this._lighting.setLevelMask(
          this._level,
          cellsOfTiles(this._map, this._roof ? this._tiles : this._floor),
          this,
          { roof: this._roof },
        );
      }

      // вершины объёмов: карта освещённости уровня закрывает их полумраком,
      // иначе верхний срез стены ловит фары танка на земле
      if (this._volume > 0) {
        this._lighting.setVolumeTops(
          this._level,
          cellsOfTiles(this._map, this._tiles),
          this._volume,
          this,
        );
      }
    }

    // прозрачность считает только плита моста, параллакс — она же и любой
    // слой с объёмом: вешать колбэк на плоский слой уровня 0 значило бы
    // звать его каждый кадр ради выхода по первой же строке. На ночной
    // карте колбэк нужен любому слою: он ведёт сервис освещения
    this.needsRender =
      this._level >= 1 ||
      this._extruding ||
      Boolean(this._lighting?.isNight()) ||
      hasAnimations(this._animationSpec);

    this._build(data);
  }

  // Сборка ассетов слоя. Спецификация уходит в `layerAssets` значением, а
  // готовые объекты возвращаются оттуда и раскладываются по полям ЗДЕСЬ:
  // владелец состояния — парт, модуль сборки его полей не знает.
  async _build(data) {
    const assets = await buildLayerAssets({
      container: this._container,
      layerRoot: this._layerRoot,
      exclude: this._animationSpec.exclude,
      baseTexture: this._baseTexturePromise,
      spriteSheetData: data.spriteSheet,
      map: this._map,
      tiles: this._tiles,
      step: this._step,
      renderer: this._renderer,
      level: this._level,
      layer: this._layer,
      volume: this._volume,
      ramps: this._ramps,
      rampRuns: this._rampRuns,
      baseScale: this._baseScale,
      parallaxK: this._parallaxK,
      extruding: this._extruding,
      assetUrl: this._assetUrl,
      isAborted: () => this._container.destroyed,
    });

    this.mapSprite = assets.mapSprite;
    this._occluder = assets.occluder;
    this._slices = assets.slices;
    this._rampTexture = assets.rampTexture;
    this._wallTextures = assets.wallTextures ?? [];

    // Анимации — после запекания (тайл-лист уже загружен) и после
    // синхронного `acquireMap` конструктора: вывеска спрашивает у сервиса
    // освещения, ночь ли, и ответ фиксирует навсегда
    if (
      !this.mapSprite ||
      this._container.destroyed ||
      !hasAnimations(this._animationSpec)
    ) {
      return;
    }

    this._animations = await buildLayerAnimations({
      spec: this._animationSpec,
      game: this._game,
      baseTexture: await this._baseTexturePromise,
      spriteSheetData: data.spriteSheet,
      map: this._map,
      tiles: this._tiles,
      step: this._step,
      scale: this._baseScale,
      level: this._level,
      animated: this._animated,
      renderer: this._renderer,
      lighting: this._lighting,
      isAborted: () => this._container.destroyed,
    });
  }

  // Что нужно `layerSeeThrough` — одним значением, без единого поля парта
  // на той стороне. Собирается каждый кадр: `mapSprite` и `_occluder`
  // появляются асинхронно, а `parent` парт получает уже после конструктора
  _seeThroughView() {
    return {
      levelView: this._levelView,
      container: this._container,
      stage: this._container.parent,
      occluder: this._occluder,
      hasSprite: Boolean(this.mapSprite),
      hole: this._hole,
      occluderHole: this._occluderHole,
      level: this._level,
      grid: this._grid,
      tileSet: this._tileSet,
      floorSet: this._floorSet,
      roof: this._roof,
    };
  }

  // Каждый кадр у статического слоя: видимость (плита моста) и параллакс —
  // и слоя, и его срезов. Зовётся из колбэка `onRender` парта-диспетчера
  // (`Map.js`): там он кладётся СВОЙСТВОМ, потому что `onRender` у
  // Container — аксессор, а не метод
  render() {
    this._attachOccluder();

    // центр камеры считается ОДИН раз за кадр и уходит параметром во всё,
    // что его просит: и прозрачность, и параллакс, и клин рампы работают
    // одним и тем же числом, а не тремя одинаковыми объектами. Считает его
    // сервис (`levelView`), а не слой: иначе дыра в плите ехала бы по
    // свежей проекции, а alpha сущностей — по прошлой
    if (this._levelView) {
      this._levelView.attachStage(this._container.parent, this._renderer);
    }

    const camera = this._levelView
      ? this._levelView.camera()
      : cameraCenter(this._container.parent, this._renderer);

    // карты освещённости: реальная работа — раз на трансформ сцены
    if (this._lighting) {
      this._lighting.attachStage(this._container.parent, this._renderer);
      this._lighting.render();
    }

    if (this._animations) {
      // вывески на крыше гаснут вместе с ней, а не по кругу вокруг игрока
      const roofAlpha =
        this._roof && this._levelView
          ? 1 + (this._levelView.cfg.minAlpha - 1) * this._hole.strength
          : null;

      updateLayerAnimations(this._animations, {
        camera,
        levelView: this._levelView,
        screen: this._renderer?.screen,
        roofAlpha,
      });
    }

    // прозрачность считает плита моста и любой слой с перекрывателем: у
    // второго объём гаснет уже на уровне игрока
    if (this._level >= 1 || this._occluder) {
      updateSeeThrough(this._seeThroughView(), camera);
    }

    if (!this._parallaxK && !this._slices.length) {
      return;
    }

    if (!camera) {
      return;
    }

    applyParallax(this._layerRoot, camera, this._parallaxK, this._baseScale);

    for (let i = 0; i < this._slices.length; i += 1) {
      const slice = this._slices[i];

      if (slice.walls) {
        updateWallMesh(slice, camera, volumeConfig.faceBleedPx);
        orderWallMesh(slice, camera);
      } else if (slice.base) {
        updateHeightMesh(slice, camera);
      } else {
        applyParallax(slice.target, camera, slice.k, this._baseScale);
      }
    }
  }

  // Перекрыватель кладётся на сцену рядом с партом, а не в него: порядок
  // отрисовки решает zIndex, а внутри парта объём был бы связан со слоем.
  // Сцена появляется позже конструктора (парт добавляют после создания), а
  // экструзия и вовсе асинхронная, поэтому привязка ленивая
  _attachOccluder() {
    const stage = this._container.parent;

    if (!this._occluder || !stage || this._occluder.parent === stage) {
      return;
    }

    stage.addChild(this._occluder);
  }

  // Освобождение слоя. Порядок обязателен: снять фильтры -> снять
  // перекрыватель со сцены -> обнулить текстуры уцелевших срезов -> убрать
  // `mapSprite` из детей. Всё, что обязано пережить `super.destroy` парта,
  // уходит в возвращаемый колбэк: диспетчер зовёт его ПОСЛЕ, иначе
  // последний кадр рендерит источник, у которого `resource === null`
  destroy() {
    const container = this._container;

    // анимации первыми: вывески снимают свои источники и эмиссив из
    // сервиса, пока он ещё держит карту; текстуры — в колбэке ниже
    const releaseAnimations = destroyLayerAnimations(this._animations);

    this._animations = null;

    // ключ карты освещения и вклад в маску этажа снимаются первыми: на нуле
    // счётчика текущего ключа сервис освобождает карту (сначала со сцены)
    if (this._lighting) {
      this._lighting.releaseMap(this._mapKey, this);
      this._lighting = null;
    }

    disposeHole(this._hole, container);

    // перекрыватель живёт на сцене, а не в парте: снимается вручную —
    // сначала со сцены, потом ресурсы. Запечённую текстуру он делит со
    // слоем, поэтому отдаёт её не он (см. ниже, mapSprite)
    if (this._occluder) {
      const occluder = this._occluder;

      this._occluder = null;
      occluder.filters = [];
      disposeHole(this._occluderHole, occluder);

      occluder.parent?.removeChild(occluder);
      occluder.destroy({
        children: true,
        texture: false,
        textureSource: false,
      });
    }

    // сначала снять со сцены, потом освобождать GPU-ресурс — иначе
    // последний кадр рендерит источник, у которого `resource === null`.
    // Спрайт выводится из-под `children: true`: иначе `super.destroy`
    // уничтожил бы его сам, обнулив `_texture`, и наш вызов с
    // `texture: true` упал бы на `null.destroy()`
    const mapSprite = this.mapSprite;
    const rampTexture = this._rampTexture;
    const wallTextures = this._wallTextures;
    const slices = this._slices;

    this.mapSprite = null;
    this._rampTexture = null;
    this._wallTextures = [];
    this._slices = [];

    // ссылки на общие источники снимаются ДО их освобождения: даже если
    // какой-то срез переживёт уничтожение (кадр, начатый до смены карты),
    // он нарисуется пустой текстурой, а не мёртвым источником — именно это
    // падало в BindGroup.setResource на смене карты
    for (const slice of slices) {
      if (!slice.target.destroyed) {
        slice.target.texture = Texture.EMPTY;
      }
    }

    if (mapSprite) {
      mapSprite.parent?.removeChild(mapSprite);
    }

    // обнуление ссылок
    this._baseTexturePromise = null;
    this._assetUrl = null;
    this._map = null;
    this._tiles = null;
    this._floor = null;
    this._tileSet = null;
    this._floorSet = null;
    this._grid = null;
    this._ramps = null;
    this._spriteSheetData = null;
    this._renderer = null;
    this._levelView = null;
    this._game = null;

    return () => {
      releaseAnimations();

      // срезы объёма делят запечённую текстуру с плоским слоем —
      // освобождает её один владелец, спрайт слоя. Текстуру клина делят его
      // меши, и она тоже своя: источник отдаётся здесь один раз
      if (rampTexture) {
        rampTexture.destroy(true);
      }

      // боковые текстуры объёма: своя на тайл, делят их только меши граней
      for (const texture of wallTextures) {
        texture.destroy(true);
      }

      if (mapSprite) {
        mapSprite.destroy({
          children: true,
          texture: true,
          textureSource: true,
        });
      }

      // Ассет игры — общий ресурс: один тайл-лист делят все слои карты, а
      // b1.png — ещё и все динамические тела ЛЮБОЙ карты.
      // Assets.unload в Pixi 8 не считает ссылки: он уничтожает
      // TextureSource, а тот эмитит change, по которому PixiJS обнуляет
      // BindGroup (BindGroup.onResourceChange), и следующий проход фильтра
      // падает в setResource. Кеш Assets переживает смену карты штатно,
      // поэтому здесь не выгружается ничего.
    };
  }
}

// Все ли тайлы слоя — крыши его уровня (`game.roofs`, ключ — уровень
// строкой или числом). Слой, где крыши смешаны с другими тайлами, крышей не
// считается: предупреждение и обычное поведение
function isRoofLayer(game, level, tiles) {
  const roofs = game?.roofs?.[level] ?? game?.roofs?.[String(level)];

  if (!Array.isArray(roofs) || roofs.length === 0 || !tiles?.length) {
    return false;
  }

  const set = new Set(roofs);
  const count = tiles.filter(tile => set.has(tile)).length;

  if (count > 0 && count < tiles.length) {
    console.warn(
      `MapLayer: level ${level} layer mixes roof tiles with others; a roof needs its own layer`,
    );

    return false;
  }

  return count === tiles.length;
}
