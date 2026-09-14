// Гейт сборки: какие картинки просят карты и каких из них нет на диске.
// Картинки живут в пакете игры (assets/img/ -> dist/img/ скриптом
// copy-game-images.js) и приезжают клиенту как `${assetsBase}img/<file>`.
// Промах имени движок не диагностирует никак: part просто не дождётся
// текстуры, и карта отрисуется пустым полотном без ошибки — поэтому ловим
// на сборке (build-game-manifest.js).
//
// Чистые функции без fs: предикат существования файла передаётся снаружи.

// имена картинок, которые карта просит у клиента: spriteSheet.img (тайл-лист
// статического слоя), img каждого динамического тела и картинки состояний
// пропа — game.imgDamaged/game.imgDestroyed (правило E2 движка поле `game`
// не видит, поэтому проверка остаётся здесь)
export function collectRequiredImages(maps) {
  const required = new Set();

  for (const map of maps) {
    if (map.spriteSheet?.img) {
      required.add(map.spriteSheet.img);
    }

    for (const body of map.physicsDynamic || []) {
      for (const img of [
        body.img,
        body.game?.imgDamaged,
        body.game?.imgDestroyed,
      ]) {
        if (img) {
          required.add(img);
        }
      }
    }
  }

  return [...required].sort();
}

// requiredImages — результат collectRequiredImages, exists(file) — есть ли
// картинка с таким именем среди собранных
export function collectMissingImages(requiredImages, exists) {
  return requiredImages.filter(file => !exists(file));
}
