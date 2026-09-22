import { BlurFilter, Container, Rectangle, Text } from 'pixi.js';
import blurMargin, { blurPadding } from '../../bakers/blurMargin.js';

// Кэш текстур неоновых вывесок. Бейкер здесь не годится: текстов много, и
// приходят они из карты. Текстуры белые — цвет вывеска задаёт `tint`,
// поэтому ключ — только текст и размер.
//
// Кэш общий на сессию, со счётчиком ссылок по рендереру и ключу: на нуле
// текстуры освобождаются. Счётчик обязателен и из-за потери WebGL-контекста:
// движок при восстановлении уничтожает все части, счётчик падает до нуля,
// мёртвые текстуры уходят, и новые вывески запекаются заново. Кэш без
// счётчика отдал бы новым частям текстуры мёртвого контекста.
// `Assets.unload` здесь ни при чём — это не ассеты.

// renderer -> Map(key -> { core, glow, count })
const caches = new WeakMap();

export function neonKey({ text, size }) {
  return `${size}|${text}`;
}

// сила размытия ореола от размера шрифта
export function neonBlur(size) {
  return Math.max(2, Math.round(size / 4));
}

function bake(renderer, { text, size }) {
  const blur = neonBlur(size);
  const margin = blurMargin(blur);
  const wrapper = new Container();
  const label = new Text({
    text: String(text),
    style: {
      fontFamily: 'monospace',
      fontWeight: 'bold',
      fontSize: size,
      fill: 0xffffff,
    },
  });

  label.position.set(margin, margin);
  wrapper.addChild(label);

  // ядро и ореол — одного размера кадра: оба спрайта вывески ставятся
  // якорем в центр и совпадают без подгонки
  const frame = new Rectangle(
    0,
    0,
    Math.ceil(label.width) + margin * 2,
    Math.ceil(label.height) + margin * 2,
  );
  const core = renderer.generateTexture({ target: wrapper, frame });
  const filter = new BlurFilter({ strength: blur, quality: 6 });

  // запас работает только в паре с padding (см. blurMargin), а область
  // шире рамки — чтобы мусор пула с края не попал в текстуру
  filter.padding = blurPadding(blur);
  label.filters = [filter];

  const glow = renderer.generateTexture({ target: wrapper, frame });

  label.filters = [];
  filter.destroy();
  wrapper.destroy({ children: true });

  return { core, glow };
}

// +1 к счётчику; на первом взятии ключа текстуры запекаются
export function getNeonTextures(renderer, spec) {
  let cache = caches.get(renderer);

  if (!cache) {
    cache = new Map();
    caches.set(renderer, cache);
  }

  const key = neonKey(spec);
  let entry = cache.get(key);

  if (!entry) {
    entry = { ...bake(renderer, spec), count: 0 };
    cache.set(key, entry);
  }

  entry.count += 1;

  return { core: entry.core, glow: entry.glow };
}

// −1 к счётчику; на нуле текстуры освобождаются. Зовётся, когда спрайты
// вывески уже сняты со сцены
export function releaseNeonTextures(renderer, spec) {
  const cache = caches.get(renderer);
  const key = neonKey(spec);
  const entry = cache?.get(key);

  if (!entry) {
    return;
  }

  entry.count -= 1;

  if (entry.count > 0) {
    return;
  }

  cache.delete(key);
  entry.core.destroy(true);
  entry.glow.destroy(true);
}
