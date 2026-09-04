// Уклон под танком, восстановленный клиентом из кадров: схема `m1` его не
// везёт (решение 4 мастер-плана — кадр не меняем), а визуалу подъёма он
// нужен и в `Tank` (ракурс корпуса), и в `Smoke` (пыль из-под гусениц).
//
// grade = dz / ds — продольная составляющая крутизны под курсом танка,
// сглаженная экспоненциально: разностная производная по двум кадрам
// дрожит, а дрожащий эффект хуже отсутствующего.

// сглаживание: доля нового значения за кадр
const SMOOTHING = 0.2;

// ниже этого сдвига за кадр считаем, что танк стоит: деление на ~0 дало бы
// произвольный уклон у неподвижной машины
const MIN_STEP = 0.01;

export function createGradeTracker() {
  let grade = 0;
  let hasPrev = false;
  let prevX = 0;
  let prevY = 0;
  let prevZ = 0;

  return {
    update(x, y, z) {
      if (!hasPrev) {
        hasPrev = true;
        prevX = x;
        prevY = y;
        prevZ = z;

        return grade;
      }

      const dx = x - prevX;
      const dy = y - prevY;
      const ds = Math.sqrt(dx * dx + dy * dy);
      const raw = ds > MIN_STEP ? (z - prevZ) / ds : 0;

      prevX = x;
      prevY = y;
      prevZ = z;
      grade += (raw - grade) * SMOOTHING;

      return grade;
    },

    get value() {
      return grade;
    },
  };
}
