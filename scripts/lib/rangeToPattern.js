// Точный regExp-паттерн целочисленного диапазона [min, max] — заменяет
// min/max атрибуты, недоступные у control:'text' (только pattern);
// используется build-game-manifest.js для roomForm-полей (maxPlayers,
// roundTime, mapTime), границы которых берутся из hostDefaults/roomDefaults,
// а не задаются вручную в game.js.

// оборачивает паттерн в незахватывающую группу, если внутри есть
// альтернация ('|') — иначе конкатенация с соседним префиксом/суффиксом
// свяжется только с первой веткой альтернативы (regex-precedence ловушка:
// 'a|b|c' с префиксом '9' матчит '9a' или 'b' или 'c', а не '9a'/'9b'/'9c')
function wrapAlternation(pattern) {
  return pattern.includes('|') ? `(?:${pattern})` : pattern;
}

// [0-9]{n} для n>1, но просто [0-9] для n===1 (артефакт генератора иначе:
// [0-9]{1} эквивалентно, но менее читаемо)
function digitsPattern(len) {
  return len === 1 ? '[0-9]' : `[0-9]{${len}}`;
}

// regExp-паттерн, точно матчащий целые числа в [lo, hi] (lo/hi — строки
// одинаковой длины, lo <= hi, без ведущих нулей) — рекурсивно откусывает
// совпадающий префикс, для расходящейся первой цифры разбивает диапазон на
// "хвост lo-цифры", "полные средние цифры" и "хвост hi-цифры"
function digitGroupPattern(lo, hi) {
  if (lo === hi) {
    return lo;
  }

  if (lo.length === 1) {
    return `[${lo}-${hi}]`;
  }

  if (lo[0] === hi[0]) {
    return lo[0] + wrapAlternation(digitGroupPattern(lo.slice(1), hi.slice(1)));
  }

  const restLen = lo.length - 1;
  const zeros = '0'.repeat(restLen);
  const nines = '9'.repeat(restLen);
  const parts = [lo[0] + wrapAlternation(digitGroupPattern(lo.slice(1), nines))];

  const midLo = Number(lo[0]) + 1;
  const midHi = Number(hi[0]) - 1;

  if (midLo <= midHi) {
    const midDigit = midLo === midHi ? String(midLo) : `[${midLo}-${midHi}]`;
    parts.push(`${midDigit}${digitsPattern(restLen)}`);
  }

  parts.push(hi[0] + wrapAlternation(digitGroupPattern(zeros, hi.slice(1))));

  return parts.join('|');
}

// regExp-паттерн для целого числа в [min, max] (0 <= min <= max), без
// якорей и охватывающей группы — вызывающая сторона использует его как
// значение HTML-атрибута `pattern` (implicitly anchored браузером) или сама
// решает, оборачивать ли в ^(?:...)$ для автономного RegExp
export function rangeToPattern(min, max) {
  if (min > max) {
    throw new Error(`rangeToPattern: min ${min} > max ${max}`);
  }

  const groups = [];
  let lo = min;

  while (lo <= max) {
    const digits = String(lo).length;
    const hi = Math.min(max, 10 ** digits - 1);

    groups.push(digitGroupPattern(String(lo), String(hi)));
    lo = hi + 1;
  }

  return wrapAlternation(groups.join('|'));
}
