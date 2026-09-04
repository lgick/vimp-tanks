import { Container, Graphics } from 'pixi.js';
import { levelZ } from '../levelZ.js';
import { levelColor } from '../levelColors.js';

// базовый zIndex схемы карты внутри своего уровня
const MAP_RADAR_BASE_Z = 2;

// прозрачность уровней, отличных от уровня игрока: на схеме важнее всего,
// где он сам, а соседние этажи остаются подсказкой, а не мешаниной
const OTHER_LEVEL_ALPHA = 0.35;

export default class MapRadar extends Container {
  constructor(data, _assets, dependencies = {}) {
    super();

    // сохраняем необходимые данные для схематичной карты
    this._map = data.map;
    this._level = data.level || 0;
    // solid — препятствия своего уровня (у земли это physicsStatic,
    // у эстакады — её перила)
    this._solid = data.solid || data.physicsStatic || [];
    this._tiles = data.tiles || [];
    this._step = data.step;
    this.zIndex = levelZ(MAP_RADAR_BASE_Z, this._level);
    this.scale = data.scale;

    // рисуем стены только тем слоем, который эти стены и показывает:
    // иначе каждый рендер-слой карты дублировал бы одну и ту же графику
    this._draws = this._tiles.some(tile => this._solid.includes(tile));

    this.radarGraphics = new Graphics();
    this.addChild(this.radarGraphics);

    // уровень игрока: чужие этажи на схеме гаснут (задача 3 мастер-плана).
    // `onRender` — аксессор Container, назначается свойством; слою, который
    // ничего не рисует, колбэк не нужен
    this._levelView = dependencies.levelView || null;

    if (this._levelView && this._draws) {
      this.onRender = () => {
        this.alpha =
          this._levelView.level === this._level ? 1 : OTHER_LEVEL_ALPHA;
      };
    }

    // создаем схематичную карту
    this.createRadarMap();
  }

  createRadarMap() {
    if (!this._draws) {
      return;
    }

    const graphics = this.radarGraphics;

    graphics.clear();

    if (Array.isArray(this._map)) {
      for (let y = 0; y < this._map.length; y += 1) {
        const row = this._map[y];

        if (Array.isArray(row)) {
          for (let x = 0; x < row.length; x += 1) {
            const tileType = row[x];

            // проверяем, является ли текущий тайл препятствием (physicsStatic)
            if (this._solid.includes(tileType)) {
              graphics.rect(
                x * this._step,
                y * this._step,
                this._step / 2,
                this._step / 2,
              );
            }
          }
        }
      }
    }

    graphics.fill(levelColor(this._level));
  }

  update() {}

  destroy(options) {
    super.destroy({
      children: true,
      texture: false,
      textureSource: false,
      ...options,
    });

    this.radarGraphics = null;
    this._map = null;
    this._solid = null;
    this._tiles = null;
  }
}
