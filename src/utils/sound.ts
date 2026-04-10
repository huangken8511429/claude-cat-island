// ── 8-bit Sound Engine for Claude Cat Monitor ──
// All sounds are synthesized via Web Audio API — no audio files needed.

let audioCtx: AudioContext | null = null;
let masterVolume = 0.8;
let muted = false;

async function getCtx(): Promise<AudioContext> {
  if (!audioCtx) {
    audioCtx = new AudioContext();
  }
  if (audioCtx.state === "suspended") {
    await audioCtx.resume();
  }
  return audioCtx;
}

/** Call once on any user click to unlock audio */
export function initAudio() {
  if (!audioCtx) {
    audioCtx = new AudioContext();
  }
  if (audioCtx.state === "suspended") {
    audioCtx.resume();
  }
}

export function setVolume(v: number) {
  masterVolume = Math.max(0, Math.min(1, v));
}

export function getVolume(): number {
  return masterVolume;
}

export function setMuted(m: boolean) {
  muted = m;
}

export function isMuted(): boolean {
  return muted;
}

// ── Helpers ──

function vol(base: number): number {
  return muted ? 0 : base * masterVolume;
}

type OscType = OscillatorType;

async function playNote(
  freq: number,
  duration: number,
  type: OscType = "square",
  gain: number = 0.12,
  startDelay: number = 0,
) {
  const ctx = await getCtx();
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  osc.connect(g);
  g.connect(ctx.destination);
  const t = ctx.currentTime + startDelay;
  g.gain.setValueAtTime(vol(gain), t);
  g.gain.exponentialRampToValueAtTime(0.001, t + duration);
  osc.start(t);
  osc.stop(t + duration);
}

async function playNotes(
  notes: { freq: number; delay: number; duration: number; type?: OscType; gain?: number }[],
) {
  for (const n of notes) {
    await playNote(n.freq, n.duration, n.type ?? "square", n.gain ?? 0.12, n.delay);
  }
}

// ── Sound Events ──

/** 8-bit ascending chime — session/task finished (legacy compatible) */
export async function playDoneChime() {
  const notes = [523, 659, 784, 1047]; // C5 E5 G5 C6
  await playNotes(
    notes.map((freq, i) => ({ freq, delay: i * 0.12, duration: 0.18 })),
  );
}

/** Short blip — alert / permission request (legacy compatible) */
export async function playAlertBlip() {
  await playNote(880, 0.15, "triangle", 0.15);
}

/** Two ascending tones — new session started */
export async function playSessionStart() {
  await playNotes([
    { freq: 440, delay: 0, duration: 0.12, type: "square" },
    { freq: 660, delay: 0.1, duration: 0.15, type: "square" },
  ]);
}

/** Quick triple click — tool executing / typing feel */
export async function playToolTyping() {
  await playNotes([
    { freq: 1200, delay: 0, duration: 0.03, type: "square", gain: 0.06 },
    { freq: 1100, delay: 0.06, duration: 0.03, type: "square", gain: 0.05 },
    { freq: 1300, delay: 0.12, duration: 0.03, type: "square", gain: 0.06 },
  ]);
}

/** Short happy arpeggio — build/compile success */
export async function playCompileSuccess() {
  await playNotes([
    { freq: 660, delay: 0, duration: 0.1 },
    { freq: 880, delay: 0.08, duration: 0.1 },
    { freq: 1100, delay: 0.16, duration: 0.15 },
  ]);
}

/** Descending dissonant — build/compile failure */
export async function playCompileFail() {
  await playNotes([
    { freq: 440, delay: 0, duration: 0.2, type: "sawtooth", gain: 0.1 },
    { freq: 330, delay: 0.15, duration: 0.25, type: "sawtooth", gain: 0.12 },
  ]);
}

/** Low hum rising — context/rate-limit warning */
export async function playContextWarning() {
  const ctx = await getCtx();
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(220, ctx.currentTime);
  osc.frequency.linearRampToValueAtTime(440, ctx.currentTime + 0.4);
  osc.connect(g);
  g.connect(ctx.destination);
  g.gain.setValueAtTime(vol(0.05), ctx.currentTime);
  g.gain.linearRampToValueAtTime(vol(0.12), ctx.currentTime + 0.3);
  g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
  osc.start(ctx.currentTime);
  osc.stop(ctx.currentTime + 0.5);
}

/**
 * Approval urgent blip — pitch and tempo increase with wait time.
 * waitSeconds < 30: normal blip
 * 30-60: higher pitch
 * > 60: highest pitch + double blip
 */
export async function playApprovalUrgent(waitSeconds: number) {
  if (waitSeconds < 30) {
    await playNote(880, 0.15, "triangle", 0.12);
  } else if (waitSeconds < 60) {
    await playNote(1100, 0.12, "triangle", 0.15);
  } else {
    // Double blip, high pitch
    await playNotes([
      { freq: 1320, delay: 0, duration: 0.1, type: "triangle", gain: 0.15 },
      { freq: 1320, delay: 0.12, duration: 0.1, type: "triangle", gain: 0.15 },
    ]);
  }
}

/** Session ended / goodbye — descending two-tone */
export async function playSessionEnd() {
  await playNotes([
    { freq: 660, delay: 0, duration: 0.15, type: "square", gain: 0.1 },
    { freq: 440, delay: 0.12, duration: 0.2, type: "square", gain: 0.08 },
  ]);
}
