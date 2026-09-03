import { Container, Graphics } from 'pixi.js';
import { levelZ } from '../levelZ.js';

// базовый zIndex схемы карты внутри своего уровня
const MAP_RADAR_BASE_Z = 2;

// цвет стен по уровням: эстакада читается отдельно от земли
const LEVEL_COLORS = [0xffffff, 0x8fb7ff];

export default class MapRadar extends Container {
  constructor(data) {
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

    graphics.fill(LEVEL_COLORS[this._level] ?? LEVEL_COLORS[0]);
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
