import {
  Container,
  Rectangle,
  Sprite,
  Texture,
  Assets,
  Ticker,
  MeshSimple,
} from 'pixi.js';
import { degToRad } from 'vimp-engine/lib/math.js';
import { levelZ } from '../levelZ.js';
import { cameraCenter } from '../camera.js';
import { applyParallax, offsetPoint } from '../parallax.js';
import { createHoleFilter, setHoleUniforms } from '../seeThrough.js';
import { bakeTileLayer } from './bakeTileLayer.js';
import { buildRampRuns } from './rampRuns.js';
import { parallax as parallaxConfig, volume as volumeConfig } from '../../config/render.js';
import {
  C_X,
  C_Y,
  C_ANGLE,
  C_LEVEL,
} from '../snapshotFields.js';

// ниже этой силы дыра неотличима от её отсутствия: фильтр снимается совсем,
// чтобы слой не платил за проход, которого не видно
const HOLE_EPSILON = 0.01;

// базовый zIndex контейнера-перекрывателя: объём слоя рисуется НАД
// динамикой СВОЕГО уровня, иначе танк «наезжает» на стену вместо того,
// чтобы уйти за неё (экструзия идёт ОТ центра камеры, то есть накрывает
// область за стеной — ровно там танк и стоит). 5 — выше танка (3), дыма
// (4), бомб и эффектов (2) и следов (1), и заведомо меньше шага уровней
// (`parallax.levelZStride`): слой уровня N + 1 по-прежнему выше всего,
// что принадлежит уровню N
const OCCLUDER_BASE_Z = 5;

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
    // вовсе, а программу шейдера тогда компилировать не за что. У слоя и у
    // его перекрывателя фильтры РАЗНЫЕ: у Pixi фильтр несёт свои uniform'ы,
    // одним на две цели не обойтись
    this._hole = { strength: 0, filter: null, attached: false };
    this._occluderHole = { strength: 0, filter: null, attached: false };

    // контейнер-перекрыватель: срезы объёма слоя живут не в парте, а
    // сиблингом на сцене — только так они получают zIndex ВЫШЕ динамики
    // своего уровня (см. OCCLUDER_BASE_Z). Клин рампы остаётся в парте:
    // танк, поднимающийся по горке, обязан рисоваться ПОВЕРХ её поверхности
    this._occluder = null;
    this._layer = 1;

    // мировая позиция динамического тела: alpha ящика считается по ней,
    // а sprite.x живёт в НЕмасштабированных координатах контейнера
    this._worldX = 0;
    this._worldY = 0;

    // масштаб карты держим числами: у статического слоя сам контейнер
    // остаётся единичным (мировые координаты), а `data.scale` носят его
    // дети — каждый вместе со своим сдвигом параллакса
    const scale = data.scale;

    this._baseScaleX = typeof scale === 'number' ? scale : scale.x;
    this._baseScaleY = typeof scale === 'number' ? scale : scale.y;
    this._baseScale = { x: this._baseScaleX, y: this._baseScaleY };

    // 2.5D: сдвиг слоя от центра камеры на своей высоте (src/client/parallax.js)
    this._parallaxK = 0;

    // срезы экструзии: объём слоя и клин рампы. `{ target, k }` — контейнер
    // (или спрайт) и его высота в долях сдвига
    this._slices = [];
    this._rampTexture = null;

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
      // step - размер шага,
      // volume - высота слоя в уровнях (0 — плоский),
      // ramps - конфиги рамп ЭТОГО уровня как объявлены в карте.
      this._map = data.map;
      this._tiles = data.tiles;
      this._level = data.level || 0;
      this._floor = data.floor || [];
      this._spriteSheetData = data.spriteSheet;
      this._step = data.step;
      this._layer = Number(data.layer) || 1;
      this.zIndex = levelZ(this._layer, this._level);

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
      // звать его каждый кадр ради выхода по первой же строке.
      //
      // `onRender` у Container — аксессор, а не метод: присваивание здесь
      // проходит через его сеттер (в конструкторе renderGroup ещё null, но
      // RenderGroup.addChild сам подхватит `_onRender` при добавлении на
      // сцену)
      if (this._level >= 1 || this._extruding) {
        this.onRender = () => this._updateStatic();
      }

      this.createStatic();
    }
    // если динамические данные
    else if (data.type === 'dynamic') {
      // тело живёт в мировых координатах: масштаб носит сам контейнер, а
      // параллакс своего уровня добавляется к нему тем же трансформом
      this.scale = data.scale;

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
      this._worldX = this._x * this._baseScaleX;
      this._worldY = this._y * this._baseScaleY;

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

      // парт мог быть уничтожен, пока грузился ассет: смена карты сносит
      // старые парты в том же тике, в котором создаёт новые
      if (this.destroyed) {
        return;
      }

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
      const baseTexture = await this._baseTexturePromise;

      // парт мог быть уничтожен, пока грузился ассет: смена карты сносит
      // старые парты в том же тике, в котором создаёт новые
      if (this.destroyed) {
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
      if (this.destroyed) {
        bakedTexture.destroy(true);

        return;
      }

      // один большой спрайт из "запеченной" текстуры
      this.mapSprite = new Sprite(bakedTexture);
      applyParallax(this.mapSprite, null, this._parallaxK, this._baseScale);
      this.addChild(this.mapSprite);

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
  // высотой (`_createRampMeshes`).
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

      for (let i = 1; i <= count; i += 1) {
        const sprite = new Sprite(bakedTexture);

        // нижние срезы — боковые грани блока, они темнее; верхний остаётся
        // самим слоем и рисуется последним, поверх остальных
        sprite.tint = i === count ? 0xffffff : volumeConfig.sideTint;

        slices.push({
          target: sprite,
          k: (this._level + (this._volume * i) / count) * shear,
          occluder: true,
        });
      }
    }

    const runs = this._ramps.length
      ? buildRampRuns(this._map, this._ramps)
      : [];

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
      if (this.destroyed) {
        const texture = this._rampTexture;

        this._rampTexture = null;
        texture.destroy(true);

        return;
      }

      slices.push(...this._createRampMeshes(runs, shear));
    }

    if (this.destroyed) {
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

      (slice.occluder ? this._occluder : this).addChild(slice.target);
      this._slices.push(slice);
    }
  }

  // Клин рампы: горка — наклонная ПЛОСКОСТЬ, а не лестница из срезов.
  // На прогон строится один меш-полоса вдоль оси прогона; у каждой её
  // вершины своя высота (`level + rise * progress`), поэтому сдвиг
  // параллакса растёт вдоль прогона непрерывно, а не ступенями.
  //
  // Вершины авторятся сразу в МИРОВЫХ единицах (пиксель грида × scale
  // слоя): контейнер статического слоя единичный, и меш в нём стоит без
  // собственного трансформа — двигаются только его вершины (_updateStatic)
  _createRampMeshes(runs, shear) {
    const meshes = [];
    const texture = this._rampTexture;
    const bakedWidth = texture.width || 1;
    const bakedHeight = texture.height || 1;
    const step = this._step;
    const perCell = Math.max(1, Math.round(volumeConfig.rampSegments) || 1);

    for (const run of runs) {
      const alongAxis = run.axis === 0;
      const cells = alongAxis ? run.col1 - run.col0 : run.row1 - run.row0;
      const segments = Math.max(1, cells * perCell);
      const x0 = run.col0 * step;
      const x1 = run.col1 * step;
      const y0 = run.row0 * step;
      const y1 = run.row1 * step;
      const points = segments + 1;
      // базовая плоскость прогона: уровень грида, в котором лежит тайл
      // рампы, то есть НИЖНИЙ уровень прогона
      const kBase = this._level * shear;
      const base = new Float32Array(points * 4);
      const uvs = new Float32Array(points * 4);
      const skirtUvs = new Float32Array(points * 4);
      // высота каждой вершины в долях сдвига: её и просит offsetPoint
      const heights = new Float32Array(points * 2);
      const indices = new Uint32Array(segments * 6);

      // UV юбки берутся не с самой кромки прогона: дальняя кромка
      // (`col1`/`row1`) — это уже СЛЕДУЮЩАЯ клетка, тайла рампы в ней нет,
      // и вертикальная грань, растянувшая её пиксели, оказывалась
      // прозрачной — насыпь читалась как пустая с одной стороны. Сдвиг
      // внутрь на пиксель грида ставит выборку внутрь крайнего тайла и на
      // картинке не виден
      const uvInset = 1;

      for (let i = 0; i < points; i += 1) {
        const t = i / segments;
        // «в горку» у прогонов разных направлений — разная сторона
        // прямоугольника: знак берётся из run.sign, как в ядре
        const progress = run.sign > 0 ? t : 1 - t;
        const k = (this._level + run.rise * progress) * shear;
        const along0 = alongAxis ? x0 : y0;
        const along1 = alongAxis ? x1 : y1;
        const along = along0 + (along1 - along0) * t;
        const ax = alongAxis ? along : x0;
        const ay = alongAxis ? y0 : along;
        const bx = alongAxis ? along : x1;
        const by = alongAxis ? y1 : along;
        const slot = i * 4;

        base[slot] = ax * this._baseScaleX;
        base[slot + 1] = ay * this._baseScaleY;
        base[slot + 2] = bx * this._baseScaleX;
        base[slot + 3] = by * this._baseScaleY;

        uvs[slot] = ax / bakedWidth;
        uvs[slot + 1] = ay / bakedHeight;
        uvs[slot + 2] = bx / bakedWidth;
        uvs[slot + 3] = by / bakedHeight;

        // те же точки, подтянутые внутрь прогона: ими текстурируется юбка
        const insetA = alongAxis ? ay + uvInset : ax + uvInset;
        const insetB = alongAxis ? by - uvInset : bx - uvInset;
        const alongInset = Math.min(
          Math.max(along, (alongAxis ? x0 : y0) + uvInset),
          (alongAxis ? x1 : y1) - uvInset,
        );

        skirtUvs[slot] = (alongAxis ? alongInset : insetA) / bakedWidth;
        skirtUvs[slot + 1] = (alongAxis ? insetA : alongInset) / bakedHeight;
        skirtUvs[slot + 2] = (alongAxis ? alongInset : insetB) / bakedWidth;
        skirtUvs[slot + 3] = (alongAxis ? insetB : alongInset) / bakedHeight;

        heights[i * 2] = k;
        heights[i * 2 + 1] = k;
      }

      for (let i = 0; i < segments; i += 1) {
        const v = i * 2;
        const slot = i * 6;

        indices[slot] = v;
        indices[slot + 1] = v + 1;
        indices[slot + 2] = v + 3;
        indices[slot + 3] = v;
        indices[slot + 4] = v + 3;
        indices[slot + 5] = v + 2;
      }

      const mesh = new MeshSimple({
        texture,
        vertices: base.slice(),
        uvs,
        indices,
      });

      // юбка рисуется ДО поверхности (её k — базовая плоскость прогона),
      // поэтому кладётся первой: сортировка срезов по k это же и даёт
      meshes.push(
        this._createRampSkirt({
          base,
          uvs: skirtUvs,
          heights,
          points,
          texture,
          kBase,
          // «верх» прогона: там торец закрыт, у подножия он остаётся
          // открытым — это законный вход
          endIndex: run.sign > 0 ? points - 1 : 0,
        }),
      );

      meshes.push({
        target: mesh,
        // порядок отрисовки — по вершине клина: выше всего он у своего
        // верхнего торца, там же он и обязан перекрывать соседей
        k: (this._level + run.rise) * shear,
        base,
        heights,
      });
    }

    return meshes;
  }

  // Юбка клина: горка — насыпь, а не парящая плоскость. Под поверхностью
  // прогона видна была бы земля, и карта врала бы — «пусто, значит проеду»,
  // хотя борта прогона закрыты коллайдерами-стражами движка
  // (`packages/engine/core/src/map.rs`, RAMP_GUARD_GROUP).
  //
  // Строятся ровно те грани, что закрыты физически: два борта ВДОЛЬ оси
  // (по обеим поперечным границам прогона) и торец на ВЕРХНЕМ конце.
  // Нижний торец остаётся открытым — через него на горку и заезжают.
  // Нижняя кромка ложится на базовую плоскость прогона (`kBase`), поэтому у
  // прогона 1 → 2 под юбкой остаётся видимый просвет — и проезд там
  // действительно есть.
  //
  // Ближняя к камере грань видна, дальняя всегда накрыта поверхностью,
  // поэтому выбирать сторону в рантайме не нужно.
  _createRampSkirt(surface) {
    const { base, uvs, heights, points, texture, kBase, endIndex } = surface;
    // колонки юбки: борт по одной поперечной границе, борт по другой и
    // две колонки торца
    const columns = points * 2 + 2;
    const skirtBase = new Float32Array(columns * 4);
    const skirtUvs = new Float32Array(columns * 4);
    const skirtHeights = new Float32Array(columns * 2);
    // квадов: по (points - 1) на каждый борт плюс один торцевой
    const quads = (points - 1) * 2 + 1;
    const indices = new Uint32Array(quads * 6);

    // источник вершины поверхности для колонки юбки: сперва борт A, затем
    // борт B, затем пара торца
    const sourceOf = column => {
      if (column < points) {
        return column * 2;
      }

      if (column < points * 2) {
        return (column - points) * 2 + 1;
      }

      return endIndex * 2 + (column - points * 2);
    };

    for (let column = 0; column < columns; column += 1) {
      const source = sourceOf(column);
      const slot = column * 4;
      const x = base[source * 2];
      const y = base[source * 2 + 1];

      // верхняя кромка идёт по поверхности, нижняя стоит в той же мировой
      // точке — разводит их только высота
      skirtBase[slot] = x;
      skirtBase[slot + 1] = y;
      skirtBase[slot + 2] = x;
      skirtBase[slot + 3] = y;

      // UV нижней кромки — те же, что у верхней: пиксели кромки тянутся
      // вниз по грани
      skirtUvs[slot] = uvs[source * 2];
      skirtUvs[slot + 1] = uvs[source * 2 + 1];
      skirtUvs[slot + 2] = uvs[source * 2];
      skirtUvs[slot + 3] = uvs[source * 2 + 1];

      skirtHeights[column * 2] = heights[source];
      skirtHeights[column * 2 + 1] = kBase;
    }

    let quad = 0;

    for (let strip = 0; strip < 3; strip += 1) {
      const first = strip === 2 ? points * 2 : strip * points;
      const last = strip === 2 ? points * 2 + 1 : first + points - 1;

      for (let column = first; column < last; column += 1) {
        const v = column * 2;
        const slot = quad * 6;

        indices[slot] = v;
        indices[slot + 1] = v + 1;
        indices[slot + 2] = v + 3;
        indices[slot + 3] = v;
        indices[slot + 4] = v + 3;
        indices[slot + 5] = v + 2;

        quad += 1;
      }
    }

    const mesh = new MeshSimple({
      texture,
      vertices: skirtBase.slice(),
      uvs: skirtUvs,
      indices,
    });

    // боковая грань насыпи темнее её поверхности — ровно как у объёмов
    mesh.tint = volumeConfig.sideTint;

    return {
      target: mesh,
      k: kBase,
      base: skirtBase,
      heights: skirtHeights,
    };
  }

  // Каждый кадр у статического слоя: видимость (плита моста) и параллакс —
  // и слоя, и его срезов. Зовётся из колбэка `onRender`, который конструктор
  // кладёт СВОЙСТВОМ (см. там же): метод с этим именем на прототипе
  // подкласса затенил бы аксессор Container.prototype.onRender, сеттер не
  // отработал бы и PixiJS не позвал бы ничего — фича молча мертва
  _updateStatic() {
    this._attachOccluder();

    // прозрачность считает плита моста и любой слой с перекрывателем: у
    // второго объём гаснет уже на уровне игрока
    if (this._level >= 1 || this._occluder) {
      this._updateSeeThrough();
    }

    if (!this._parallaxK && !this._slices.length) {
      return;
    }

    const camera = cameraCenter(this.parent, this._renderer);

    if (!camera) {
      return;
    }

    if (this.mapSprite) {
      applyParallax(this.mapSprite, camera, this._parallaxK, this._baseScale);
    }

    for (let i = 0; i < this._slices.length; i += 1) {
      const slice = this._slices[i];

      if (slice.base) {
        this._updateRampMesh(slice, camera);
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
    const stage = this.parent;

    if (!this._occluder || !stage || this._occluder.parent === stage) {
      return;
    }

    stage.addChild(this._occluder);
  }

  // Вершины клина рампы: у каждой своя высота, поэтому контейнерным
  // трансформом (applyParallax) их не сдвинуть — считаем поточечно той же
  // формулой, что и offsetPoint (src/client/parallax.js)
  _updateRampMesh(slice, camera) {
    const { target, base, heights } = slice;
    const vertices = target.vertices;

    for (let i = 0, len = heights.length; i < len; i += 1) {
      const x = base[i * 2];
      const y = base[i * 2 + 1];
      const k = heights[i];

      vertices[i * 2] = x + (x - camera.x) * k;
      vertices[i * 2 + 1] = y + (y - camera.y) * k;
    }

    // autoUpdate меша заливает буфер позиций сам на ближайшем рендере
    target.vertices = vertices;
  }

  // прозрачность плиты моста над локальным игроком: в GTA 2 игрок под
  // эстакадой продолжает видеть свою машину. Считается по НАШЕМУ гриду
  // уровня: парт уже знает и карту слоя, и список тайлов пола
  _updateSeeThrough() {
    if (!this._levelView) {
      return;
    }

    const cfg = this._levelView.cfg;
    // сглаживание по времени тикера общего приложения
    const dt = Ticker.shared.deltaMS / 1000;
    const rate = Math.min(1, cfg.fadeRate * dt);

    if (this.mapSprite) {
      this._updateLayerSeeThrough(cfg, rate);
    }

    if (this._occluder) {
      this._updateOccluderSeeThrough(
        cfg,
        rate,
        cameraCenter(this.parent, this._renderer),
      );
    }
  }

  // сам слой: гаснет только то, что НАД игроком
  _updateLayerSeeThrough(cfg, rate) {
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

    this._hole.strength += ((above ? 1 : 0) - this._hole.strength) * rate;
    this._applyHole(this, this._hole, cfg);
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

    this._occluderHole.strength +=
      ((hides ? 1 : 0) - this._occluderHole.strength) * rate;
    this._applyHole(this._occluder, this._occluderHole, cfg);
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
        this._hasLayerTileAt(
          (point.x + camera.x * k) / scale,
          (point.y + camera.y * k) / scale,
        )
      ) {
        return true;
      }
    }

    return false;
  }

  // дыра вокруг игрока: внутри слоя нужна не одна alpha, а поле по пикселям,
  // поэтому единственный способ — фильтр. Центр приходит в пикселях кадра
  // фильтра, то есть в экранных: мировая точка умножается на трансформ сцены
  // (камера — он и есть, см. src/client/camera.js).
  //
  // Цель и её состояние передаются параметрами: слой и его перекрыватель
  // считают дыру ОДНИМ кодом, но своими экземплярами фильтра — у Pixi
  // фильтр несёт свои uniform'ы
  _applyHole(target, hole, cfg) {
    const stage = this.parent;

    if (hole.strength < HOLE_EPSILON || !stage) {
      if (hole.attached) {
        target.filters = [];
        hole.attached = false;
      }

      return;
    }

    if (!hole.filter) {
      hole.filter = createHoleFilter(cfg);
    }

    if (!hole.attached) {
      target.filters = [hole.filter];
      hole.attached = true;
    }

    // игрок под мостом нарисован не в своей мировой точке, а смещённым на
    // собственную высоту (Tank), — и слой над ним смещён тоже. Центр дыры
    // обязан ехать по той же проекции, иначе она уползает от танка тем
    // сильнее, чем дальше он от центра экрана
    const camera = cameraCenter(stage, this._renderer);
    const view = offsetPoint(
      this._levelView.x,
      this._levelView.y,
      camera,
      this._levelView.z * parallaxConfig.shear,
    );

    setHoleUniforms(hole.filter, {
      centerX: view.x * stage.scale.x + stage.position.x,
      centerY: view.y * stage.scale.y + stage.position.y,
      radius: cfg.radius * stage.scale.x,
      softness: cfg.softness,
      // дыра открывается не рывком: сила перехода живёт в минимальной alpha
      minAlpha: 1 + (cfg.minAlpha - 1) * hole.strength,
    });
  }

  // ящик: точечная сущность, ей хватает одной alpha на всё тело. Заодно
  // затемняется, если игрок над ним (единый признак «ниже — темнее»), и
  // висит над землёй на своём уровне — тем же параллаксом, что и плита,
  // на которой стоит
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

    if (!this._level) {
      return;
    }

    applyParallax(
      this,
      cameraCenter(this.parent, this._renderer),
      this._level * parallaxConfig.shear,
      this._baseScale,
    );
  }

  // есть ли в мировой точке тайл ЭТОГО слоя (то есть нарисован ли там
  // объём): тот же перевод мировой точки в клетку, что и у пола
  _hasLayerTileAt(worldX, worldY) {
    const col = Math.floor(worldX / this._baseScaleX / this._step);
    const row = Math.floor(worldY / this._baseScaleY / this._step);
    const tile = this._map?.[row]?.[col];

    return tile !== undefined && this._tiles.includes(tile);
  }

  // позиция приходит в мировых единицах, а грид слоя не масштабирован:
  // масштаб карты живёт ЗДЕСЬ (ровно как в update() для динамики), а сервис
  // хранит мир как есть
  _hasFloorAt(worldX, worldY) {
    const col = Math.floor(worldX / this._baseScaleX / this._step);
    const row = Math.floor(worldY / this._baseScaleY / this._step);
    const tile = this._map?.[row]?.[col];

    return tile !== undefined && this._floor.includes(tile);
  }

  update(data) {
    if (this.sprite) {
      // `this.scale` у динамики пересчитывается параллаксом каждый кадр,
      // поэтому в мир переводит базовый масштаб карты, а не текущий
      this.sprite.x = data[C_X] / this._baseScaleX;
      this.sprite.y = data[C_Y] / this._baseScaleY;
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

      // тело вернулось на землю: сдвиг высоты обязан сняться, иначе ящик
      // так и останется висеть в проекции уровня, с которого упал
      if (!level) {
        applyParallax(this, null, 0, this._baseScale);
      }
    }
  }

  destroy(options) {
    if (this._hole.filter) {
      this.filters = [];
      this._hole.attached = false;
      this._hole.filter.destroy();
      this._hole.filter = null;
    }

    // перекрыватель живёт на сцене, а не в парте: снимается вручную —
    // сначала со сцены, потом ресурсы. Запечённую текстуру он делит со
    // слоем, поэтому отдаёт её не он (см. ниже, mapSprite)
    if (this._occluder) {
      const occluder = this._occluder;

      this._occluder = null;
      occluder.filters = [];
      this._occluderHole.attached = false;

      if (this._occluderHole.filter) {
        this._occluderHole.filter.destroy();
        this._occluderHole.filter = null;
      }

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
      this.removeChild(mapSprite);
    }

    super.destroy({
      children: true,
      texture: false,
      textureSource: false,
      ...options,
    });

    // срезы объёма делят запечённую текстуру с плоским слоем — освобождает
    // её один владелец, спрайт слоя. Текстуру клина делят его меши, и она
    // тоже своя: источник отдаётся здесь один раз
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
    // Assets.unload в Pixi 8 не считает ссылки: он уничтожает TextureSource,
    // а тот эмитит change, по которому PixiJS обнуляет BindGroup
    // (BindGroup.onResourceChange), и следующий проход фильтра падает в
    // setResource. Кеш Assets переживает смену карты штатно, поэтому здесь
    // не выгружается ничего.

    // обнуление ссылок
    this.sprite = null;
    this._baseTexturePromise = null;
    this._assetUrl = null;
    this._map = null;
    this._tiles = null;
    this._floor = null;
    this._ramps = null;
    this._spriteSheetData = null;
    this._renderer = null;
    this._levelView = null;
  }
}
