import { Container, Sprite } from 'pixi.js';
import { levelZ } from '../levelZ.js';

// базовый zIndex маркера на радаре внутри своего уровня
const TANK_RADAR_BASE_Z = 2;

export default class TankRadar extends Container {
  constructor(data, assets) {
    super();

    // 2.5D: маркер танка с эстакады лежит над маркерами земли. Отдельного
    // знака уровня у чужого танка пока нет (отложено, plan/README.md)
    this._level = data[12] || 0;
    this.zIndex = levelZ(TANK_RADAR_BASE_Z, this._level);

    this._textures = assets.tankRadarTexture;

    this.body = new Sprite();
    this.body.anchor.set(0.5);

    this.addChild(this.body);

    // параметры с сервера:
    // [x, y, rotation, gunRotation, vX, vY,
    // engineLoad, condition, size, teamId]
    this.x = data[0] || 0;
    this.y = data[1] || 0;
    this._condition = data[7];
    this._teamId = data[9];

    // масштаб контейнера
    this.scale.set(5, 5);

    this.create();
  }

  create() {
    // если танк уничтожен
    if (this._condition === 0) {
      this.body.texture = this._textures.destroyed;
    } else {
      // определение текстуры в зависимости от команды
      if (this._teamId === 1) {
        this.body.texture = this._textures.liveTeamId1;
      } else if (this._teamId === 2) {
        this.body.texture = this._textures.liveTeamId2;
      }
    }
  }

  update(data) {
    this.x = data[0];
    this.y = data[1];

    const level = data[12] || 0;

    if (level !== this._level) {
      this._level = level;
      this.zIndex = levelZ(TANK_RADAR_BASE_Z, level);
    }

    const newCondition = data[7];
    const teamId = data[9];
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

  destroy(options) {
    super.destroy({
      children: true,
      texture: false, // текстуры общие
      textureSource: false,
      ...options,
    });

    this.body = null;
    this._textures = null;
  }
}
