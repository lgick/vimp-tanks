// Центр камеры в мировых координатах. Движкового API «дай камеру» нет:
// камера — это трансформ сцены, им владеет движок
// (CanvasManagerView.updateCoords: `stage.position = (w/2 - camX * scale,
// h/2 - camY * scale)`, `stage.scale = scale`). Парт восстанавливает центр
// обратной подстановкой — по своему родителю (он же сцена) и размеру полотна.
//
// null — пока парт не добавлен на сцену или рендерер недоступен: звать
// раньше первого кадра нормально, а гадать за движок — нет.
export function cameraCenter(parent, renderer) {
  const screen = renderer?.screen;

  if (!parent || !screen || !parent.scale.x || !parent.scale.y) {
    return null;
  }

  return {
    x: (screen.width / 2 - parent.position.x) / parent.scale.x,
    y: (screen.height / 2 - parent.position.y) / parent.scale.y,
    scaleX: parent.scale.x,
    scaleY: parent.scale.y,
  };
}
