// Прогоны рамп по гриду уровня для КАРТИНКИ клина.
//
// Обход тот же, что у ядра движка (`MapLevels::build_runs`,
// packages/engine/core/src/map.rs): максимальная непрерывная линия
// одинаковых тайлов вдоль оси рампы в одной строке (ось x) или колонке
// (ось y). Клетка достаётся первой объявленной рампе.
//
// НО с одним намеренным расхождением: полосы одной широкой горки здесь
// СКЛЕИВАЮТСЯ в один прогон. Ядру полосы нужны раздельными (вердикт гейта
// судится на полосу, `core/src/level.rs`), а клину — нет: между полосами
// нет ни стенки, ни ступеньки, и юбки на их границах нарисовали бы
// перегородки, которых в физике не существует. Кроме ШИРИНЫ прогона эти
// два представления разъезжаться не должны ни в чём.
//
// Движок кладёт парту конфиги рамп этого уровня как они объявлены в карте
// (`{ tile, dir, from, to }`, решение 5 этапа 2), а грид уровня у парта уже
// есть — поэтому прогоны для клина строятся здесь, а не едут по сети.

// ось (0 = x, 1 = y) и знак «в горку» по направлению рампы — те же пары,
// что в `RampDir::axis_sign`
const DIRS = {
  north: { axis: 1, sign: -1 },
  south: { axis: 1, sign: 1 },
  west: { axis: 0, sign: -1 },
  east: { axis: 0, sign: 1 },
};

// Возвращает прогоны в КЛЕТКАХ: `col0..col1` и `row0..row1` — полуинтервалы,
// `sign` — направление подъёма вдоль оси, `rise` — перепад в уровнях.
export function buildRampRuns(map, ramps) {
  const runs = [];

  if (!Array.isArray(map) || !map.length || !Array.isArray(ramps)) {
    return runs;
  }

  const rows = map.length;
  const cols = map.reduce((max, row) => Math.max(max, row.length), 0);
  // клетки, уже занятые прогоном: первая объявленная рампа выигрывает —
  // детерминированно, как в ядре
  const claimed = map.map(row => new Array(row.length).fill(false));

  const push = (axis, sign, rise, col0, col1, row0, row1) => {
    let taken = false;

    for (let row = row0; row < row1; row += 1) {
      for (let col = col0; col < col1; col += 1) {
        if (claimed[row]?.[col] === false) {
          claimed[row][col] = true;
          taken = true;
        }
      }
    }

    if (taken) {
      runs.push({ axis, sign, rise, col0, col1, row0, row1 });
    }
  };

  for (const ramp of ramps) {
    const dir = DIRS[ramp?.dir];

    if (!dir) {
      continue;
    }

    const rise = (Number(ramp.to) || 0) - (Number(ramp.from) || 0);

    if (rise <= 0) {
      continue;
    }

    if (dir.axis === 1) {
      for (let col = 0; col < cols; col += 1) {
        let row = 0;

        while (row < rows) {
          if (map[row][col] !== ramp.tile) {
            row += 1;
            continue;
          }

          const row0 = row;

          while (row < rows && map[row][col] === ramp.tile) {
            row += 1;
          }

          push(dir.axis, dir.sign, rise, col, col + 1, row0, row);
        }
      }
    } else {
      for (let row = 0; row < rows; row += 1) {
        const line = map[row];
        let col = 0;

        while (col < line.length) {
          if (line[col] !== ramp.tile) {
            col += 1;
            continue;
          }

          const col0 = col;

          while (col < line.length && line[col] === ramp.tile) {
            col += 1;
          }

          push(dir.axis, dir.sign, rise, col0, col, row, row + 1);
        }
      }
    }
  }

  return mergeLanes(runs);
}

// Склейка полос одной широкой горки: прогоны с одинаковыми осью, знаком,
// перепадом и интервалом ВДОЛЬ оси, лежащие вплотную поперёк неё,
// становятся одним прогоном во всю ширину блока. Полосы разной ДЛИНЫ
// (ступенчатый край блока) остаются разными прогонами — ровно тот же
// признак «одна горка», что у `is_lane_change` в ядре.
function mergeLanes(runs) {
  const groups = new Map();

  for (const run of runs) {
    const along =
      run.axis === 1
        ? `${run.row0}:${run.row1}`
        : `${run.col0}:${run.col1}`;
    const key = `${run.axis}|${run.sign}|${run.rise}|${along}`;
    const group = groups.get(key);

    if (group) {
      group.push(run);
    } else {
      groups.set(key, [run]);
    }
  }

  const merged = [];

  for (const group of groups.values()) {
    // поперечная координата: колонка при оси y, строка при оси x
    const cross0 = run => (run.axis === 1 ? run.col0 : run.row0);
    const cross1 = run => (run.axis === 1 ? run.col1 : run.row1);

    group.sort((a, b) => cross0(a) - cross0(b));

    let current = null;

    for (const run of group) {
      if (current && cross0(run) === cross1(current)) {
        if (current.axis === 1) {
          current.col1 = run.col1;
        } else {
          current.row1 = run.row1;
        }

        continue;
      }

      current = { ...run };
      merged.push(current);
    }
  }

  return merged;
}
