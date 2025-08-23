import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';

const execPromise = promisify(exec);

const sourceDir = 'src/assets/audio-raw';
const outputDir = 'public/sounds';

const AUDIO_EXTENSIONS = ['.wav', '.mp3', '.flac', '.aiff', '.ogg', '.m4a'];

// параметры громкости (EBU R128)
const LOUDNESS = {
  // I (Integrated Loudness): Целевая интегральная громкость
  // -16 LUFS - хороший баланс для игр и веб-контента
  I: -16,

  // LRA (Loudness Range): Динамический диапазон громкости
  // 7 LU - умеренный диапазон,
  // который сохраняет разницу между тихими и громкими звуками
  LRA: 7, // динамический диапазон

  // TP (True Peak): Максимальный истинный пик
  // -1.5 dBTP - безопасный предел, чтобы избежать искажений (клиппинга)
  TP: -1.5,
};

// параметры обрезки тишины в начале файла
const SILENCE_THRESHOLD = '-50dB';

// параметры кодирования
const CODEC_SETTINGS = {
  MP3_QUALITY: '2', // VBR ~190kbps
  WEBM_BITRATE: '96k', // битрейт Opus
};

// проверка установки ffmpeg
async function isFfmpegInstalled() {
  try {
    await execPromise('ffmpeg -version');
    return true;
  } catch (error) {
    return false;
  }
}

// главная функция обработки
async function main() {
  console.log('--- Starting Audio Processing ---');

  // проверка окружения
  if (!(await isFfmpegInstalled())) {
    console.error('Error: ffmpeg is not installed.');
    process.exit(1);
  }

  try {
    await fs.access(sourceDir);
  } catch (error) {
    console.error(`Error: Source directory '${sourceDir}' not found.`);
    process.exit(1);
  }

  await fs.mkdir(outputDir, { recursive: true });
  console.log(`> Output directory: ${outputDir}`);

  // поиск и фильтрация файлов
  const sourceFiles = await fs.readdir(sourceDir);

  // обработка файлов
  for (const file of sourceFiles) {
    const extension = path.extname(file).toLowerCase();

    if (!AUDIO_EXTENSIONS.includes(extension)) {
      continue;
    }

    const sourcePath = path.join(sourceDir, file);
    const fileNameWithoutExt = path.basename(file, extension);
    const outputMp3 = path.join(outputDir, `${fileNameWithoutExt}.mp3`);
    const outputWebm = path.join(outputDir, `${fileNameWithoutExt}.webm`);

    console.log(`\n▶️  Processing: ${file}`);

    // сборка цепочки аудиофильтров
    const audioFilters = [
      `silenceremove=start_periods=1:start_threshold=${SILENCE_THRESHOLD}`,
      `loudnorm=I=${LOUDNESS.I}:LRA=${LOUDNESS.LRA}:tp=${LOUDNESS.TP}`,
    ].join(',');

    const command = [
      'ffmpeg',
      '-nostdin', // запретить ввод с клавиатуры
      `-i "${sourcePath}"`, // входной файл
      '-hide_banner -loglevel error -y', // меньше вывода в консоль
      `-af "${audioFilters}"`, // аудио фильтры
      // MP3
      `-c:a libmp3lame -q:a ${CODEC_SETTINGS.MP3_QUALITY} "${outputMp3}"`,
      // WebM
      `-c:a libopus -b:a ${CODEC_SETTINGS.WEBM_BITRATE} "${outputWebm}"`,
    ].join(' ');

    try {
      await execPromise(command);
      console.log(`✅  Done: ${outputMp3}, ${outputWebm}`);
    } catch (error) {
      console.error(`❌  Error processing: ${file}`);
      console.error(error.stderr);
    }
  }

  console.log('\n🎉 All files processed successfully!');
}

main().catch(err => {
  console.error('\nCritical script error:', err);
  process.exit(1);
});
