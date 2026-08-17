import { execFileSync } from 'node:child_process';

// Страховка публикации: манифест объявляет entries.wasmNode, значит node-глюe
// обязан физически быть в тарболе. Опубликованный 0.4.0 объявлял поле, но
// файла не вёз (`core/pkg-node/` в .gitignore, а npm применяет ignore-правила
// и внутри каталогов из `files`) — vimp-sim у пользователя падал сырым
// ERR_MODULE_NOT_FOUND. Регрессия обязана валить publish, а не прогон игрока.

// Тайлы карт — та же история: assets/img/ копируется в dist/img/ скриптом
// copy-game-images.js, а dist/ целиком в .gitignore. Без картинок карта у
// игрока отрисуется пустым полотном без единой ошибки в консоли движка.
const REQUIRED = [
  /^dist\/manifest\.json$/,
  /^dist\/core-node\/vimp_tanks_core\.js$/,
  /^dist\/core-node\/vimp_tanks_core_bg\.wasm$/,
  /^dist\/img\/tiles\.png$/,
  /^dist\/img\/tiles3\.png$/,
  /^dist\/img\/b1\.png$/,
];

// --ignore-scripts обязателен: сам скрипт висит на prepack, а npm pack
// прогоняет lifecycle и в dry-run — иначе получилась бы рекурсия
const output = execFileSync(
  'npm',
  ['pack', '--dry-run', '--json', '--ignore-scripts'],
  { encoding: 'utf8' },
);
const files = JSON.parse(output)[0].files.map(file => file.path);
const missing = REQUIRED.filter(pattern => !files.some(f => pattern.test(f)));

if (missing.length) {
  throw new Error(
    `the tarball is missing ${missing.map(String).join(', ')} — ` +
      'run `npm run core:build:node && npm run build` before publishing',
  );
}

console.log(
  `pack check: ${files.length} files, node core and map images included`,
);
