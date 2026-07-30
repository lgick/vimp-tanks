import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ENGINE_API_VERSION } from 'vimp-engine/config/opcodes.js';
import hostDefaults from 'vimp-engine/config/hostDefaults.js';
import gameConfig from '../src/config/game.js';

// Генерация GameManifest (docs/{en,ru}/plugin-api.md) после сборки
// client/host-бандлов игры (vite.config.js, уже хеширует имена
// entry-файлов и общий .wasm-ассет) и постшагов maps:export/copy-game-sounds.
// Запуск (в порядке зависимостей) — см. package.json "build".

const distDir = new URL('../dist/', import.meta.url);
const distPath = fileURLToPath(distDir);
const assetsPath = path.join(distPath, 'assets');
const mapsPath = path.join(distPath, 'maps');

function hashFile(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function findOne(dir, pattern) {
  const files = fs.readdirSync(dir).filter(name => pattern.test(name));

  if (files.length !== 1) {
    throw new Error(
      `expected exactly one file matching ${pattern} in ${dir}, found: ${files.join(', ') || 'none'}`,
    );
  }

  return files[0];
}

// оборачивает паттерн в незахватывающую группу, если внутри есть
// альтернация ('|') — иначе конкатенация с соседним префиксом/суффиксом
// свяжется только с первой веткой альтернативы (regex-precedence ловушка:
// 'a|b|c' с префиксом '9' матчит '9a' или 'b' или 'c', а не '9a'/'9b'/'9c')
function wrapAlternation(pattern) {
  return pattern.includes('|') ? `(?:${pattern})` : pattern;
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
    parts.push(`${midDigit}[0-9]{${restLen}}`);
  }

  parts.push(hi[0] + wrapAlternation(digitGroupPattern(zeros, hi.slice(1))));

  return parts.join('|');
}

// regExp-паттерн для целого числа в [min, max] (0 <= min <= max) — точная
// граница вместо "число цифр" (digit-count давал бы 9999 в диапазоне
// 10-3600); используется вместо min/max атрибутов текстовых полей формы
// (control:'text' их не поддерживает — только pattern)
function rangeToPattern(min, max) {
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

  return `^(${groups.join('|')})$`;
}

const clientFile = findOne(distPath, /^client-.+\.js$/);
const hostFile = findOne(distPath, /^host-.+\.js$/);
const wasmFile = findOne(assetsPath, /\.wasm$/);

const version = createHash('sha256')
  .update(hashFile(path.join(distPath, clientFile)))
  .update(hashFile(path.join(distPath, hostFile)))
  .update(hashFile(path.join(assetsPath, wasmFile)))
  .digest('hex')
  .slice(0, 16);

const mapNames = fs
  .readdirSync(mapsPath)
  .filter(name => name.endsWith('.json'))
  .map(name => name.slice(0, -'.json'.length))
  .sort();

const mapsHash = createHash('sha256');

for (const name of mapNames) {
  mapsHash.update(name).update(fs.readFileSync(path.join(mapsPath, `${name}.json`)));
}

// значения по каждому ключу roomForm; единственный источник имён — сам
// roomForm (game.js), это защищает roomDefaults от рассинхрона с ним
const roomValues = {
  maxPlayers: gameConfig.roomDefaults.maxPlayers,
  roundTime: hostDefaults.timers.roundTime,
  mapTime: hostDefaults.timers.mapTime,
  friendlyFire: gameConfig.parts.friendlyFire,
  map: gameConfig.currentMap,
};

// границы полей формы (regExp — движок v3 больше не знает min/max у текстовых
// полей): те же числа, что клампует applyRoomOverrides.js, а не независимая
// копия. UX-подсказка, не авторитетная граница — сама граница накладывается
// хостом при создании комнаты
const { roomTimeMin, roomTimeMax } = hostDefaults.timers;
const roomTimeRegExp = rangeToPattern(roomTimeMin / 1000, roomTimeMax / 1000);
const maxPlayersRegExp = rangeToPattern(1, gameConfig.roomDefaults.maxPlayers);

const fieldRegExp = {
  maxPlayers: maxPlayersRegExp,
  roundTime: roomTimeRegExp,
  mapTime: roomTimeRegExp,
};

const roomForm = gameConfig.roomForm.map(field =>
  field.name in fieldRegExp ? { ...field, regExp: fieldRegExp[field.name] } : field,
);

const manifest = {
  id: 'tanks',
  engineApi: ENGINE_API_VERSION,
  version,
  title: 'VIMP Tanks',
  entries: {
    client: `/games/tanks/${clientFile}`,
    host: `/games/tanks/${hostFile}`,
    wasm: `/games/tanks/assets/${wasmFile}`,
  },
  assetsBase: '/games/tanks/',
  maps: {
    version: mapsHash.digest('hex').slice(0, 16),
    list: mapNames,
  },
  roomDefaults: Object.fromEntries(
    roomForm.map(({ name }) => {
      if (!(name in roomValues)) {
        throw new Error(`roomForm field "${name}" has no value source`);
      }

      return [name, roomValues[name]];
    }),
  ),
  roomForm,
};

fs.writeFileSync(
  path.join(distPath, 'manifest.json'),
  JSON.stringify(manifest, null, 2),
);

console.log(`manifest written: ${path.join(distPath, 'manifest.json')}`);
console.log(`  version: ${version}`);
console.log(`  maps: ${mapNames.join(', ')}`);
