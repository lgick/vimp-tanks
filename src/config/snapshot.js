// Снапшот-схема игры (HostPlugin.gameConfig.snapshot): реестр ключей —
// строковый ключ → числовой id + форма блока (kind — ширина count/id,
// наличие null-маркера) + класс (class: 'hot' — интерполируется клиентом
// между кадрами, 'event' — одноразовый, кадром как есть) + схема полей
// строки (fields: порядок байтов в раскладке). Движок читает её из
// gameConfig (lib/coreConfig.js) и шлёт клиенту в CONFIG_DATA
// (lib/buildClientConfig.js) — сам движок раскладку не знает.
// Новое оружие/карта обязаны быть зарегистрированы здесь.
// optionalFrom: индекс первого поля опционального хвоста — поля с него
// пишутся в кадр только у движущихся тел, наличие задаёт флаг-байт перед
// строкой (покоящийся ящик не платит за скорости). Распаковка всё равно
// отдаёт строку полной ширины: отсутствующий хвост читается нулями.
// ВНИМАНИЕ: порядок и interp полей позиционно привязаны к Row-структурам
// packages/engine/core/src/snapshot.rs — interpolator.rs читает interp по
// индексу поля (schema.fields[i]), не по имени. Переставлять поля местами
// или менять interp без синхронной правки Rust-структур нельзя: validate()
// проверяет только количество и тип полей, не interp и не порядок по смыслу.
// Единственное поле m1 с interp: 'discrete' — vz: оно работает детектором
// касания (см. src/client/landing.js), а сглаженное значение точного нуля
// клиенту не даёт. Тип поля при этом обычный f32 — правок в Rust не нужно.
// Хвост m1 (angvel, z, level, vz, pitch, roll) обязан совпадать по ширине и
// порядку в трёх местах сразу: `TankRow::fields` и `players_json` хостового
// ядра (core/src/tanks.rs) и `render_overlay` клиентского
// (core/src/client/mod.rs).
export default {
  m1: {
    id: 1,
    kind: 'indexed8',
    class: 'hot',
    fields: [
      { name: 'x', ty: 'f32', interp: 'lerp' },
      { name: 'y', ty: 'f32', interp: 'lerp' },
      { name: 'angle', ty: 'f32', interp: 'lerpAngle' },
      { name: 'gunRotation', ty: 'f32', interp: 'lerpAngle' },
      { name: 'vx', ty: 'f32', interp: 'lerp' },
      { name: 'vy', ty: 'f32', interp: 'lerp' },
      { name: 'engineLoad', ty: 'f32', interp: 'lerp' },
      { name: 'condition', ty: 'u8' },
      { name: 'size', ty: 'u8' },
      { name: 'team', ty: 'u8' },
      // угловая скорость корпуса: клиент доворачивает чужой танк за задержку
      // интерполяции (RemoteTanks); interp — 'lerp', это скорость, не угол
      { name: 'angvel', ty: 'f32', interp: 'lerp' },
      // 2.5D: визуальная высота 0..1 (рампа/падение) и дискретный уровень.
      // z интерполируется — подъём по рампе и падение обязаны быть плавными
      // у зрителя; level дискретен — он переключает zIndex и набор
      // коллизий, промежуточных значений у него нет
      { name: 'z', ty: 'f32', interp: 'lerp' },
      { name: 'level', ty: 'u8' },
      // вертикальная скорость (уровней/с, 0 на земле) и наклон корпуса в
      // радианах: наклон авторитетен, клиент его не восстанавливает из
      // разницы высот между кадрами — у стоящего танка та нулевая.
      // `vz` НЕ интерполируется: это детектор касания, а не плавная
      // величина. `lerp` размазывал щелчок `vz → 0` по буферу
      // интерполяции, и приземление ЧУЖОГО танка (просадка, пыль, звук)
      // не детектировалось вовсе: условие `vz === 0` требует точного нуля,
      // а сглаженная выборка его почти никогда не даёт
      // (см. src/client/landing.js)
      { name: 'vz', ty: 'f32', interp: 'discrete' },
      { name: 'pitch', ty: 'f32', interp: 'lerp' },
      { name: 'roll', ty: 'f32', interp: 'lerp' },
    ],
  },
  w1: {
    id: 2,
    kind: 'list16',
    class: 'event',
    fields: [
      { name: 'startX', ty: 'f32' },
      { name: 'startY', ty: 'f32' },
      { name: 'endX', ty: 'f32' },
      { name: 'endY', ty: 'f32' },
      { name: 'bodyX', ty: 'f32' },
      { name: 'bodyY', ty: 'f32' },
      { name: 'wasHit', ty: 'u8' },
      { name: 'shooterId', ty: 'u8' },
      // 2.5D: уровень начала и конца луча. Клиент мог бы вывести оба сам
      // из своей копии слоёв, но тогда картинка трассера зависела бы от
      // ещё одного повторённого алгоритма — два байта дешевле
      { name: 'startLevel', ty: 'u8' },
      { name: 'endLevel', ty: 'u8' },
    ],
  },
  w2: {
    id: 3,
    kind: 'indexed32',
    class: 'event',
    fields: [
      { name: 'x', ty: 'f32' },
      { name: 'y', ty: 'f32' },
      { name: 'angle', ty: 'f32' },
      { name: 'size', ty: 'u8' },
      { name: 'time', ty: 'u16' },
      { name: 'ownerId', ty: 'u8' },
      // 2.5D: уровень, на котором лежит бомба (взрыв поражает только его)
      { name: 'level', ty: 'u8' },
    ],
  },
  w2e: {
    id: 4,
    kind: 'list16',
    class: 'event',
    fields: [
      { name: 'x', ty: 'f32' },
      { name: 'y', ty: 'f32' },
      { name: 'radius', ty: 'f32' },
      // 2.5D: уровень взрыва — плита моста экранирует его и вверх, и вниз
      { name: 'level', ty: 'u8' },
    ],
  },
  c1: {
    id: 5,
    kind: 'indexedNoNull8',
    class: 'hot',
    optionalFrom: 5,
    fields: [
      { name: 'x', ty: 'f32', interp: 'lerp' },
      { name: 'y', ty: 'f32', interp: 'lerp' },
      { name: 'angle', ty: 'f32', interp: 'lerpAngle' },
      // 2.5D: высота и уровень тела карты. Обязательная голова, а не хвост:
      // покоящееся тело хвост не шлёт, и уровень читался бы нулём
      { name: 'z', ty: 'f32', interp: 'lerp', role: 'z' },
      { name: 'level', ty: 'u8', role: 'level' },
      { name: 'vx', ty: 'f32', interp: 'lerp' },
      { name: 'vy', ty: 'f32', interp: 'lerp' },
      { name: 'angvel', ty: 'f32', interp: 'lerp' },
    ],
  },
  c2: {
    id: 6,
    kind: 'indexedNoNull8',
    class: 'hot',
    optionalFrom: 5,
    fields: [
      { name: 'x', ty: 'f32', interp: 'lerp' },
      { name: 'y', ty: 'f32', interp: 'lerp' },
      { name: 'angle', ty: 'f32', interp: 'lerpAngle' },
      // 2.5D: высота и уровень тела карты. Обязательная голова, а не хвост:
      // покоящееся тело хвост не шлёт, и уровень читался бы нулём
      { name: 'z', ty: 'f32', interp: 'lerp', role: 'z' },
      { name: 'level', ty: 'u8', role: 'level' },
      { name: 'vx', ty: 'f32', interp: 'lerp' },
      { name: 'vy', ty: 'f32', interp: 'lerp' },
      { name: 'angvel', ty: 'f32', interp: 'lerp' },
    ],
  },
};
