import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// Копирует уже обработанные звуки игры (npm run audio:process →
// build/sounds — промежуточный каталог, в .gitignore)
// в dist/ игры (dist/sounds/) — ассет под
// GameManifest.assetsBase (GameCatalog мастера). Обработка
// (ffmpeg-нормализация громкости) выполняется один раз в game:build.
// Запуск: npm run audio:process && node scripts/copy-game-sounds.js

const sourceDir = fileURLToPath(
  new URL('../build/sounds/', import.meta.url),
);
const targetDir = fileURLToPath(
  new URL('../dist/sounds/', import.meta.url),
);

if (!fs.existsSync(sourceDir)) {
  console.error(
    `Error: '${sourceDir}' not found. Run 'npm run audio:process' first.`,
  );
  process.exit(1);
}

fs.rmSync(targetDir, { recursive: true, force: true });
fs.cpSync(sourceDir, targetDir, { recursive: true });

console.log(`copied sounds: ${sourceDir} -> ${targetDir}`);
