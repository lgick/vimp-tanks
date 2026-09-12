import { Container, PerspectiveMesh, Sprite, Ticker } from 'pixi.js';
import { lerp, clamp } from 'vimp-engine/lib/math.js';
import { levelZ, renderLevel } from '../levelZ.js';
import { cameraCenter } from '../camera.js';
import { offsetPoint } from '../parallax.js';
import { tiltCorners, tiltShade, scaleTint } from '../tilt.js';
import { landingImpact } from '../landing.js';
import {
  parallax as parallaxConfig,
  shadow as shadowConfig,
  tilt as tiltConfig,
  landing as landingConfig,
} from '../../config/render.js';
import {
  M1_X,
  M1_Y,
  M1_ANGLE,
  M1_GUN_ROTATION,
  M1_ENGINE_LOAD,
  M1_CONDITION,
  M1_SIZE,
  M1_TEAM,
  M1_Z,
  M1_LEVEL,
  M1_VZ,
  M1_PITCH,
  M1_ROLL,
} from '../snapshotFields.js';

// светотень наклона только затемняет (см. `tiltShade` в src/client/tilt.js):
// множитель зажат в [0, 1]
const SHADE_MIN = 0;
const SHADE_MAX = 1;

// базовый zIndex танка внутри своего уровня (см. plan/stage_6.md)
const TANK_BASE_Z = 3;

// потолок уровней карты: движок нумерует их 0..7 (бит 8 занят
// STATIC_LEVEL_GROUP, vimp-engine core/src/map.rs). Копия, потому что
// парту WASM-констант не отдают; расходиться с движком ей нельзя.
// В прыжке `_z` уходит выше уровня отрыва, и слой тени иначе улетел бы за
// верхнюю плиту
const LEVEL_MAX = 7;

// масштаб корпуса на высоте, тень и ракурс на подъёме — числа 2.5D, они
// живут в src/config/render.js (`parallax`, `shadow`)

// скорость (высота тона) на холостом ходу
const MIN_ENGINE_RATE = 1;

// скорость при движении
const MAX_ENGINE_RATE = 1.15;

// повышенная скорость при напряжении (газ в стену)
const STRAIN_ENGINE_RATE = 1.25;

// множитель громкости на холостом ходу (60% от базовой)
const MIN_ENGINE_VOLUME_FACTOR = 0.6;

// множитель на полном ходу (100% от базовой)
const MAX_ENGINE_VOLUME_FACTOR = 1.0;

// глубина и частота покачивания высоты тона на холостом ходу
const IDLE_WOBBLE_DEPTH = 0.015;
const IDLE_WOBBLE_HZ = 2.5;

/**
 * Вычисляет параметры звука двигателя на основе нагрузки на двигатель.
 * @param {number} load - Нагрузка на двигатель (от 0.0 до > 1.0).
 * @param {number} [timeMs=0] - Время для покачивания тона на холостых.
 * @returns {{rate: number, volumeFactor: number}} -
 * Объект со скоростью (pitch) и множителем громкости.
 */
export function calculateEngineSoundParams(load, timeMs = 0) {
  // load 0.0 -> холостой ход
  // load 1.0 -> движение на полной скорости
  // load > 1.0 -> напряжение (газ в стену)

  // интерполяция скорости (pitch) и громкости,
  // разделение базовой нагрузки (до 1.0)
  // и нагрузки от напряжения (свыше 1.0).
  // нечисловая нагрузка (короткий ряд) не должна доходить до Web Audio:
  // clamp(undefined) даёт NaN, а NaN в rate — нефинитное значение параметра
  const safeLoad = Number.isFinite(load) ? load : 0;
  const baseLoad = clamp(safeLoad, 0, 1);
  const strainLoad = Math.max(0, safeLoad - 1.0);

  const rate =
    lerp(MIN_ENGINE_RATE, MAX_ENGINE_RATE, baseLoad) +
    (STRAIN_ENGINE_RATE - MAX_ENGINE_RATE) * strainLoad;

  const volumeFactor = lerp(
    MIN_ENGINE_VOLUME_FACTOR,
    MAX_ENGINE_VOLUME_FACTOR,
    baseLoad,
  );

  // неизменная высота тона у баса читается ухом как гул, а не как
  // двигатель: на холостых тон слегка покачивается, а с ростом нагрузки
  // покачивание сходит на нет — там за характер отвечает сама нагрузка
  const wobble =
    1 +
    IDLE_WOBBLE_DEPTH *
      (1 - baseLoad) *
      Math.sin(2 * Math.PI * IDLE_WOBBLE_HZ * (timeMs / 1000));

  return { rate: rate * wobble, volumeFactor };
}

