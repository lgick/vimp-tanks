import { Assets, Container, Mesh, MeshGeometry } from 'pixi.js';
import { levelZ } from '../levelZ.js';
import { cameraCenter } from '../camera.js';
import { volume as volumeConfig } from '../../config/render.js';
import { bakeTileLayer } from './bakeTileLayer.js';

// Объёмные элементы карты (задача 7 мастер-плана): рендер-слой с высотой
// (`volume` — поле карты `volumes`, приезжает из движка в контексте парта)
// рисуется экструзией — K копиями своей же картинки, каждая следующая
// сдвинута ОТ центра камеры сильнее предыдущей. Так стены «раскрываются»
// при движении игрока, как дома в GTA 2.
//
// Срезами, а не блоками: цена эффекта — K вызовов отрисовки на слой
// независимо от числа стен. Поблочная геометрия на карте 80 x 60 — это
// сотни четырёхугольников с пересчётом каждый кадр, то есть гарантированно
// уроненный fps.
//
// Слой без высоты парт игнорирует целиком: ни сетки, ни `onRender`.

// камера сдвинулась меньше этого (в мировых единицах) — вершины не трогаем
const CAMERA_EPSILON = 0.01;

export default class MapVolume extends Container {
  constructor(data, _assets, dependencies) {
    super();

    this._renderer = dependencies.renderer;
    this._cfg = volumeConfig;
    this._volume = Number(data.volume) || 0;
    this._slices = [];
    this._basePositions = null;
    this._texture = null;
    this._camX = null;
    this._camY = null;

    // высоты нет, парт выключен конфигом или это динамическое тело (парт
    // получает те же контексты, что и `Map`) — молча ничего не делаем
    if (
      data.type !== 'static' ||
      this._volume <= 0 ||
      !this._cfg.enabled ||
      this._cfg.slices < 1
    ) {
      return;
    }

    // та же диагностика, что у Map: конструктор зовётся из рендер-тика, где
    // перехватчика нет, поэтому промах базы ассетов только логируется
    if (typeof dependencies.assetsBase !== 'string') {
      console.error(
        'MapVolume: сервис assetsBase недоступен — объём не построен.',
      );

      return;
    }

    this.scale = data.scale;

    this._map = data.map;
    this._tiles = data.tiles;
    this._step = data.step;
    this._spriteSheetData = data.spriteSheet;
    this._level = data.level || 0;

    // объём лежит поверх своего же плоского слоя: тот остаётся основанием
    // блока, а половина шага zIndex гарантирует, что между ними ничего
    // не вклинится
    this.zIndex = levelZ(Number(data.layer) || 1, this._level) + 0.5;

    this._assetUrl = `${dependencies.assetsBase}img/${data.spriteSheet.img}`;
    this._baseTexturePromise = Assets.load(this._assetUrl);

    // `onRender` — аксессор Container: назначается свойством, иначе сеттер
    // не отработает и PixiJS не позовёт колбэк ни разу
    this.onRender = () => this._updateSlices();

    this.createSlices();
  }

  async createSlices() {
    try {
      this._texture = await bakeTileLayer({
        baseTexture: await this._baseTexturePromise,
        spriteSheetData: this._spriteSheetData,
        map: this._map,
        tiles: this._tiles,
        step: this._step,
        renderer: this._renderer,
      });

      const cols = this._map[0].length;
      const rows = this._map.length;
      const step = this._step;

      // узлы по клеткам тайлов: сдвиг вершины зависит от её места на карте,
      // одним трансформом это не выражается
      const positions = [];
      const uvs = [];
      const indices = [];

      for (let row = 0; row <= rows; row += 1) {
        for (let col = 0; col <= cols; col += 1) {
          positions.push(col * step, row * step);
          uvs.push(col / cols, row / rows);
        }
      }

      for (let row = 0; row < rows; row += 1) {
        for (let col = 0; col < cols; col += 1) {
          const a = row * (cols + 1) + col;
          const b = a + 1;
          const c = a + cols + 1;
          const d = c + 1;

          indices.push(a, b, c, b, d, c);
        }
      }

      this._basePositions = Float32Array.from(positions);

      const uvArray = Float32Array.from(uvs);
      const indexArray = Uint32Array.from(indices);

      for (let i = 1; i <= this._cfg.slices; i += 1) {
        const geometry = new MeshGeometry({
          positions: Float32Array.from(positions),
          uvs: uvArray,
          indices: indexArray,
        });

        const mesh = new Mesh({ geometry, texture: this._texture });

        // нижние срезы — боковые грани блока, они темнее; верхний остаётся
        // самим слоем и рисуется последним, поверх остальных
        mesh.tint = i === this._cfg.slices ? 0xffffff : this._cfg.sideTint;

        this._slices.push({ mesh, factor: i / this._cfg.slices });
        this.addChild(mesh);
      }

      this._camX = null;
      this._updateSlices();
    } catch (error) {
      console.error(
        `Failed to create map volume with asset ${this._assetUrl}:`,
        error,
      );
    }
  }

  // сдвиг вершины: d = (p - центр камеры) * volume * shear * (i / K).
  // Центр камеры парт вычисляет сам — движкового API «дай камеру» нет
  // (см. src/client/camera.js)
  _updateSlices() {
    if (!this._basePositions || !this.parent) {
      return;
    }

    const camera = cameraCenter(this.parent, this._renderer);

    if (!camera) {
      return;
    }

    // мировой центр камеры в координатах контейнера: сетка живёт в
    // немасштабированных единицах карты, как и запечённая текстура
    const camX = camera.x / this.scale.x;
    const camY = camera.y / this.scale.y;

    if (
      this._camX !== null &&
      Math.abs(camX - this._camX) < CAMERA_EPSILON &&
      Math.abs(camY - this._camY) < CAMERA_EPSILON
    ) {
      return;
    }

    this._camX = camX;
    this._camY = camY;

    const base = this._basePositions;

    for (let s = 0; s < this._slices.length; s += 1) {
      const { mesh, factor } = this._slices[s];
      const k = this._volume * this._cfg.shear * factor;
      const positions = mesh.geometry.positions;

      for (let i = 0; i < base.length; i += 2) {
        positions[i] = base[i] + (base[i] - camX) * k;
        positions[i + 1] = base[i + 1] + (base[i + 1] - camY) * k;
      }

      mesh.geometry.getBuffer('aPosition').update();
    }
  }

  // карта статична: строк динамики этому парту не адресуют, но фабрика
  // движка зовёт update() у всех — пустое тело дешевле проверки на стороне
  // движка
  update() {}

  destroy(options) {
    // текстура сделана `renderer.generateTexture` под конкретный экземпляр
    // карты — освобождать её обязан парт (как Map.mapSprite)
    if (this._texture) {
      this._texture.destroy(true);
      this._texture = null;
    }

    super.destroy({
      children: true,
      texture: false,
      textureSource: false,
      ...options,
    });

    this._slices = [];
    this._basePositions = null;
    this._map = null;
    this._tiles = null;
    this._spriteSheetData = null;
    this._renderer = null;
    this._baseTexturePromise = null;
  }
}
