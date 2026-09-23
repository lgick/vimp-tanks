import { Container, PerspectiveMesh, Sprite, Ticker } from 'pixi.js';
import { lerp, clamp } from 'vimp-engine/lib/math.js';
import { levelZ, renderLevel } from '../levelZ.js';
import { cameraCenter } from '../camera.js';
import { offsetPoint } from '../parallax.js';
import { tiltCorners, tiltShade, scaleTint } from '../tilt.js';
import { landingImpact } from '../landing.js';
import { recoilAmount, recoilOffsets } from '../recoil.js';
import {
  createTankLightShader,
  setTankLightTextures,
  applyTankLight,
  tankLightUniforms,
} from '../tankLight.js';
import { lightLevels } from '../lighting/lightMath.js';
import {
  parallax as parallaxConfig,
  shadow as shadowConfig,
  tilt as tiltConfig,
  tankLight as tankLightConfig,
  recoil as recoilConfig,
  landing as landingConfig,
  lighting as lightingConfig,
  surfaceFx,
} from '../../config/render.js';
import {
  M1_X,
  M1_Y,
  M1_ANGLE,
  M1_GUN_ROTATION,
  M1_VX,
  M1_VY,
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

// дуло — на 0.55 длины корпуса от центра по курсу башни (`Tank::
// muzzle_position` в core/src/tank.rs)
const MUZZLE_REACH = 0.55;

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

// сдвиг тени от света: `−lightDir` длиной `groundOffset`. Направление
// света нормируется при чтении (см. `tilt.lightDir`)
export function shadowOffset(
  lightDir = tiltConfig.lightDir,
  distance = shadowConfig.groundOffset,
) {
  const len = lightDir ? Math.hypot(lightDir[0], lightDir[1]) : 0;

  if (!len || !distance) {
    return { x: 0, y: 0 };
  }

  return {
    x: (-lightDir[0] / len) * distance,
    y: (-lightDir[1] / len) * distance,
  };
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

    // шейдеры света по карте нормалей: свой на каждый меш (у пушки свой
    // поворот). Заводятся при первой текстуре с картой нормалей
    this._lightShaders = new Map();

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

    // отдача после выстрела (src/client/recoil.js): мс с выстрела
    // (Infinity — покой) и её добавка к наклону корпуса. Событие приносит
    // сервис `shots` — его будит эффект выстрела с id стрелка
    this._recoilElapsed = Infinity;
    this._recoilTilt = { pitch: 0, roll: 0 };
    this._unsubscribeShots =
      dependencies.shots && context?.id !== undefined
        ? dependencies.shots.subscribe(context.id, {
            fired: () => this._onFired(),
            muzzle: () => this._muzzleWorld(),
          })
        : null;
    this._levelView = dependencies.levelView || null;

    // Ночь (сервис игры, src/client/lighting/): два конуса фар и слабый
    // свет под корпусом — источники сессии, переживают смену карты. Блика
    // на самой фаре нет: аддитивный спрайт засвечивал полкорпуса
    this._lighting = dependencies.lighting?.enabled
      ? dependencies.lighting
      : null;
    // { cones: [левая, правая], glow }; null — фары выключены
    this._headlights = null;

    if (this._lighting && assets.headlightConeTexture) {
      this._lighting.registerTextures({ cone: assets.headlightConeTexture });
    }

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

    // плеск под гусеницами: поверхность клетки из ядра (сервис `surfaces`);
    // без сервиса или без звука в каталоге воды не слышно
    this._surfaces = dependencies.surfaces || null;
    this._waterSoundId = null;
    this._speed = Math.hypot(data[M1_VX] || 0, data[M1_VY] || 0);

    const waterConfig = this._soundManager.getSoundConfig('tankWater');

    this._baseWaterVolume = waterConfig?.volume || 0;
    this._hasWaterSound = !!waterConfig;

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

      this._setTexture(
        this.wreck,
        this._textures.destroyed,
        this._textures.destroyedNormal,
      );
      this.wreck.visible = true;

      // поворот башни, так как она теперь часть обломков
      this._gunRotation = 0;

      // остов не откатывается
      this._resetRecoil();

      // при уничтожении отключение звука
      this.destroySounds();

      // у обломка фар нет
      this._removeLights();
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

      this._setTexture(this.body, liveTextures.body, liveTextures.bodyNormal);
      this._setTexture(this.gun, liveTextures.gun, liveTextures.gunNormal);
      this.body.visible = true;
      this.gun.visible = true;

      this._initSounds();
      this._addLights();
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
    this._speed = Math.hypot(data[M1_VX] || 0, data[M1_VY] || 0);

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

    // источники света живут в МИРОВЫХ координатах и обновляются по кадру
    // данных, до отрисовки: карта освещённости не отстаёт от корпуса
    this._updateLights();
    this._updateWaterSound();
  }

  // петля `tankWater`, пока живой танк стоит или едет по воде (не в
  // полёте). Брызги рисует Dust.js, звук живёт только здесь — иначе
  // дублировался бы
  _updateWaterSound() {
    const inWater =
      this._hasWaterSound &&
      this._condition > 0 &&
      this._vz === 0 &&
      this._surfaces?.kindAt(this._worldX, this._worldY, this._physLevel) ===
        'water';

    if (!inWater) {
      this._removeWaterSound();
      return;
    }

    if (this._waterSoundId === null) {
      this._waterSoundId = this._soundManager.registerSound(
        'tankWater',
        this._getWaterSoundData(),
      );
    } else {
      this._soundManager.updateSoundData(
        this._waterSoundId,
        this._getWaterSoundData(),
      );
    }
  }

  _getWaterSoundData() {
    const { minVolume, fullSpeed, rate } = surfaceFx.water.sound;
    const factor = clamp(this._speed / fullSpeed, 0, 1);

    return {
      position: { x: this._worldX, y: this._worldY },
      rate: lerp(rate.min, rate.max, factor),
      volume: this._baseWaterVolume * (minVolume + (1 - minVolume) * factor),
      // свой плеск — по центру и без HRTF, как свой двигатель (_getSoundData)
      spatial: !this._isLocal(),
    };
  }

  _removeWaterSound() {
    if (this._waterSoundId) {
      this._soundManager.unregisterSound(this._waterSoundId);
      this._waterSoundId = null;
    }
  }

  // Две фары на передней кромке корпуса (4 × size вдоль курса, 3 × size в
  // ширину — пропорция `tankTexture`), смещённые на ±offset полуширины
  _headlightPoints() {
    const cos = Math.cos(this.rotation);
    const sin = Math.sin(this.rotation);
    const front = this._size * 2;
    const side = this._size * 1.5 * lightingConfig.headlights.offset;
    const frontX = this._worldX + cos * front;
    const frontY = this._worldY + sin * front;

    return [
      { x: frontX + sin * side, y: frontY - cos * side },
      { x: frontX - sin * side, y: frontY + cos * side },
    ];
  }

  _addLights() {
    if (!this._lighting || this._headlights) {
      return;
    }

    const { headlights, tankGlow } = lightingConfig;
    const cone = () =>
      this._lighting.addLight({
        kind: 'cone',
        radius: headlights.length,
        spread: headlights.spread,
        color: headlights.color,
        intensity: headlights.intensity,
      });

    this._headlights = {
      cones: [cone(), cone()],
      glow: this._lighting.addLight({
        kind: 'radial',
        radius: tankGlow.radius,
        color: tankGlow.color,
        intensity: tankGlow.intensity,
      }),
    };

    this._updateLights();
  }

  _updateLights() {
    if (!this._headlights) {
      return;
    }

    const level = this._level;
    const z = this._z;
    // на рампе (`vz` кадра — точный флаг полёта, на рампе он 0) свет идёт в
    // оба соседних уровня: клин затемняет оверлей нижнего, плиту — верхнего
    const levels = lightLevels(this._physLevel, z, this._vz !== 0);
    const points = this._headlightPoints();

    for (let i = 0; i < 2; i += 1) {
      this._lighting.updateLight(this._headlights.cones[i], {
        x: points[i].x,
        y: points[i].y,
        z,
        level,
        levels,
        rotation: this.rotation,
      });
    }

    this._lighting.updateLight(this._headlights.glow, {
      x: this._worldX,
      y: this._worldY,
      z,
      level,
      levels,
    });
  }

  _removeLights() {
    if (this._headlights) {
      this._lighting.removeLight(this._headlights.cones[0]);
      this._lighting.removeLight(this._headlights.cones[1]);
      this._lighting.removeLight(this._headlights.glow);
      this._headlights = null;
    }
  }

  // выстрел этого танка: отдача стартует с нуля, а повторный выстрел во
  // время спада возвращает её на пик — при зажатом огне ствол держится
  // откаченным, а не дрожит от перезапусков
  _onFired() {
    if (!recoilConfig.enabled || this._condition === 0) {
      return;
    }

    const peak = recoilConfig.attack * recoilConfig.duration;

    this._recoilElapsed =
      this._recoilElapsed < recoilConfig.duration
        ? Math.min(this._recoilElapsed, peak)
        : 0;
  }

  // мировая (НЕсмещённая проекцией) точка дула: та же формула, что у ядра
  // (`Tank::muzzle_position` — 0.55 длины корпуса по курсу башни). По ней
  // трассер и вспышка держатся у ствола, пока танк едет. У остова дула нет
  _muzzleWorld() {
    if (this._condition === 0 || this.destroyed) {
      return null;
    }

    const angle = this.rotation + this._gunRotation;
    const reach = this._size * 4 * MUZZLE_REACH;

    return {
      x: this._worldX + Math.cos(angle) * reach,
      y: this._worldY + Math.sin(angle) * reach,
    };
  }

  _resetRecoil() {
    this._recoilElapsed = Infinity;
    this._recoilTilt.pitch = 0;
    this._recoilTilt.roll = 0;
    this.body.position.set(0, 0);
    this.gun.position.set(0, 0);
  }

  // шаг отдачи по ВРЕМЕНИ, как просадка приземления: смещения мешей внутри
  // повёрнутого контейнера — это и есть оси корпуса. Длины — мировые
  // единицы, растут с высотой по той же проекции, что и сам корпус
  _stepRecoil() {
    if (this._recoilElapsed === Infinity) {
      return;
    }

    this._recoilElapsed += Ticker.shared.deltaMS;

    const amount = recoilAmount(
      this._recoilElapsed,
      recoilConfig.duration,
      recoilConfig.attack,
    );

    if (amount === 0 && this._recoilElapsed >= recoilConfig.duration) {
      this._resetRecoil();

      return;
    }

    const zScale = 1 + this._z * parallaxConfig.shear;
    const offsets = recoilOffsets({
      amount,
      gunRotation: this._gunRotation,
      config: recoilConfig,
    });

    this.body.position.set(offsets.body.x * zScale, offsets.body.y * zScale);
    // башня едет вместе с корпусом и ещё откатывается сама
    this.gun.position.set(
      (offsets.body.x + offsets.gun.x) * zScale,
      (offsets.body.y + offsets.gun.y) * zScale,
    );
    this._recoilTilt.pitch = offsets.pitch;
    this._recoilTilt.roll = offsets.roll;
  }

  // текстура меша и, если есть карта нормалей, шейдер света. Без карты
  // (или при `tankLight.enabled: false`) меш остаётся батченым, как прежде
  _setTexture(mesh, texture, normal) {
    mesh.texture = texture;

    const shader = this._lightShaders.get(mesh);

    if (!tankLightConfig.enabled || !normal) {
      if (shader) {
        mesh.shader = null;
        shader.destroy();
        this._lightShaders.delete(mesh);
      }

      return;
    }

    if (shader) {
      setTankLightTextures(shader, texture, normal);
    } else {
      const created = createTankLightShader(texture, normal);

      mesh.shader = created;
      this._lightShaders.set(mesh, created);
    }
  }

  // uniforms света раз за кадр: курс, наклон и поворот пушки
  _applyLight() {
    for (const [mesh, shader] of this._lightShaders) {
      applyTankLight(
        shader,
        tankLightUniforms({
          heading: this.rotation,
          rotation: mesh === this.gun ? this._gunRotation : 0,
          pitch: tiltConfig.enabled ? this._pitch + this._recoilTilt.pitch : 0,
          roll: tiltConfig.enabled ? this._roll + this._recoilTilt.roll : 0,
          lightDir: tiltConfig.lightDir,
          lightZ: tankLightConfig.lightZ,
          ambient: tankLightConfig.ambient,
          diffuse: tankLightConfig.diffuse,
        }),
      );
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
        // курс нужен `lift`: поднявшийся край уезжает вверх по экрану
        heading: this.rotation,
        // выключенный наклон вырождает квад в обычный прямоугольник —
        // отдельной «плоской» ветки держать не нужно
        pitch: tiltConfig.enabled ? this._pitch + this._recoilTilt.pitch : 0,
        roll: tiltConfig.enabled ? this._roll + this._recoilTilt.roll : 0,
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

    // карты освещённости: реальная работа — раз на трансформ сцены
    if (this._lighting) {
      this._lighting.attachStage(this.parent, this._renderer);
      this._lighting.render();
    }

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
    // затемнение нижних ярусов обязано остаться. Со светом по карте
    // нормалей наклон уже учтён в шейдере, и второй раз его не кладём
    if (
      tiltConfig.enabled &&
      tiltConfig.shading &&
      this._lightShaders.size === 0
    ) {
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

    this._stepRecoil();
    this._applyTilt();
    this._applyLight();

    this._updateShadow(camera);
  }

  // Тень показывает две вещи: объём корпуса на земле и отрыв от опоры в
  // полёте. Она сдвинута ОТ света (`shadow.groundOffset`) — без сдвига
  // лежала бы ровно под корпусом и читалась серым ореолом, поэтому при
  // нулевом сдвиге она есть только в полёте. Признак полёта тот же, что у
  // `_groundZ`: ненулевая вертикальная скорость в кадре
  _updateShadow(camera) {
    if (!this._shadowAsset || !this.parent) {
      return;
    }

    const airborne = this._vz !== 0;
    const visible =
      this._condition !== 0 && (airborne || shadowConfig.groundOffset > 0);

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

    // сдвиг — в осях ЭКРАНА, а не корпуса: свет один на всю сцену и с
    // танком не поворачивается
    const offset = shadowOffset();

    shadow.x = view.x + offset.x;
    shadow.y = view.y + offset.y;
    shadow.rotation = this.rotation;

    // масштаб и прозрачность читают ПОДЪЁМ над опорой, а не высоту над
    // нулём карты: тень на верхнем ярусе обязана быть такой же, как на
    // земле, — разной её делает только высота прыжка
    const lift = Math.max(0, this._z - groundZ);

    shadow.scale.set(this._shadowScale * (1 + lift * shadowConfig.scaleGain));
    const baseAlpha = airborne
      ? Math.max(0, shadowConfig.baseAlpha - lift * shadowConfig.alphaFalloff)
      : shadowConfig.groundAlpha;

    shadow.alpha = baseAlpha * this.alpha;

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

    this._removeWaterSound();
  }

  destroy(options) {
    this.destroySounds();

    // источники света — состояние сессии сервиса: снимает их владелец
    this._removeLights();

    // тень движок не создавал и не уберёт: она сиблинг на сцене
    if (this._shadow) {
      this._shadow.destroy({ texture: false, textureSource: false });
      this._shadow = null;
    }

    if (this._unsubscribeShots) {
      this._unsubscribeShots();
      this._unsubscribeShots = null;
    }

    // свой шейдер меш не уничтожает; текстуры общие и остаются
    for (const shader of this._lightShaders.values()) {
      shader.destroy();
    }

    this._lightShaders.clear();

    super.destroy({
      children: true,
      texture: false, // текстуры общие, не должны уничтожаться
      textureSource: false,
      ...options,
    });
  }
}