export default class Tank extends Container {
  constructor(data, assets, dependencies, context) {
    super();

    // корпус, пушка и остов — PerspectiveMesh, а не Sprite: наклон корпуса
    // (`pitch`/`roll` из кадра) деформирует квад, а спрайт умеет только
    // масштаб и поворот. Якоря и масштаб у меша уходят ВНУТРЬ углов —
    // их считает `src/client/tilt.js`, здесь остаётся только раздать
    // результат в `setCorners` (см. _applyTilt)
    const mesh = () => {
      const view = new PerspectiveMesh({
        verticesX: tiltConfig.vertices,
        verticesY: tiltConfig.vertices,
      });

      // батчер задаётся явно, чтобы режим не зависел молча от конфига:
      // при нынешних 6×6 меш батчится и сам, но `tiltConfig.vertices`
      // больше 10 увело бы его за порог `Mesh.batched` (100 вершин) — в
      // общий шейдер `GlMeshAdaptor`, который навсегда ломается на
      // уничтожении текстуры (см. src/client/parts/map/extrusion.js)
      view.geometry.batchMode = 'batch';

      return view;
    };

    this.body = mesh();
    this.gun = mesh();

    // меш для уничтоженного состояния
    this.wreck = mesh();

    // якоря: у меша своего якоря нет, он параметр `tiltCorners`
    this._bodyAnchor = { x: 0.5, y: 0.5 };
    this._wreckAnchor = { x: 0.5, y: 0.5 };

    this.addChild(this.body, this.gun, this.wreck);

    this._textures = assets.tankTexture;
    this._shadowAsset = assets.tankShadowTexture || null;
    this._renderer = dependencies.renderer || null;

    // тень живёт СИБЛИНГОМ на сцене, а не ребёнком танка: у неё свой
    // zIndex — слоя, НАД которым танк висит, — а сцена плоская, порядок
    // задаёт только zIndex (тот же приём, что в Tracks._markLayer).
    // Движок про неё не знает, значит убирает её destroy() этого парта
    this._shadow = null;

    // параметры с сервера:
    // [x, y, rotation, gunRotation, vX, vY,
    // engineLoad, condition, size, teamId, angvel, z, level]
    // мировая (НЕсмещённая) точка танка: в неё уходят звук и levelView, а
    // `this.position` каждый кадр перезаписывается проекцией высоты
    // (см. _updateView)
    this._worldX = data[M1_X] || 0;
    this._worldY = data[M1_Y] || 0;
    this.x = this._worldX;
    this.y = this._worldY;
    this.rotation = data[M1_ANGLE] || 0;
    // поворот пушки — параметр её квада, а не трансформ меша
    this._gunRotation = data[M1_GUN_ROTATION] || 0;
    this._engineLoad = data[M1_ENGINE_LOAD] || 0;
    this._condition = data[M1_CONDITION];
    this._size = data[M1_SIZE];
    this._teamId = data[M1_TEAM];

    // 2.5D: непрерывная высота (рампа/падение) и дискретный уровень
    // ОТРИСОВКИ (о нём — в update)
    this._z = data[M1_Z] || 0;

    // ФИЗИЧЕСКИЙ уровень из кадра (не `renderLevel`): в полёте он держит
    // уровень отрыва, и по нему тень знает, над какой плитой висит танк
    this._physLevel = data[M1_LEVEL] || 0;

    // вертикальная динамика: наклон корпуса считает ядро (`pitch`/`roll`),
    // `vz` нужен клиенту как детектор касания
    this._vz = data[M1_VZ] || 0;
    this._prevVz = this._vz;
    this._pitch = data[M1_PITCH] || 0;
    this._roll = data[M1_ROLL] || 0;

    // просадка корпуса на приземлении: сила удара 0..1 и остаток анимации
    this._landImpact = 0;
    this._landTimer = 0;
    this._squash = 0;

    this._level = renderLevel(data[M1_LEVEL], this._z);
    this.zIndex = levelZ(TANK_BASE_Z, this._level);

    // свой танк — единственный, кто вправе писать в levelView: по нему
    // плита моста над игроком становится полупрозрачной (Map.onRender).
    //
    // Спрашиваем в момент, когда нужен ответ, а не в конструкторе: парты
    // создаются из FIRST_SHOT_DATA, который приходит ДО первого бинарного
    // кадра, и свой танк строится, пока `localPlayer.id` ещё null — флаг,
    // посчитанный один раз, был бы навсегда false ровно у той сущности,
    // ради которой он и заведён
    this._isLocal = () => dependencies.localPlayer?.is(context?.id) === true;
    this._levelView = dependencies.levelView || null;

    // видимость уровня и признаки высоты считаются каждый кадр, а не по
    // приходу строки: и камера, и локальный игрок двигаются между кадрами.
    //
    // `onRender` у Container — аксессор: назначаем СВОЙСТВОМ, метод с этим
    // именем на прототипе затенил бы сеттер и колбэк не позвался бы ни разу
    this.onRender = () => this._updateView();

    // правильный якорь для пушки в зависимости от команды
    const liveTextures =
      this._teamId === 1
        ? this._textures.liveTeamId1
        : this._textures.liveTeamId2;
    const gunAnchorData = liveTextures ? liveTextures.gunAnchor : null;

    this._gunAnchor = gunAnchorData
      ? { x: gunAnchorData.x, y: gunAnchorData.y }
      : { x: 0.5, y: 0.5 }; // запасной вариант

    // коэффициент масштабирования, чтобы соответствовать размеру танка
    const BAKER_BASE_SIZE = 10; // размер, использованный в текстурах
    this._scaleFactor = this._size / BAKER_BASE_SIZE;

    this._soundManager = dependencies.soundManager;
    this._soundId = null;

    const engineConfig = this._soundManager.getSoundConfig('tankEngine');

    this._baseEngineVolume = engineConfig?.volume || 0;
    // без конфига registerSound вернёт null: страховка в update() иначе
    // пыталась бы регистрировать звук каждый кадр для каждого танка
    this._hasEngineSound = !!engineConfig;

    // первоначальная установка визуального состояния
    this.create();
  }

