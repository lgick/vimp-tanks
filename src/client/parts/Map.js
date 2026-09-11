import { Container } from 'pixi.js';
import MapLayer from './map/MapLayer.js';
import MapObject from './map/MapObject.js';

// Парт карты — диспетчер двух стратегий. Движок отдаёт статические слои
// (`s0..sN`) и динамические тела (`d0..dN`) в ОДИН и тот же список имён
// (`gameSets[setId]`, src/config/client.js), поэтому имя парта одно на оба
// вида данных, а разделяются они внутри: `MapLayer` — запечённый слой,
// его объём и клин рампы, `MapObject` — точечное тело (ящик).
//
// Парт остаётся `Container`: движок создаёт его как
// `new Part(data, assets, dependencies, context)` и кладёт результат на
// сцену — подменить экземпляр из конструктора нельзя. Стратегия рисует В
// ЭТОТ контейнер: ей нужны и дети, и zIndex, и alpha, и filters самого парта
export default class Map extends Container {
  constructor(data, _assets, dependencies) {
    super();

    this._mode = null;

    // База ассетов активной игры — движок отдаёт её сервисом assetsBase
    // (объявлен в componentDependencies, src/config/client.js). Картинки
    // карт везёт сам пакет игры: assets/img/ -> dist/img/, а движок ни одного
    // игрового файла не раздаёт. Без базы вышел бы запрос на
    // "undefinedimg/tiles.png" — полотно осталось бы пустым без единой
    // ошибки, поэтому промах ловим здесь и вслух.
    //
    // Логируем, а не бросаем: конструктор вызывается из рендер-тика
    // (renderTick -> applyGameData -> GameCtrl.parse -> фабрика), где на всём
    // пути нет ни одного try/catch — исключение оборвало бы создание всех
    // остальных сущностей этого кадра. Тот же паттерн «громко в лог, ничего
    // наружу», что у самих стратегий.
    if (typeof dependencies.assetsBase !== 'string') {
      console.error(
        'Map: сервис assetsBase недоступен — карта останется пустой. ' +
          'Объявите assetsBase в componentDependencies и запустите игру ' +
          'на vimp-engine >= 0.9.0',
      );

      return;
    }

    const imageBase = `${dependencies.assetsBase}img/`;

    this._mode =
      data.type === 'dynamic'
        ? new MapObject(this, data, dependencies, imageBase)
        : new MapLayer(this, data, dependencies, imageBase);

    // `onRender` у Container — АКСЕССОР, а не метод: назначается только
    // свойством. Метод с этим именем на прототипе подкласса затенил бы
    // сеттер, PixiJS не позвал бы ничего и фича умерла бы молча.
    // (в конструкторе renderGroup ещё null, но RenderGroup.addChild сам
    // подхватит `_onRender` при добавлении на сцену)
    if (this._mode.needsRender) {
      this.onRender = () => this._mode.render();
    }
  }

  update(data) {
    this._mode?.update?.(data);
  }

  destroy(options) {
    // стратегия освобождает своё ДО `super.destroy` и возвращает то, что
    // обязано пережить его: GPU-ресурсы отдаются только после того, как
    // парт снят со сцены
    const released = this._mode?.destroy();

    this._mode = null;

    super.destroy({
      children: true,
      texture: false,
      textureSource: false,
      ...options,
    });

    released?.();
  }
}
