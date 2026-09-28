// Таймлайн пожара остова (src/client/parts/WreckFire.js): чистые функции
// времени с момента гибели, мс

// сила пламени: 1 всё `fire.duration`, затем линейно до 0 за `fire.fadeOut`
// (`fadeOut` 0 — гаснет сразу)
export function fireIntensity(elapsed, fire) {
  if (elapsed <= fire.duration) {
    return 1;
  }

  if (!(fire.fadeOut > 0)) {
    return 0;
  }

  return Math.max(0, 1 - (elapsed - fire.duration) / fire.fadeOut);
}

// конец пожара, мс
export function fireEnd(fire) {
  return fire.duration + fire.fadeOut;
}

// частота дыма, частиц/с: пока горит — от `tailRate` до `rate` по силе
// пламени; после — от `tailRate` линейно до 0 за `smoke.tail`
export function smokeRate(elapsed, fire, smoke) {
  const end = fireEnd(fire);

  if (elapsed < end) {
    const intensity = fireIntensity(elapsed, fire);
    return smoke.tailRate + (smoke.rate - smoke.tailRate) * intensity;
  }

  if (!(smoke.tail > 0)) {
    return 0;
  }

  return smoke.tailRate * Math.max(0, 1 - (elapsed - end) / smoke.tail);
}

// когда перестаёт рождаться последняя частица
export function emissionEnd(fire, smoke) {
  return fireEnd(fire) + smoke.tail;
}

// прозрачность клуба дыма по доле жизни t: проявление за первые 12 %,
// плато, угасание с 45 % до конца (форма SmokeEffect)
export function smokeAlpha(t, peak) {
  if (t <= 0 || t >= 1) {
    return 0;
  }

  if (t < 0.12) {
    return peak * (t / 0.12);
  }

  if (t <= 0.45) {
    return peak;
  }

  return peak * (1 - (t - 0.45) / 0.55);
}