  // запускает звуки двигателя танка
  _initSounds() {
    if (this._soundId || this._condition === 0 || !this._hasEngineSound) {
      return;
    }

    this._soundId = this._soundManager.registerSound(
      'tankEngine',
      this._getSoundData(),
    );
  }

  _getSoundData() {
    const { rate, volumeFactor } = calculateEngineSoundParams(
      this._engineLoad,
      performance.now(),
    );

    return {
      position: { x: this._worldX, y: this._worldY },
      rate,
      volume: this._baseEngineVolume * volumeFactor,
      // свой двигатель не принадлежит миру: он всегда по центру и без HRTF.
      // Слушатель — центр камеры, то есть сам этот танк: источник, лежащий
      // ровно на слушателе, HRTF сворачивает в гребенчатую окраску («гул»),
      // а расхождение камеры и танка в пару пикселей кидает звук целиком в
      // одно ухо (азимут в Web Audio зависит от направления, не от
      // расстояния). Флаг считается каждый кадр: `_isLocal()` даёт true
      // только после появления `localPlayer.id`, а обновление уезжает в
      // движок через `updateSoundData`
      spatial: !this._isLocal(),
    };
  }

  create() {
    // если танк уничтожен
    if (this._condition === 0) {
      this.body.visible = false;
      this.gun.visible = false;

      this.wreck.texture = this._textures.destroyed;
      this.wreck.visible = true;

      // поворот башни, так как она теперь часть обломков
      this._gunRotation = 0;

      // при уничтожении отключение звука
      this.destroySounds();
    } else {
      // если танк "ожил" или создан впервые
      this.wreck.visible = false;

      let liveTextures;

      // набор текстур в зависимости от команды
      if (this._teamId === 1) {
        liveTextures = this._textures.liveTeamId1;
      } else if (this._teamId === 2) {
        liveTextures = this._textures.liveTeamId2;
      }

      this.body.texture = liveTextures.body;
      this.gun.texture = liveTextures.gun;
      this.body.visible = true;
      this.gun.visible = true;

      this._initSounds();
    }

    // текстура задаёт габариты квада: без пересчёта углов меш остался бы с
    // размерами прежней текстуры до первого кадра
    this._applyTilt();
  }

