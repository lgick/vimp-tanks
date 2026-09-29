# Этап 4 (по желанию, рекомендуется). Копоть — отдельный класс `WreckScorch` (С1) ✅ выполнен

Делать после этапов 1–3. Если этап откладывается, план считается выполненным без него: отметить это в заголовке
(«отложен») и в таблице README.

## 4.1. Новый файл `src/client/parts/WreckScorch.js`

Это не парт: в `parts/index.js` его не регистрировать, как и `ParticleChannel`/`ParticlePool`. Класс владеет
спрайтом копоти, его проекцией, проявлением и уничтожением:

```js
import { Sprite } from 'pixi.js';
import { clamp } from 'vimp-engine/lib/math.js';
import { levelZ } from '../levelZ.js';
import { offsetPoint } from '../parallax.js';
import { parallax as parallaxConfig, wreckFx } from '../../config/render.js';

// как воронка (FunnelEffect): над следами (1), под танком (3)
const SCORCH_BASE_Z = 2;
const TAU = Math.PI * 2;

// Копоть остова: спрайт-сиблинг на сцене (мимо GameView.add, как
// ExplosionEffectController.run) в точке гибели; живёт до респауна.
// Владелец — WreckFire: шагает (step), проецирует (render), снимает (destroy)
export default class WreckScorch {
  constructor(stage, asset, { x, y, z, level, sizeScale }) { … }
  // проявилась полностью
  get settled() { … }
  step(dt) { … }            // бывший WreckFire._stepScorch
  render(camera, levelView) { … } // бывшая «копоть»-часть WreckFire._render
  destroy() { … }           // sprite.destroy({ texture: false, textureSource: false })
}
```

Импорты сверить с тем, что реально использует перенесённый код (`clamp`, `offsetPoint` и т. д.); лишние не
тащить.

Тела перенести из `WreckFire` без изменения формул:
- конструктор = бывший `_addScorch` после проверок. Случайная текстура, поворот, `alpha = 0`, `zIndex`,
  `scale = size·sizeScale / contentSize`, `stage.addChild(sprite)`, `stage.sortChildren()`;
- `render` = блок `if (this._scorch) { … }` из `_render`.

## 4.2. `WreckFire`

- поле `_scorch` теперь `WreckScorch | null`, поля `_scorchX … _scorchAlpha` и константа `SCORCH_BASE_Z`
  удаляются;
- `_addScorch` оставляет проверки (`enabled`, ассет, `parent`, отложенность в полёте из этапа 1) и создаёт
  `new WreckScorch(this.parent, asset, { x: this._x, y: this._y, z: this._z, level: this._level,
  sizeScale: this._sizeScale })`;
- `_stepScorch(dt)` → `this._scorch?.step(dt)`;
- в `_render` → `this._scorch?.render(camera, this._levelView)`;
- `_scorchSettled()` → `!this._scorchPending && (!this._scorch || this._scorch.settled)`;
- `_reset` → `this._scorch?.destroy(); this._scorch = null;`.

## 4.3. Тесты

- новый `tests/client/parts/WreckScorch.test.js`: проявление за `fadeIn`; проекция `offsetPoint` при `z > 0`
  (сцена без трансформа — центр камеры `(400, 300)` при `renderer.screen 800×600`, как в `WreckFire.test.js`);
  `alpha`/`tint` через `levelView`; `destroy` снимает спрайт со сцены и не уничтожает текстуру;
- в `WreckFire.test.js` обновить обращения: `part._scorchX` → `part._scorch.x` (или как назван геттер),
  `part._scorch.position.x` → `part._scorch.sprite.position.x`, `part._scorchAlpha` / `part._scorchScale` → поля
  `WreckScorch`. Проверки «копоть — сиблинг на сцене» (`scorchesOf`) не меняются: на сцене по-прежнему `Sprite`.

## 4.4. Документация

В `docs/en/architecture.md` и `docs/ru/architecture.md`, в абзаце про системы частиц рядом с `ParticleChannel`,
одной фразой упомянуть `WreckScorch`: «копоть — `parts/WreckScorch.js`, сиблинг на сцене». CHANGELOG не меняется
(рефакторинг).

## Проверка этапа

`npx eslint . --quiet`, `npm test -- --silent`: зелёные, тестов +N (новый файл `WreckScorch.test.js`).

> Общий контекст, находки и правила — в [README.md](README.md).
