import { fileURLToPath } from 'node:url';
import { copyAssetDir } from './lib/copyAssetDir.js';

// Копирует уже обработанные звуки игры (npm run audio:process →
// build/sounds — промежуточный каталог, в .gitignore)
// в dist/ игры (dist/sounds/) — ассет под
// GameManifest.assetsBase (GameCatalog мастера). Обработка
// (ffmpeg-нормализация громкости) выполняется один раз в game:build.
// Запуск: npm run audio:process && node scripts/copy-game-sounds.js

const sourceDir = fileURLToPath(new URL('../build/sounds/', import.meta.url));
const targetDir = fileURLToPath(new URL('../dist/sounds/', import.meta.url));

copyAssetDir(sourceDir, [targetDir], {
  label: 'sounds',
  hint: "Run 'npm run audio:process' first.",
});