  update(data) {
    this._worldX = data[M1_X];
    this._worldY = data[M1_Y];
    this.rotation = data[M1_ANGLE];
    this._gunRotation = data[M1_GUN_ROTATION];
    // `|| 0`, как в конструкторе: без него короткий ряд даёт undefined,
    // clamp() возвращает NaN, и в `sound.rate` каждый кадр уезжает NaN
    // (сравнение `rate !== activeInstance.rate` для NaN всегда истинно)
    this._engineLoad = data[M1_ENGINE_LOAD] || 0;

    this._z = data[M1_Z] || 0;
    this._physLevel = data[M1_LEVEL] || 0;

    // `|| 0` здесь по той же причине, что у engineLoad: короткий ряд без
    // хвоста иначе уводит углы квада в NaN
    this._vz = data[M1_VZ] || 0;
    this._pitch = data[M1_PITCH] || 0;
    this._roll = data[M1_ROLL] || 0;

    // касание: детектор один и для своего танка, и для чужого, и общий с
    // `Dust.js` — оба парта получают один и тот же ряд снапшота, поэтому
    // связывать их колбэком не нужно, и отдельного поля «приземлился» в
    // кадре тоже
    const impact = landingImpact(this._prevVz, this._vz, landingConfig);

    if (impact > 0) {
      this._landImpact = impact;
      this._landTimer = landingConfig.duration;
    }

    this._prevVz = this._vz;

    // уровень ОТРИСОВКИ, а не физический (`renderLevel`): падающий танк
    // иначе рисовался бы слоем, тинтом и прозрачностью эстакады до самого
    // касания
    const level = renderLevel(data[M1_LEVEL], this._z);

    if (level !== this._level) {
      this._level = level;
      this.zIndex = levelZ(TANK_BASE_Z, level);
    }

    this._applyTilt();

    if (this._levelView && this._isLocal()) {
      this._levelView.set(level, this._worldX, this._worldY, this._z);
    }

    // обновление звуковой логики; страховка: живой танк без регистрации
    // (её мог снять частичный CLEAR) возвращает звук на следующем кадре
    if (this._condition > 0) {
      if (this._soundId === null) {
        this._initSounds();
      } else {
        this._soundManager.updateSoundData(this._soundId, this._getSoundData());
      }
    }

    const newCondition = data[M1_CONDITION];
    const teamId = data[M1_TEAM];

    let needsVisualChange = false;

    if (newCondition !== undefined && newCondition !== this._condition) {
      this._condition = newCondition;
      needsVisualChange = true;
    }

    if (teamId !== undefined && teamId !== this._teamId) {
      this._teamId = teamId;
      needsVisualChange = true;
    }

    // если визуальное представление требуется изменить
    if (needsVisualChange) {
      this.create();
    }
  }

  // углы квада одного меша: масштаб высоты, просадка приземления и наклон
  // корпуса — один трансформ, потому что у PerspectiveMesh нет ни якоря, ни
  // осмысленного `scale` вокруг него
  _setCorners(mesh, anchor, rotation, size, squashY) {
    const { texture } = mesh;

    mesh.setCorners(
      ...tiltCorners({
        width: texture.width * size,
        height: texture.height * size * squashY,
        anchorX: anchor.x,
        anchorY: anchor.y,
        rotation,
        // выключенный наклон вырождает квад в обычный прямоугольник —
        // отдельной «плоской» ветки держать не нужно
        pitch: tiltConfig.enabled ? this._pitch : 0,
        roll: tiltConfig.enabled ? this._roll : 0,
        shear: parallaxConfig.shear,
        lift: tiltConfig.lift,
      }),
    );
  }

