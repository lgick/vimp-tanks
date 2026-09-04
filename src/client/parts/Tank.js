import { Container, Sprite } from 'pixi.js';
import { lerp, clamp } from 'vimp-engine/lib/math.js';
import { levelZ } from '../levelZ.js';
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
} from '../snapshotFields.js';

// базовый zIndex танка внутри своего уровня (см. plan/stage_6.md)
const TANK_BASE_Z = 3;

// подъём спрайта при высоте z: масштаб корпуса даёт читаемую разницу
// «внизу / наверху» без 3D. Отдельная тень спрайтом отложена
const Z_SCALE_GAIN = 0.06;

// скорость (высота тона) на холостом ходу
const MIN_ENGINE_RATE = 1;

// скорость при движении
const MAX_ENGINE_RATE = 1.1;

// повышенная скорость при напряжении (газ в стену)
const STRAIN_ENGINE_RATE = 1.18;

// множитель громкости на холостом ходу (90% от базовой)
const MIN_ENGINE_VOLUME_FACTOR = 0.9;

// множитель на полном ходу (100% от базовой)
const MAX_ENGINE_VOLUME_FACTOR = 1.0;

/**
 * Вычисляет параметры звука двигателя на основе нагрузки на двигатель.
 * @param {number} load - Нагрузка на двигатель (от 0.0 до > 1.0).
 * @returns {{rate: number, volumeFactor: number}} -
 * Объект со скоростью (pitch) и множителем громкости.
 */
function calculateEngineSoundParams(load) {
  // load 0.0 -> холостой ход
  // load 1.0 -> движение на полной скорости
  // load > 1.0 -> напряжение (газ в стену)

  // интерполяция скорости (pitch) и громкости,
  // разделение базовой нагрузки (до 1.0)
  // и нагрузки от напряжения (свыше 1.0).
  const baseLoad = clamp(load, 0, 1);
  const strainLoad = Math.max(0, load - 1.0);

  const rate =
    lerp(MIN_ENGINE_RATE, MAX_ENGINE_RATE, baseLoad) +
    (STRAIN_ENGINE_RATE - MAX_ENGINE_RATE) * strainLoad;

  const volumeFactor = lerp(
    MIN_ENGINE_VOLUME_FACTOR,
    MAX_ENGINE_VOLUME_FACTOR,
    baseLoad,
  );

  return { rate, volumeFactor };
}

export default class Tank extends Container {
  constructor(data, assets, dependencies, context) {
    super();

    // спрайты для отображения танка
    this.body = new Sprite();
    this.gun = new Sprite();

    // спрайт для уничтоженного состояния
    this.wreck = new Sprite();

    // якоря
    this.body.anchor.set(0.5);
    this.wreck.anchor.set(0.5);

    this.addChild(this.body, this.gun, this.wreck);

    this._textures = assets.tankTexture;

    // параметры с сервера:
    // [x, y, rotation, gunRotation, vX, vY,
    // engineLoad, condition, size, teamId, angvel, z, level]
    this.x = data[M1_X] || 0;
    this.y = data[M1_Y] || 0;
    this.rotation = data[M1_ANGLE] || 0;
    this.gun.rotation = data[M1_GUN_ROTATION] || 0;
    this._engineLoad = data[M1_ENGINE_LOAD] || 0;
    this._condition = data[M1_CONDITION];
    this._size = data[M1_SIZE];
    this._teamId = data[M1_TEAM];

    // 2.5D: непрерывная высота (рампа/падение) и дискретный уровень
    this._z = data[M1_Z] || 0;
    this._level = data[M1_LEVEL] || 0;
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

    // правильный якорь для пушки в зависимости от команды
    const liveTextures =
      this._teamId === 1
        ? this._textures.liveTeamId1
        : this._textures.liveTeamId2;
    const gunAnchorData = liveTextures ? liveTextures.gunAnchor : null;

    if (gunAnchorData) {
      this.gun.anchor.set(gunAnchorData.x, gunAnchorData.y);
    } else {
      this.gun.anchor.set(0.5); // запасной вариант
    }

    // коэффициент масштабирования, чтобы соответствовать размеру танка
    const BAKER_BASE_SIZE = 10; // размер, использованный в текстурах
    this._scaleFactor = this._size / BAKER_BASE_SIZE;

    // масштаб ко всем спрайтам
    this.body.scale.set(this._scaleFactor);
    this.gun.scale.set(this._scaleFactor);
    this.wreck.scale.set(this._scaleFactor);

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
    const { rate, volumeFactor } = calculateEngineSoundParams(this._engineLoad);

    return {
      position: { x: this.x, y: this.y },
      rate,
      volume: this._baseEngineVolume * volumeFactor,
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
      this.gun.rotation = 0;

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
  }

  update(data) {
    this.x = data[M1_X];
    this.y = data[M1_Y];
    this.rotation = data[M1_ANGLE];
    this.gun.rotation = data[M1_GUN_ROTATION];
    this._engineLoad = data[M1_ENGINE_LOAD];

    const level = data[M1_LEVEL] || 0;

    this._z = data[M1_Z] || 0;

    if (level !== this._level) {
      this._level = level;
      this.zIndex = levelZ(TANK_BASE_Z, level);
    }

    // высота читается масштабом корпуса: танк на эстакаде крупнее наземного
    const zScale = 1 + this._z * Z_SCALE_GAIN;

    this.body.scale.set(this._scaleFactor * zScale);
    this.gun.scale.set(this._scaleFactor * zScale);

    if (this._levelView && this._isLocal()) {
      this._levelView.set(level, this.x, this.y);
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

  // останавливает и сбрасывает все звуки, связанные с танком
  destroySounds() {
    if (this._soundId) {
      this._soundManager.unregisterSound(this._soundId);
      this._soundId = null;
    }
  }

  destroy(options) {
    this.destroySounds();

    super.destroy({
      children: true,
      texture: false, // текстуры общие, не должны уничтожаться
      textureSource: false,
      ...options,
    });
  }
}
