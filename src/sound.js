// 아주 간단한 효과음 (WebAudio 오실레이터 — 에셋 파일 없음).
// AudioContext는 사용자 제스처(클릭/엔터) 뒤에 깨어나므로 ensureAudio를 그때 호출.

let ctx = null;

export function ensureAudio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) ctx = new AC();
  }
  if (ctx && ctx.state === "suspended") ctx.resume();
}

function beep(freq, dur, type, gain) {
  if (!ctx) return;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.value = freq;
  o.connect(g); g.connect(ctx.destination);
  const t = ctx.currentTime;
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.start(t); o.stop(t + dur + 0.02);
}

export const sfx = {
  attack:  () => beep(680, 0.07, "square", 0.05),
  defense: () => beep(440, 0.09, "triangle", 0.05),
  move:    () => beep(300, 0.08, "sine", 0.05),
  hit:     () => beep(150, 0.16, "sawtooth", 0.07),
  enemy:   () => beep(240, 0.07, "square", 0.04),
  down:    () => beep(520, 0.20, "triangle", 0.06),
  miss:    () => beep(200, 0.05, "sine", 0.03),
};