  // Высота ПОВЕРХНОСТИ под танком в уровнях. На плите и на рампе это сама
  // высота корпуса (танк лежит на опоре), в полёте — уровень отрыва: его
  // ядро держит в `level` всю дугу (`core/src/level.rs`, `step_airborne`).
  // По ней рисуется тень: разъезд корпуса с тенью обязан показывать
  // подъём НАД ОПОРОЙ, а не высоту над нулём карты — иначе стоящий на
  // верхнем ярусе танк уезжает от своей тени тем дальше, чем дальше он от
  // центра экрана.
  // `vz` в кадре — точный флаг: ядро специально не даёт ненулевой скорости
  // округлиться в ноль (`snapshot_row`, core/src/tank.rs)
  _groundZ() {
    return this._vz !== 0 ? this._physLevel : this._z;
  }

  // высота читается масштабом корпуса: танк на эстакаде крупнее наземного
  // ровно настолько же, насколько крупнее сама плита под ним — это та же
  // проекция, что и сдвиг (`src/client/parallax.js`)
  _applyTilt() {
    const zScale = 1 + this._z * parallaxConfig.shear;
    const size = this._scaleFactor * zScale;
    const squashY = 1 - this._squash;

    this._setCorners(this.body, this._bodyAnchor, 0, size, squashY);
    this._setCorners(
      this.gun,
      this._gunAnchor,
      this._gunRotation,
      size,
      squashY,
    );
    this._setCorners(this.wreck, this._wreckAnchor, 0, size, squashY);
  }

  // признаки уровня и высоты: прозрачность над игроком, затемнение под ним
  // и тень. Зовётся из `onRender` каждый кадр
  _updateView() {
    // проекция 2.5D: смещается КОРПУС — на свою высоту и тем сильнее, чем
    // дальше он от центра экрана (src/client/parallax.js). Тем же числом
    // смещается плита уровня, поэтому танк с неё не съезжает.
    // Раньше сдвигалась тень, а корпус стоял в мировой точке — проекция
    // была вывернута наизнанку, и тень выглядела выше танка
    // центр камеры добывает сервис — один раз на кадр и для всех партов
    // сразу (src/client/levelView.js): владельцем его был локальный танк, и
    // без него (наблюдатель, промежуток до респауна) камеры не было вовсе
    if (this._levelView) {
      this._levelView.attachStage(this.parent, this._renderer);
    }

    const camera = this._levelView
      ? this._levelView.camera()
      : cameraCenter(this.parent, this._renderer);

    // тинт УРОВНЯ — база светотени наклона: она множитель поверх него, и
    // считать её от `this.tint` нельзя — без сервиса уровней тот не
    // сбрасывается и корпус темнел бы кадр за кадром
    let baseTint = 0xffffff;

    if (this._levelView) {
      this.alpha = this._levelView.alphaFor(
        this._level,
        this._worldX,
        this._worldY,
        this._z,
      );
      baseTint = this._levelView.tintFor(this._level);
      this.tint = baseTint;
    }

    const view = offsetPoint(
      this._worldX,
      this._worldY,
      camera,
      this._z * parallaxConfig.shear,
    );

    this.position.set(view.x, view.y);

    // светотень наклона поверх тинта уровня: множитель, а не замена —
    // затемнение нижних ярусов обязано остаться
    if (tiltConfig.enabled && tiltConfig.shading) {
      const shade = clamp(
        tiltShade({
          angle: this.rotation,
          pitch: this._pitch,
          roll: this._roll,
          lightDir: tiltConfig.lightDir,
          shading: tiltConfig.shading,
        }),
        SHADE_MIN,
        SHADE_MAX,
      );

      this.tint = scaleTint(baseTint, shade);
    }

    // просадка идёт по ВРЕМЕНИ, а не по кадрам сети, поэтому живёт здесь.
    // `sin` даёт горб без кривых и библиотек: быстрый удар, мягкий возврат
    if (this._landTimer > 0) {
      this._landTimer = Math.max(0, this._landTimer - Ticker.shared.deltaMS);

      const t = this._landTimer / landingConfig.duration;

      this._squash =
        Math.sin(t * Math.PI) * landingConfig.squash * this._landImpact;
    } else {
      this._squash = 0;
    }

    this._applyTilt();

    this._updateShadow(camera);
  }

