import { Text, Ticker, Container, Sprite } from 'pixi.js';
import { levelZ } from '../levelZ.js';
import {
  W2_X,
  W2_Y,
  W2_ANGLE,
  W2_SIZE,
  W2_TIME,
  W2_LEVEL,
} from '../snapshotFields.js';

// базовый zIndex бомбы внутри своего уровня
const BOMB_BASE_Z = 2;

export default class Bomb extends Container {
  constructor(params, assets, dependencies) {
    super();

    // 2.5D: уровень, на котором лежит бомба (строка w2)
    this._level = params[W2_LEVEL] || 0;
    this.zIndex = levelZ(BOMB_BASE_Z, this._level);

    // бомба на мосту гаснет вместе с плитой, бомба под мостом темнеет:
    // единая формула прозрачности живёт в сервисе levelView
    this._levelView = dependencies.levelView || null;

    // `onRender` — аксессор Container: назначаем свойством, иначе сеттер
    // не отработает и колбэк не позовётся ни разу
    if (this._levelView) {
      this.onRender = () => {
        this.alpha = this._levelView.alphaFor(this._level, this.x, this.y);
        this.tint = this._levelView.tintFor(this._level);
      };
    }

    this.body = new Sprite(assets.bombTexture);
    this.body.anchor.set(0.5);

    this.x = params[W2_X];
    this.y = params[W2_Y];

    this.rotation = params[W2_ANGLE];
    this._size = params[W2_SIZE]; // соотношение сторон 1:1
    this._totalDurationMs = params[W2_TIME];

    this._soundManager = dependencies.soundManager;
    this._soundId = null;

    // спрайт под нужный размер
    // текстура квадратная
    const textureSize = assets.bombTexture.width;
    const scale = this._size / textureSize;
    this.body.scale.set(scale);

    // фиксированный размер шрифта для рендера текстуры,
    // чтобы текст был четким (векторное качество)
    const renderFontSize = 64;

    // масштаб под размер бомбы
    const fontScale = this._size / 1.2 / renderFontSize;

    this.text = new Text({
      style: {
        fontFamily: 'Arial',
        fontSize: renderFontSize,
        fill: 0xffffff,
        align: 'center',
      },
    });

    this.text.anchor.set(0.5);
    this.text.scale.set(fontScale);
    this.text.x = 0;
    this.text.y = 0;

    // накопленное время с момента создания
    this._accumulatedTimeMs = 0;
    this._secondsLeft = '';

    this.addChild(this.body, this.text);
    this._updateTimerDisplay(this._totalDurationMs);

    this._tickListener = ticker => this._updateTimer(ticker.deltaMS);
    Ticker.shared.add(this._tickListener);

    this._soundId = this._soundManager.registerSound('bombHasBeenPlanted', {
      position: {
        x: this.x,
        y: this.y,
      },
    });
  }

  // обновление таймера и звука
  _updateTimer(deltaMs) {
    this._accumulatedTimeMs += deltaMs;

    const remainingMs = Math.max(
      0,
      this._totalDurationMs - this._accumulatedTimeMs,
    );

    this._updateTimerDisplay(remainingMs);

    if (remainingMs <= 0) {
      this._stopTimer();
      this._updateTimerDisplay(0);
    }
  }

  _updateTimerDisplay(remainingMs) {
    const time = Math.round(remainingMs / 1000);

    if (this._secondsLeft !== time) {
      this._secondsLeft = time;
      this.text.text = `${this._secondsLeft}`;
    }
  }

  // авторитетная строка приходит один раз — подтверждением локально
  // предсказанной бомбы: переносим сущность в авторитетную точку
  update(params) {
    this.x = params[W2_X];
    this.y = params[W2_Y];
    this.rotation = params[W2_ANGLE];

    if (this._soundId) {
      const alive = this._soundManager.updateSoundData(this._soundId, {
        position: { x: this.x, y: this.y },
      });

      // регистрацию мог снять reset(); перерегистрировать нечего —
      // сэмпл постановки одноразовый
      if (!alive) {
        this._soundId = null;
      }
    }
  }

  _stopTimer() {
    if (this._tickListener) {
      Ticker.shared.remove(this._tickListener);
      this._tickListener = null;
    }
  }

  destroy(options) {
    this._stopTimer();

    if (this._soundId) {
      // одноразовый сэмпл постановки живёт дольше самой бомбы (её убирает
      // детонация через weapon.time) — отпускаем, а не обрываем
      this._soundManager.releaseSound(this._soundId);
      this._soundId = null;
    }

    super.destroy({
      children: true,
      texture: false,
      textureSource: false,
      ...options,
    });

    this.body = null;
    this.text = null;
  }
}
