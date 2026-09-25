// Куски трассера по уровням: сегменты луча из ядра (`shots.path`) →
// непересекающиеся отрезки `[{ from, to, level }]` от 0 до `total`.
//
// Правила сегментов (`core/src/shot_levels.rs`): вниз луч падает в первой
// клетке без плиты — сегменты идут встык; вверх у кромки плиты верхний
// уровень получает окно на клетку ПОВЕРХ продолжающегося нижнего — сегменты
// перекрываются. Рисовать окно на верхнем уровне нельзя: наземный трассер,
// прошедший под кромкой моста, прыгнул бы на плиту. Поэтому в перекрытии
// выигрывает сегмент, начатый РАНЬШЕ (луч продолжает свой уровень).
//
// Уровень конца — из строки трассера (`W1_END_LEVEL`): попадание судит хост,
// и осколки лежат там же. Если конец достался окну верхнего уровня
// (попадание в цель на кромке), последний кусок — от начала этого окна.
// Без сегментов — один кусок на уровне конца, как было.
export function tracerPieces(segments, total, endLevel) {
  const end = endLevel || 0;

  if (!(total > 0)) {
    return [{ from: 0, to: 0, level: end }];
  }

  const list = (segments || []).filter(
    segment => segment.t1 > segment.t0 && segment.t0 < total,
  );

  if (list.length === 0) {
    return [{ from: 0, to: total, level: end }];
  }

  const clip = t => Math.min(total, Math.max(0, t));
  const points = [
    ...new Set([0, total, ...list.flatMap(s => [clip(s.t0), clip(s.t1)])]),
  ].sort((a, b) => a - b);
  const pieces = [];

  for (let i = 0; i + 1 < points.length; i += 1) {
    const from = points[i];
    const to = points[i + 1];

    if (to - from < 1e-6) {
      continue;
    }

    const mid = (from + to) / 2;
    let owner = null;

    for (const segment of list) {
      if (
        segment.t0 <= mid &&
        mid < segment.t1 &&
        (owner === null || segment.t0 < owner.t0)
      ) {
        owner = segment;
      }
    }

    // дыра между сегментами — продолжение прежнего уровня
    const level = owner ? owner.level : (pieces.at(-1)?.level ?? end);

    appendPiece(pieces, from, to, level);
  }

  if (pieces.at(-1).level === end) {
    return pieces;
  }

  // конец луча — на уровне окна: последний кусок начинается там, где
  // начался сегмент уровня конца, накрывающий конец
  const window = list
    .filter(s => s.level === end && s.t0 < total && s.t1 >= total - 1e-3)
    .sort((a, b) => b.t0 - a.t0)[0];
  const cut = window ? clip(window.t0) : pieces.at(-1).from;
  const head = [];

  for (const piece of pieces) {
    if (piece.from < cut) {
      appendPiece(head, piece.from, Math.min(piece.to, cut), piece.level);
    }
  }

  appendPiece(head, cut, total, end);

  return head;
}

// добавляет кусок, склеивая его с предыдущим того же уровня
function appendPiece(pieces, from, to, level) {
  if (to - from < 1e-6) {
    return;
  }

  const last = pieces.at(-1);

  if (last && last.level === level && Math.abs(last.to - from) < 1e-6) {
    last.to = to;
  } else {
    pieces.push({ from, to, level });
  }
}
