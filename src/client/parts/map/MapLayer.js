import { Container, Sprite, Texture, Assets, Ticker } from 'pixi.js';
import { levelZ } from '../../levelZ.js';
import { cameraCenter } from '../../camera.js';
import { applyParallax, offsetPoint } from '../../parallax.js';
import { bakeTileLayer } from '../bakeTileLayer.js';
import { buildRampLanes } from '../rampLanes.js';
import {
  createHole,
  advance as advanceHole,
  apply as applyHole,
  dispose as disposeHole,
} from './holeOverlay.js';
import {
  buildVolumeSlices,
  buildRampMeshes,
  updateRampMesh,
} from './extrusion.js';
import {
  parallax as parallaxConfig,
  volume as volumeConfig,
} from '../../../config/render.js';

// базовый zIndex контейнера-перекрывателя: объём слоя рисуется НАД
// динамикой СВОЕГО уровня, иначе танк «наезжает» на стену вместо того,
// чтобы уйти за неё (экструзия идёт ОТ центра камеры, то есть накрывает
// область за стеной — ровно там танк и стоит). 5 — выше танка (3), дыма
// (4), бомб и эффектов (2) и следов (1), и заведомо меньше шага уровней
// (`parallax.levelZStride`): слой уровня N + 1 по-прежнему выше всего,
// что принадлежит уровню N
const OCCLUDER_BASE_Z = 5;

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

    this._targetAlpha = 1;

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
    const scale = data.scale;

    this._baseScaleX = typeof scale === 'number' ? scale : scale.x;
    this._baseScaleY = typeof scale === 'number' ? scale : scale.y;
    this._baseScale = { x: this._baseScaleX, y: this._baseScaleY };

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

      const bakedTexture = await bakeTileLayer({
        baseTexture,
        spriteSheetData: this._spriteSheetData,
        map: this._map,
        tiles: this._tiles,
        step: this._step,
        renderer: this._renderer,
      });

      // повторно: запекание — второй await, и текстура уже создана, поэтому
      // уничтоженному парту её нужно не бросить, а освободить
      if (this._container.destroyed) {
        bakedTexture.destroy(true);

        return;
      }

      // один большой спрайт из "запеченной" текстуры
      this.mapSprite = new Sprite(bakedTexture);
      applyParallax(this.mapSprite, null, this._parallaxK, this._baseScale);
      this._container.addChild(this.mapSprite);

      if (this._extruding) {
        await this._createExtrusion(baseTexture, bakedTexture);
      }
    } catch (error) {
      console.error(
        `Failed to create static map with asset ${this._assetUrl}:`,
        error,
      );
    }
  }

  // Экструзия слоя: объём (`volume`) — K копий ТОЙ ЖЕ запечённой картинки,
  // каждая следующая сдвинута от центра камеры сильнее предыдущей; клин
  // рампы — по мешу на прогон, наклонная плоскость с непрерывно растущей
  // высотой (`buildRampMeshes`, src/client/parts/map/extrusion.js).
  //
  // Срезы ОБЪЁМА уходят в контейнер-перекрыватель (сиблинг парта на сцене):
  // им нужен zIndex выше динамики своего уровня, иначе танк рисуется поверх
  // стены, за которой стоит. Прозрачность и «дыра» у перекрывателя свои —
  // считаются той же формулой, что у слоя (`_updateSeeThrough`).
  //
  // Клин рампы, наоборот, остаётся ребёнком парта: танк, поднимающийся по
  // горке, обязан рисоваться ПОВЕРХ её поверхности
  async _createExtrusion(baseTexture, bakedTexture) {
    const count = volumeConfig.slices;
    const shear = parallaxConfig.shear;
    const slices = [];

    if (this._volume > 0) {
      this._occluder = new Container();
      this._occluder.zIndex = levelZ(
        Math.max(this._layer, OCCLUDER_BASE_Z),
        this._level,
      );

      slices.push(
        ...buildVolumeSlices({
          bakedTexture,
          level: this._level,
          volume: this._volume,
          shear,
          count,
          sideTint: volumeConfig.sideTint,
        }),
      );
    }

    const runs = this._rampLanes();

    if (runs.length) {
      const rampTiles = this._ramps.map(ramp => ramp.tile);

      this._rampTexture = await bakeTileLayer({
        baseTexture,
        spriteSheetData: this._spriteSheetData,
        map: this._map,
        tiles: rampTiles,
        step: this._step,
        renderer: this._renderer,
      });

      // третий await: парт мог уйти, пока пеклась текстура клина
      if (this._container.destroyed) {
        const texture = this._rampTexture;

        this._rampTexture = null;
        texture.destroy(true);

        return;
      }

      slices.push(
        ...buildRampMeshes({
          runs,
          texture: this._rampTexture,
          step: this._step,
          shear,
          baseScale: this._baseScale,
          segments: volumeConfig.rampSegments,
          sideTint: volumeConfig.sideTint,
        }),
      );
    }

    if (this._container.destroyed) {
      return;
    }

    // порядок отрисовки — по высоте: выше срез, позже он нарисован. Плоский
    // слой остаётся основанием и уже лежит первым
    slices.sort((a, b) => a.k - b.k);

    for (const slice of slices) {
      // меш клина уже стоит в мировых вершинах: до первого кадра он лежит
      // без сдвига, как и слой без камеры
      if (!slice.base) {
        applyParallax(slice.target, null, slice.k, this._baseScale);
      }

      (slice.occluder ? this._occluder : this._container).addChild(
        slice.target,
      );
      this._slices.push(slice);
    }
  }

  // Полосы рамп ЭТОГО слоя в клетках его грида. Прогоны приходят из ядра
  // в МИРОВЫХ единицах (`tile_size == step * scale`), а грид слоя не
  // масштабирован: перевод тот же, что у `_hasTileAt`.
  //
  // Уровень задаёт сервис (`forLevel`), а слой среди них берёт только свои
  // горки: у карты слой земли и слой стен делят один грид, и клин рисует
  // тот из них, чьи тайлы рампы он и рисует. Тайла в прогоне нет — рампы
  // сличаются по паре уровней «подножие/вершина»
  _rampLanes() {
    if (!this._ramps?.length || !this._rampRuns) {
      return [];
    }

    const owned = new Set(this._ramps.map(ramp => `${ramp.from}:${ramp.to}`));
    const runs = this._rampRuns
      .forLevel(this._level)
      .filter(run => owned.has(`${run.from}:${run.to}`));

    const toCell = (world, axis) => {
      const scale = axis === 0 ? this._baseScaleX : this._baseScaleY;

      return Math.round(world / scale / this._step);
    };

    return buildRampLanes(runs, toCell);
  }

  // Каждый кадр у статического слоя: видимость (плита моста) и параллакс —
  // и слоя, и его срезов. Зовётся из колбэка `onRender` парта-диспетчера
  // (`Map.js`): там он кладётся СВОЙСТВОМ, потому что `onRender` у
  // Container — аксессор, а не метод
  render() {
    this._attachOccluder();

    // центр камеры считается ОДИН раз за кадр и уходит параметром во всё,
    // что его просит: и прозрачность, и параллакс, и клин рампы работают
    // одним и тем же числом, а не тремя одинаковыми объектами
    const camera = cameraCenter(this._container.parent, this._renderer);

    // прозрачность считает плита моста и любой слой с перекрывателем: у
    // второго объём гаснет уже на уровне игрока
    if (this._level >= 1 || this._occluder) {
      this._updateSeeThrough(camera);
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

  // прозрачность плиты моста над локальным игроком: в GTA 2 игрок под
  // эстакадой продолжает видеть свою машину. Считается по НАШЕМУ гриду
  // уровня: парт уже знает и карту слоя, и список тайлов пола
  _updateSeeThrough(camera) {
    if (!this._levelView) {
      return;
    }

    const cfg = this._levelView.cfg;
    // сглаживание по времени тикера общего приложения
    const dt = Ticker.shared.deltaMS / 1000;
    const rate = Math.min(1, cfg.fadeRate * dt);

    if (this.mapSprite) {
      this._updateLayerSeeThrough(cfg, rate, camera);
    }

    if (this._occluder) {
      this._updateOccluderSeeThrough(cfg, rate, camera);
    }
  }

  // сам слой: гаснет только то, что НАД игроком
  _updateLayerSeeThrough(cfg, rate, camera) {
    // путь отхода: гаснет весь слой целиком (прежнее поведение)
    if (this._levelView.mode === 'layer') {
      const under =
        this._levelView.level < this._level &&
        this._hasTileAt(this._levelView.x, this._levelView.y, this._floorSet);

      this._targetAlpha = under ? cfg.layerAlpha : 1;
      this._container.alpha +=
        (this._targetAlpha - this._container.alpha) * rate;

      return;
    }

    // режим 'hole': проверки пола нет — дыра ездит за игроком, и её край
    // сам показывает, где кончается плита
    const above = this._levelView.level < this._level;

    advanceHole(this._hole, above, rate);
    applyHole(
      this._container,
      this._hole,
      cfg,
      this._levelView,
      this._container.parent,
      camera,
    );
  }

  // Перекрыватель: гаснет ДВУМЯ путями. Объём чужого уровня НАД игроком —
  // как и раньше, вместе со своим слоем (перила моста обязаны исчезать
  // вместе с плитой). Объём СВОЕГО уровня — только когда он реально
  // закрывает танк: экструзия уходит от центра камеры и накрывает область
  // за стеной, поэтому «дыра всегда» превращала стены в полупрозрачные
  // пятна и объём переставал читаться.
  _updateOccluderSeeThrough(cfg, rate, camera) {
    const above = this._level > this._levelView.level;

    if (this._levelView.mode === 'layer') {
      // путь отхода: чужой уровень гаснет целиком, свой не гаснет вовсе
      const alpha = above ? cfg.layerAlpha : 1;

      this._occluder.alpha += (alpha - this._occluder.alpha) * rate;

      return;
    }

    const hides = above || this._volumeHidesPlayer(camera);

    advanceHole(this._occluderHole, hides, rate);
    applyHole(
      this._occluder,
      this._occluderHole,
      cfg,
      this._levelView,
      this._container.parent,
      camera,
    );
  }

  // Накрывает ли объём этого слоя нарисованную точку игрока.
  //
  // Срез объёма на высоте k рисует тайл из мировой точки w в точке
  // `w + (w - cam) * k`. Значит по нарисованной точке игрока `p` исходная
  // клетка среза считается обратной формулой `w = (p + cam * k) / (1 + k)`:
  // если в ней есть тайл этого слоя, срез накрывает танк. Проверяются те же
  // k, что и рисуются, — ни одного лишнего среза.
  _volumeHidesPlayer(camera) {
    if (!camera || !this._map) {
      return false;
    }

    const view = this._levelView;
    const shear = parallaxConfig.shear;
    const point = offsetPoint(view.x, view.y, camera, view.z * shear);
    const count = volumeConfig.slices;

    for (let i = 1; i <= count; i += 1) {
      const k = (this._level + (this._volume * i) / count) * shear;
      const scale = 1 + k;

      if (
        this._hasTileAt(
          (point.x + camera.x * k) / scale,
          (point.y + camera.y * k) / scale,
          this._tileSet,
        )
      ) {
        return true;
      }
    }

    return false;
  }

  // Есть ли в мировой точке тайл из набора `tiles`: набор тайлов ЭТОГО слоя
  // отвечает на вопрос «нарисован ли там объём», набор пола — «есть ли там
  // плита». Перевод один на оба: позиция приходит в мировых единицах, а грид
  // слоя не масштабирован — масштаб карты живёт ЗДЕСЬ (ровно как в update()
  // для динамики), а сервис хранит мир как есть
  _hasTileAt(worldX, worldY, tiles) {
    const col = Math.floor(worldX / this._baseScaleX / this._step);
    const row = Math.floor(worldY / this._baseScaleY / this._step);
    const tile = this._map?.[row]?.[col];

    return tile !== undefined && tiles.has(tile);
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
