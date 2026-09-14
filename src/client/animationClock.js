import { Ticker } from 'pixi.js';

// Общие часы анимаций карты: секунды с запуска, одно приращение на тик
// общего тикера. Движок может рисовать полотно несколько раз за тик, и все
// эти отрисовки обязаны видеть одно и то же время — иначе кадр тайла
// менялся бы тем быстрее, чем больше отрисовок пришло в тик. Часы одни на
// все карты и слои: вода и конвейеры разных слоёв идут синхронно.
export function createAnimationClock(ticker = Ticker.shared) {
  let lastTime = null;
  let seconds = 0;

  return {
    // секунды с первого обращения; повторный вызов в том же тике не
    // двигает время
    now() {
      const time = ticker.lastTime;

      if (time !== lastTime) {
        if (lastTime !== null) {
          seconds += Math.max(0, time - lastTime) / 1000;
        }

        lastTime = time;
      }

      return seconds;
    },
  };
}

export const animationClock = createAnimationClock();

// Время, квантованное по `maxFps`: смена кадра не чаще этого числа раз в
// секунду. 0 или отсутствие потолка — время как есть
export function quantizeTime(seconds, maxFps) {
  if (!(maxFps > 0)) {
    return seconds;
  }

  return Math.floor(seconds * maxFps) / maxFps;
}
