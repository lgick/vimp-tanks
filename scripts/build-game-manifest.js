import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ENGINE_API_VERSION } from 'vimp-engine/config/opcodes.js';
import hostDefaults from 'vimp-engine/config/hostDefaults.js';
import gameConfig from '../src/config/game.js';
import { rangeToPattern } from './lib/rangeToPattern.js';
import {
  collectRequiredImages,
  collectMissingImages,
} from './lib/collectMissingImages.js';

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

// node-сборка ядра (core:build:node) для headless-прогонов движка
// (`vimp-sim`): в отличие от остальных entries это путь на диске
// относительно манифеста, а не URL. Поле опционально — без pkg-node
// собранный плагин остаётся валидным, просто не прогоняется headless.
//
// Глюe копируется внутрь dist/: core/pkg-node/ лежит в .gitignore, а npm
// применяет ignore-правила и к каталогам, добавленным через files, — в
// опубликованном 0.4.0 манифест объявлял wasmNode, которого в тарболе не
// было, и vimp-sim падал сырым ERR_MODULE_NOT_FOUND.
const NODE_CORE_SRC = fileURLToPath(new URL('../core/pkg-node/', import.meta.url));
const NODE_CORE_DIR = 'core-node';
const NODE_CORE_ENTRY = `./${NODE_CORE_DIR}/vimp_tanks_core.js`;

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
const maps = [];

for (const name of mapNames) {
  const raw = fs.readFileSync(path.join(mapsPath, `${name}.json`));

  mapsHash.update(name).update(raw);
  maps.push(JSON.parse(raw));
}

// гейт картинок: сама логика в scripts/lib/collectMissingImages.js (чистая,
// под тестом), здесь только проверка на диске
const requiredImages = collectRequiredImages(maps);
const missingImages = collectMissingImages(requiredImages, file =>
  fs.existsSync(path.join(distPath, 'img', file)),
);

if (missingImages.length) {
  throw new Error(
    `maps reference image(s) missing from dist/img/: ${missingImages.join(', ')} — ` +
      'add them to assets/img/ and run `npm run build:assets`',
  );
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

const hasNodeCore = fs.existsSync(NODE_CORE_SRC);

if (hasNodeCore) {
  fs.rmSync(path.join(distPath, NODE_CORE_DIR), {
    recursive: true,
    force: true,
  });

  fs.cpSync(NODE_CORE_SRC, path.join(distPath, NODE_CORE_DIR), {
    recursive: true,
    // wasm-pack кладёт рядом свой `.gitignore` с `*`, а npm применяет
    // ignore-файлы и внутри dist — с ним каталог снова не доехал бы до
    // тарбола. package.json остаётся: без него Node прочтёт CommonJS-глюe
    // как ESM (в корне пакета "type": "module").
    filter: src => path.basename(src) !== '.gitignore',
  });
}

const manifest = {
  id: 'tanks',
  engineApi: ENGINE_API_VERSION,
  version,
  title: 'VIMP Tanks',
  entries: {
    client: `/games/tanks/${clientFile}`,
    host: `/games/tanks/${hostFile}`,
    wasm: `/games/tanks/assets/${wasmFile}`,
    ...(hasNodeCore ? { wasmNode: NODE_CORE_ENTRY } : {}),
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
console.log(`  images: ${requiredImages.join(', ')}`);

if (hasNodeCore) {
  console.log(`  wasmNode: ${NODE_CORE_ENTRY}`);
} else {
  console.warn(
    `  wasmNode: пропущен (нет ${NODE_CORE_SRC}) — headless-прогон ` +
      'потребует `npm run core:build:node` или флага --core',
  );
}