  // Тень — признак ПОЛЁТА и ничего больше: она показывает, насколько танк
  // оторвался от опоры. У стоящего и едущего танка отрыва нет, и тень там
  // лежала бы ровно под корпусом, читаясь серым ореолом вокруг него, —
  // поэтому вне полёта её нет вовсе. Признак полёта тот же, что у
  // `_groundZ`: ненулевая вертикальная скорость в кадре
  _updateShadow(camera) {
    if (!this._shadowAsset || !this.parent) {
      return;
    }

    const visible = this._condition !== 0 && this._vz !== 0;

    if (!visible) {
      // спрайта может не быть вовсе: танк, который ни разу не взлетал, его
      // и не заводит
      if (this._shadow) {
        this._shadow.visible = false;
      }

      return;
    }

    if (!this._shadow) {
      const { texture, contentSize } = this._shadowAsset;

      this._shadow = new Sprite(texture);
      this._shadow.anchor.set(0.5);
      // текстура тени уже в пропорции корпуса, поэтому масштаб один на обе
      // оси и нормируется по КОРПУСУ (4 × size вдоль курса), а не по size
      this._shadowScale =
        (this._size * 4 * shadowConfig.sizeFactor) / contentSize;
      this.parent.addChild(this._shadow);
    }

    const shadow = this._shadow;

    shadow.visible = true;

    const groundZ = this._groundZ();

    // тень лежит НА ОПОРЕ и живёт в той же проекции, что корпус и плита
    // под ним: разъезд с корпусом и есть высота отрыва. Падение с обрыва
    // оставляет её на покинутой плите — опорой ядро держит уровень отрыва
    const view = offsetPoint(
      this._worldX,
      this._worldY,
      camera,
      groundZ * parallaxConfig.shear,
    );

    shadow.x = view.x;
    shadow.y = view.y;
    shadow.rotation = this.rotation;

    // масштаб и прозрачность читают ПОДЪЁМ над опорой, а не высоту над
    // нулём карты: тень на верхнем ярусе обязана быть такой же, как на
    // земле, — разной её делает только высота прыжка
    const lift = Math.max(0, this._z - groundZ);

    shadow.scale.set(this._shadowScale * (1 + lift * shadowConfig.scaleGain));
    shadow.alpha =
      Math.max(0, shadowConfig.baseAlpha - lift * shadowConfig.alphaFalloff) *
      this.alpha;

    // тень лежит на слое, НАД которым висит танк: на рампе это ещё нижний
    // уровень, и именно поэтому по ней видно, что танк уже поднялся
    // в прыжке `_z` уходит выше любой плиты карты, а слоёв всего LEVEL_MAX
    shadow.zIndex = levelZ(
      TANK_BASE_Z - 1,
      Math.min(LEVEL_MAX, Math.floor(groundZ)),
    );
  }

  // останавливает и сбрасывает все звуки, связанные с танком
  destroySounds() {
    if (this._soundId) {
      this._soundManager.unregisterSound(this._soundId);
      this._soundId = null;
    }
  }

  destroy(options) {
    this.destroySounds();

    // тень движок не создавал и не уберёт: она сиблинг на сцене
    if (this._shadow) {
      this._shadow.destroy({ texture: false, textureSource: false });
      this._shadow = null;
    }

    super.destroy({
      children: true,
      texture: false, // текстуры общие, не должны уничтожаться
      textureSource: false,
      ...options,
    });
  }
}
