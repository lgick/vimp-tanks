import { Container, Rectangle, Sprite, Spritesheet } from 'pixi.js';

// «Запекание» одного рендер-слоя карты в единственную текстуру: тайлы
// раскладываются во временный контейнер и снимаются одним
// `renderer.generateTexture`. Слоёв на карте единицы, а тайлов — тысячи:
// без запекания каждый кадр стоил бы обхода всей сетки.
//
// Общий код `Map` (плоский слой) и `MapVolume` (его же экструзия): обе
// стороны обязаны видеть ОДНУ И ТУ ЖЕ картинку, иначе объём разъедется
// со своим основанием.
//
// Текстура принадлежит вызывающему: она сделана под конкретный экземпляр
// карты, и освобождать её обязан он (`textureSource: true`).
export async function bakeTileLayer({
  baseTexture,
  spriteSheetData,
  map,
  tiles,
  step,
  renderer,
}) {
  const framesData = {};

  spriteSheetData.frames.forEach((frameDef, index) => {
    const [x, y, width, height] = frameDef;

    framesData[`frame${index}`] = {
      frame: { x, y, w: width, h: height },
    };
  });

  // полная структура JSON для спрайт-листа
  const sheetDataForPixi = {
    frames: framesData,
    meta: {
      scale: '1', // масштаб спрайтшита
    },
  };

  const spriteSheet = new Spritesheet(baseTexture, sheetDataForPixi);
  await spriteSheet.parse();

  const mapWidth = map[0].length * step;
  const mapHeight = map.length * step;

  // временный контейнер для размещения всех тайлов
  const tempContainer = new Container();

  for (let y = 0, lenY = map.length; y < lenY; y += 1) {
    for (let x = 0, lenX = map[y].length; x < lenX; x += 1) {
      const tileIndex = map[y][x];

      if (tiles.includes(tileIndex)) {
        // предполагается, что spriteSheet имеет свойство textures,
        // где ключ соответствует названию тайла
        const textureName = `frame${tileIndex}`;
        const texture = spriteSheet.textures[textureName];

        if (texture) {
          const sprite = new Sprite(texture);

          sprite.x = x * step;
          sprite.y = y * step;

          tempContainer.addChild(sprite);
        } else {
          console.warn(
            `Texture not found. Tile: ${tileIndex}, sprite: ${textureName}`,
          );
        }
      }
    }
  }

  const bakedTexture = renderer.generateTexture({
    target: tempContainer,
    frame: new Rectangle(0, 0, mapWidth, mapHeight),
  });

  // очищаем временный контейнер и разбор тайл-листа: `Spritesheet` держит
  // по текстуре на кадр, а нужен он был только на время запекания. Сам
  // baseTexture — общий ассет игры и остаётся в кеше Assets
  tempContainer.destroy({ children: true });
  spriteSheet.destroy();

  return bakedTexture;
}
