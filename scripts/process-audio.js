import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import soundsConfig from '../src/config/sounds.js';

const execPromise = promisify(exec);

const sourceDir = 'assets/audio-raw';
const outputDir = 'build/sounds';

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

// имена файлов (без расширения) зацикленных звуков: их берём из каталога
// игры, чтобы пайплайн и конфиг не разъезжались
const LOOPED_FILES = new Set(
  Object.values(soundsConfig.sounds)
    .filter(sound => sound.loop)
    .map(sound => sound.file),
);

// параметры кодирования
const CODEC_SETTINGS = {
  MP3_QUALITY: '2', // VBR ~190kbps
  WEBM_BITRATE: '96k', // битрейт Opus
  // faithfulness to the input (дефолт ffmpeg, указан явно: voip/lowdelay
  // испортили бы низ петли двигателя)
  OPUS_APPLICATION: 'audio',
};

// цепочка фильтров для одного выхода.
//
// `silenceremove` зацикленному сэмплу противопоказан: он режет по порогу, а
// не по нулю формы волны, и подвинутое начало петли даёт щелчок на каждом
// обороте.
//
// `loudnorm` в один проход работает ДИНАМИЧЕСКИ — усиление плывёт по ходу
// файла. На петле длиной в полсекунды это слышно как неровный, «гуляющий»
// холостой ход и как разрыв на стыке оборота, поэтому зацикленные звуки
// идут вторым проходом с измеренными значениями (`linear=true` — одно
// постоянное усиление на весь файл).
function buildFilters(loop, measured) {
  const chain = [];

  if (!loop) {
    chain.push(
      `silenceremove=start_periods=1:start_threshold=${SILENCE_THRESHOLD}`,
    );
  }

  const loudnorm = [
    `loudnorm=I=${LOUDNESS.I}`,
    `LRA=${LOUDNESS.LRA}`,
    `tp=${LOUDNESS.TP}`,
  ];

  if (measured) {
    loudnorm.push(
      `measured_I=${measured.input_i}`,
      `measured_LRA=${measured.input_lra}`,
      `measured_tp=${measured.input_tp}`,
      `measured_thresh=${measured.input_thresh}`,
      `offset=${measured.target_offset}`,
      'linear=true',
    );
  }

  chain.push(loudnorm.join(':'));

  return chain.join(',');
}

// первый проход loudnorm: замер громкости исходника
async function measureLoudness(sourcePath) {
  const { stderr } = await execPromise(
    `ffmpeg -nostdin -hide_banner -i "${sourcePath}" ` +
      `-af "${buildFilters(true, null)}:print_format=json" -f null -`,
    { maxBuffer: 32 * 1024 * 1024 },
  );

  // сводка печатается в stderr последним JSON-объектом
  const start = stderr.lastIndexOf('{');
  const end = stderr.lastIndexOf('}');

  if (start === -1 || end === -1) {
    return null;
  }

  try {
    return JSON.parse(stderr.slice(start, end + 1));
  } catch (error) {
    return null;
  }
}

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

    const loop = LOOPED_FILES.has(fileNameWithoutExt);

    console.log(`\n▶️  Processing: ${file}${loop ? ' (loop)' : ''}`);

    // зацикленному звуку нужен второй проход: усиление обязано быть
    // постоянным на всём файле
    const measured = loop ? await measureLoudness(sourcePath) : null;

    if (loop && !measured) {
      console.warn('⚠️   loudnorm measurement failed, falling back to one pass');
    }

    const audioFilters = buildFilters(loop, measured);

    // -af — опция ВЫХОДА: указанная один раз, она действует только на
    // следующий за ней файл. Раньше фильтровался лишь mp3, а webm — тот
    // самый кодек, который выбирают Chrome, Firefox и Edge, — шёл сырым
    // (разброс интегральной громкости доходил до 11 LU)
    const command = [
      'ffmpeg',
      '-nostdin', // запретить ввод с клавиатуры
      `-i "${sourcePath}"`, // входной файл
      '-hide_banner -loglevel error -y', // меньше вывода в консоль
      // MP3
      `-af "${audioFilters}"`,
      `-c:a libmp3lame -q:a ${CODEC_SETTINGS.MP3_QUALITY} "${outputMp3}"`,
      // WebM
      `-af "${audioFilters}"`,
      `-c:a libopus -b:a ${CODEC_SETTINGS.WEBM_BITRATE}`,
      `-application ${CODEC_SETTINGS.OPUS_APPLICATION} "${outputWebm}"`,
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
