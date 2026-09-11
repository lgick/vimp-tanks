import { Texture, Assets } from 'pixi.js';
import { levelZ } from '../../levelZ.js';
import { cameraCenter } from '../../camera.js';
import { applyParallax } from '../../parallax.js';
import { baseScale, tileGrid } from './tileGrid.js';
import { createHole, dispose as disposeHole } from './holeOverlay.js';
import { buildLayerAssets } from './layerAssets.js';
import { updateSeeThrough } from './layerSeeThrough.js';
import { updateRampMesh } from './extrusion.js';
import {
  parallax as parallaxConfig,
  volume as volumeConfig,
} from '../../../config/render.js';

// Статический слой карты: запечённый тайл-лист, его параллакс, экструзия
// объёма и клина рампы, прозрачность плиты моста. Стратегия рисует В
// КОНТЕЙНЕР парта: ей нужны и дети, и zIndex, и alpha, и filters самого
// парта.
export default class MapLayer {
  constructor(container, data, dependencies, imageBase) {
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
    this._spriteSheetData = data.spriteSheet;
    this._step = data.step;
    this._layer = Number(data.layer) || 1;
    container.zIndex = levelZ(this._layer, this._level);

    // слой уровня N висит НАД землёй: его сдвиг от центра камеры — тот же
    // параллакс, что у объёмов и у танков. Без него плита моста рисуется
    // ровно в координатах асфальта и читается как глухая стена
    this._parallaxK = this._level * parallaxConfig.shear;

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

    // прозрачность считает только плита моста, параллакс — она же и любой
    // слой с объёмом: вешать колбэк на плоский слой уровня 0 значило бы
    // звать его каждый кадр ради выхода по первой же строке
    this.needsRender = this._level >= 1 || this._extruding;

    // грид тайлов значением: им одним отвечают на вопрос «что нарисовано
    // в этой мировой точке» (`tileGrid.tileAt`)
    this._grid = tileGrid(this._map, this._baseScale, this._step);

    this._build(data);
  }

  // Сборка ассетов слоя. Спецификация уходит в `layerAssets` значением, а
  // готовые объекты возвращаются оттуда и раскладываются по полям ЗДЕСЬ:
  // владелец состояния — парт, модуль сборки его полей не знает.
  async _build(data) {
    const assets = await buildLayerAssets({
      container: this._container,
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
      volume: this._volume,
      grid: this._grid,
      tileSet: this._tileSet,
      floorSet: this._floorSet,
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

    if (this.mapSprite) {
      applyParallax(this.mapSprite, camera, this._parallaxK, this._baseScale);
    }

    for (let i = 0; i < this._slices.length; i += 1) {
      const slice = this._slices[i];

      if (slice.base) {
        updateRampMesh(slice, camera);
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
    const slices = this._slices;

    this.mapSprite = null;
    this._rampTexture = null;
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
      container.removeChild(mapSprite);
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

    return () => {
      // срезы объёма делят запечённую текстуру с плоским слоем —
      // освобождает её один владелец, спрайт слоя. Текстуру клина делят его
      // меши, и она тоже своя: источник отдаётся здесь один раз
      if (rampTexture) {
        rampTexture.destroy(true);
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
