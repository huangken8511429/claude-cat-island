import { useEffect, useRef, useMemo } from "react";
import { CatState, ProviderKind } from "../types";

interface CatLogoProps {
  state?: CatState;
  size?: number;
  themeIndex?: number;
  provider?: ProviderKind;
  className?: string;
}

/*
  12x12 pixel cat head logo — inspired by Kai Pixel Art cat heads.
  Zones: 0=transparent 1=outline 2=body 3=ear-inner 4=eye 5=nose 6=highlight 7=mouth 8=cheek
*/
const [_, O, B, E, Y, N, H, M, K] = [0, 1, 2, 3, 4, 5, 6, 7, 8];

// ── Normal face (idle) ──
const FACE_IDLE: number[][] = [
  [_,O,O,_,_,_,_,_,_,O,O,_],
  [O,E,B,O,_,_,_,_,O,B,E,O],
  [O,B,B,B,O,O,O,O,B,B,B,O],
  [O,B,B,B,B,B,B,B,B,B,B,O],
  [O,B,Y,H,B,B,B,B,Y,H,B,O],
  [O,B,B,B,B,B,B,B,B,B,B,O],
  [O,B,B,K,B,N,N,B,K,B,B,O],
  [O,B,B,B,B,M,M,B,B,B,B,O],
  [_,O,B,B,B,B,B,B,B,B,O,_],
  [_,_,O,O,O,O,O,O,O,O,_,_],
];

// ── Working face: looking down at keyboard, left paw tap ──
const FACE_WORK_TAP_L: number[][] = [
  [_,O,O,_,_,_,_,_,_,O,O,_],
  [O,E,B,O,_,_,_,_,O,B,E,O],
  [O,B,B,B,O,O,O,O,B,B,B,O],
  [O,B,B,B,B,B,B,B,B,B,B,O],
  [O,B,B,B,B,B,B,B,B,B,B,O],
  [O,B,Y,H,B,B,B,B,Y,H,B,O],  // eyes lower (looking down)
  [O,B,B,K,B,N,N,B,K,B,B,O],
  [O,B,B,B,B,B,B,B,B,B,B,O],
  [_,O,B,K,K,B,B,B,B,B,O,_],  // left paw tap
  [_,_,O,O,O,O,O,O,O,O,_,_],
];

// ── Working face: looking down at keyboard, right paw tap ──
const FACE_WORK_TAP_R: number[][] = [
  [_,O,O,_,_,_,_,_,_,O,O,_],
  [O,E,B,O,_,_,_,_,O,B,E,O],
  [O,B,B,B,O,O,O,O,B,B,B,O],
  [O,B,B,B,B,B,B,B,B,B,B,O],
  [O,B,B,B,B,B,B,B,B,B,B,O],
  [O,B,Y,H,B,B,B,B,Y,H,B,O],  // eyes lower (looking down)
  [O,B,B,K,B,N,N,B,K,B,B,O],
  [O,B,B,B,B,B,B,B,B,B,B,O],
  [_,O,B,B,B,B,B,K,K,B,O,_],  // right paw tap
  [_,_,O,O,O,O,O,O,O,O,_,_],
];

// ── Working face: both paws resting ──
const FACE_WORK_REST: number[][] = [
  [_,O,O,_,_,_,_,_,_,O,O,_],
  [O,E,B,O,_,_,_,_,O,B,E,O],
  [O,B,B,B,O,O,O,O,B,B,B,O],
  [O,B,B,B,B,B,B,B,B,B,B,O],
  [O,B,B,B,B,B,B,B,B,B,B,O],
  [O,B,Y,H,B,B,B,B,Y,H,B,O],  // eyes lower
  [O,B,B,K,B,N,N,B,K,B,B,O],
  [O,B,B,B,B,B,B,B,B,B,B,O],
  [_,O,B,K,B,B,B,B,K,B,O,_],  // both paws resting
  [_,_,O,O,O,O,O,O,O,O,_,_],
];

// ── Working face: blink while typing ──
const FACE_WORKING_BLINK: number[][] = [
  [_,O,O,_,_,_,_,_,_,O,O,_],
  [O,E,B,O,_,_,_,_,O,B,E,O],
  [O,B,B,B,O,O,O,O,B,B,B,O],
  [O,B,B,B,B,B,B,B,B,B,B,O],
  [O,B,B,B,B,B,B,B,B,B,B,O],
  [O,B,Y,Y,B,B,B,B,Y,Y,B,O],  // blink
  [O,B,B,K,B,N,N,B,K,B,B,O],
  [O,B,B,B,B,B,B,B,B,B,B,O],
  [_,O,B,K,K,B,B,B,B,B,O,_],  // left paw mid-tap
  [_,_,O,O,O,O,O,O,O,O,_,_],
];

// ── Sleeping face (curved closed eyes −‿−, peaceful mouth) ──
const FACE_SLEEPING: number[][] = [
  [_,O,O,_,_,_,_,_,_,O,O,_],
  [O,E,B,O,_,_,_,_,O,B,E,O],
  [O,B,B,B,O,O,O,O,B,B,B,O],
  [O,B,B,B,B,B,B,B,B,B,B,O],
  [O,B,Y,B,Y,B,B,Y,B,Y,B,O],  // curved closed eyes ‿ shape
  [O,B,B,Y,B,B,B,B,Y,B,B,O],  // bottom of curve
  [O,B,B,K,B,N,N,B,K,B,B,O],
  [O,B,B,B,M,B,B,M,B,B,B,O],  // small peaceful smile
  [_,O,B,B,B,B,B,B,B,B,O,_],
  [_,_,O,O,O,O,O,O,O,O,_,_],
];

// ── Done face (happy ^_^ eyes) ──
const FACE_DONE: number[][] = [
  [_,O,O,_,_,_,_,_,_,O,O,_],
  [O,E,B,O,_,_,_,_,O,B,E,O],
  [O,B,B,B,O,O,O,O,B,B,B,O],
  [O,B,B,B,B,B,B,B,B,B,B,O],
  [O,B,Y,B,B,B,B,B,Y,B,B,O],
  [O,B,B,Y,B,B,B,B,B,Y,B,O],
  [O,B,B,K,B,N,N,B,K,B,B,O],
  [O,B,B,B,M,B,B,M,B,B,B,O],
  [_,O,B,B,B,M,M,B,B,B,O,_],
  [_,_,O,O,O,O,O,O,O,O,_,_],
];

// ── Scared face (wide eyes, open mouth — compile failure) ──
const FACE_SCARED: number[][] = [
  [_,O,O,_,_,_,_,_,_,O,O,_],
  [O,E,B,O,_,_,_,_,O,B,E,O],
  [O,B,B,B,O,O,O,O,B,B,B,O],
  [O,B,B,B,B,B,B,B,B,B,B,O],
  [O,Y,Y,H,B,B,B,Y,Y,H,B,O],  // big wide eyes
  [O,Y,Y,B,B,B,B,Y,Y,B,B,O],  // eyes extend down
  [O,B,B,B,B,N,N,B,B,B,B,O],  // no cheeks — too shocked
  [O,B,B,B,M,B,B,M,B,B,B,O],  // open O-mouth
  [_,O,B,B,B,M,M,B,B,B,O,_],
  [_,_,O,O,O,O,O,O,O,O,_,_],
];

const FACE_SCARED_ALT: number[][] = [
  [_,O,O,_,_,_,_,_,_,O,O,_],
  [O,E,B,O,_,_,_,_,O,B,E,O],
  [O,B,B,B,O,O,O,O,B,B,B,O],
  [O,B,B,B,B,B,B,B,B,B,B,O],
  [O,B,Y,Y,H,B,B,B,Y,Y,H,O],  // eyes shifted right (trembling)
  [O,B,Y,Y,B,B,B,B,Y,Y,B,O],
  [O,B,B,B,B,N,N,B,B,B,B,O],
  [O,B,B,M,M,B,B,M,M,B,B,O],  // wider O-mouth
  [_,O,B,B,B,M,M,B,B,B,O,_],
  [_,_,O,O,O,O,O,O,O,O,_,_],
];

// ── Yawning face (squinty eyes, big open mouth — long idle) ──
const FACE_YAWN_OPEN: number[][] = [
  [_,O,O,_,_,_,_,_,_,O,O,_],
  [O,E,B,O,_,_,_,_,O,B,E,O],
  [O,B,B,B,O,O,O,O,B,B,B,O],
  [O,B,B,B,B,B,B,B,B,B,B,O],
  [O,B,B,B,B,B,B,B,B,B,B,O],  // space above squinty eyes
  [O,B,Y,Y,B,B,B,B,Y,Y,B,O],  // squinty closed eyes
  [O,B,B,K,M,M,M,M,K,B,B,O],  // mouth starts wide
  [O,B,B,B,M,M,M,M,B,B,B,O],  // big yawn mouth
  [_,O,B,B,B,M,M,B,B,B,O,_],
  [_,_,O,O,O,O,O,O,O,O,_,_],
];

const FACE_YAWN_CLOSE: number[][] = [
  [_,O,O,_,_,_,_,_,_,O,O,_],
  [O,E,B,O,_,_,_,_,O,B,E,O],
  [O,B,B,B,O,O,O,O,B,B,B,O],
  [O,B,B,B,B,B,B,B,B,B,B,O],
  [O,B,B,B,B,B,B,B,B,B,B,O],
  [O,B,Y,Y,B,B,B,B,Y,Y,B,O],  // still squinty
  [O,B,B,K,B,N,N,B,K,B,B,O],  // mouth closing
  [O,B,B,B,B,M,M,B,B,B,B,O],  // small mouth
  [_,O,B,B,B,B,B,B,B,B,O,_],
  [_,_,O,O,O,O,O,O,O,O,_,_],
];

// ── Anxious face (eyes darting left/right — approval wait too long) ──
const FACE_ANXIOUS_L: number[][] = [
  [_,O,O,_,_,_,_,_,_,O,O,_],
  [O,E,B,O,_,_,_,_,O,B,E,O],
  [O,B,B,B,O,O,O,O,B,B,B,O],
  [O,B,B,B,B,B,B,B,B,B,B,O],
  [O,Y,Y,H,B,B,B,Y,Y,H,B,O],  // bigger eyes looking left
  [O,B,B,B,B,B,B,B,B,B,H,O],  // sweat drop right side
  [O,B,B,B,B,N,N,B,B,B,H,O],  // sweat continues
  [O,B,B,M,M,M,M,M,B,B,B,O],  // wider worried wavy mouth
  [_,O,B,B,B,B,B,B,B,B,O,_],
  [_,_,O,O,O,O,O,O,O,O,_,_],
];

const FACE_ANXIOUS_R: number[][] = [
  [_,O,O,_,_,_,_,_,_,O,O,_],
  [O,E,B,O,_,_,_,_,O,B,E,O],
  [O,B,B,B,O,O,O,O,B,B,B,O],
  [O,B,B,B,B,B,B,B,B,B,B,O],
  [O,B,H,Y,Y,B,B,B,H,Y,Y,O],  // bigger eyes looking right
  [O,H,B,B,B,B,B,B,B,B,B,O],  // sweat drop left side
  [O,H,B,B,B,N,N,B,B,B,B,O],  // sweat continues
  [O,B,B,B,M,M,M,M,M,B,B,O],  // wider worried mouth
  [_,O,B,B,B,B,B,B,B,B,O,_],
  [_,_,O,O,O,O,O,O,O,O,_,_],
];

const FACE_ANXIOUS_SWEAT: number[][] = [
  [_,O,O,_,_,_,_,_,_,O,O,_],
  [O,E,B,O,_,_,_,_,O,B,E,O],
  [O,B,B,B,O,O,O,O,B,B,B,O],
  [O,B,B,B,B,B,B,B,B,B,H,O],  // sweat starts high
  [O,B,Y,Y,H,B,B,Y,Y,H,B,O],  // big eyes centered
  [O,B,B,B,B,B,B,B,B,B,H,O],  // sweat drop right (2px tall)
  [O,B,B,B,B,N,N,B,B,B,H,O],  // sweat continues down
  [O,B,B,M,M,M,M,M,B,B,B,O],  // wide worried mouth
  [_,O,B,B,B,B,B,B,B,B,O,_],
  [_,_,O,O,O,O,O,O,O,O,_,_],
];

// ── Sweating face (normal + sweat drops — rate limit approaching) ──
const FACE_SWEAT_A: number[][] = [
  [_,O,O,_,_,_,_,_,_,O,O,_],
  [O,E,B,O,_,_,_,_,O,B,E,O],
  [O,B,B,B,O,O,O,O,B,B,B,O],
  [O,H,B,B,B,B,B,B,B,B,H,O],  // sweat drops both sides high
  [O,H,Y,H,B,B,B,B,Y,H,H,O],  // sweat flanking eyes
  [O,B,B,B,B,B,B,B,B,B,B,O],
  [O,B,B,K,B,N,N,B,K,B,B,O],
  [O,B,B,M,M,B,B,M,M,B,B,O],  // wavy worried mouth ~~
  [_,O,B,B,B,B,B,B,B,B,O,_],
  [_,_,O,O,O,O,O,O,O,O,_,_],
];

const FACE_SWEAT_B: number[][] = [
  [_,O,O,_,_,_,_,_,_,O,O,_],
  [O,E,B,O,_,_,_,_,O,B,E,O],
  [O,B,B,B,O,O,O,O,B,B,B,O],
  [O,B,B,B,B,B,B,B,B,B,B,O],
  [O,B,Y,H,B,B,B,B,Y,H,B,O],
  [O,H,B,B,B,B,B,B,B,B,H,O],  // sweat drops lower both sides
  [O,H,B,K,B,N,N,B,K,B,H,O],  // sweat continues
  [O,B,B,M,M,B,B,M,M,B,B,O],
  [_,O,B,B,B,B,B,B,B,B,O,_],
  [_,_,O,O,O,O,O,O,O,O,_,_],
];

// ── Themes (matching PixelCat theme order) ──
interface LogoTheme {
  body: string;
  earInner: string;
  eye: string;
  nose: string;
  highlight: string;
  mouth: string;
  outline: string;
  cheek: string;
}

const THEMES: LogoTheme[] = [
  // 0: Orange Tabby
  { body: "#e8943a", earInner: "#ffb6c1", eye: "#2a4010", nose: "#ff8fab", highlight: "#fff", mouth: "#5a2a00", outline: "#5a2a00", cheek: "#ffaaaa" },
  // 1: Claude Blue
  { body: "#7ec8e3", earInner: "#ff99bb", eye: "#0a1a30", nose: "#ff88aa", highlight: "#fff", mouth: "#1a2a4a", outline: "#1a2a4a", cheek: "#ffaacc" },
  // 2: Black
  { body: "#3a3a3c", earInner: "#6a4a5a", eye: "#ffd700", nose: "#6a5a5c", highlight: "#fff", mouth: "#1a1a1e", outline: "#1a1a1e", cheek: "#5a4a5a" },
  // 3: White
  { body: "#e8e8ee", earInner: "#ffb6c1", eye: "#2a4070", nose: "#ffb6c1", highlight: "#fff", mouth: "#8a8a9a", outline: "#8a8a9a", cheek: "#ffccdd" },
  // 4: Gray
  { body: "#8e8e93", earInner: "#c0a0a8", eye: "#5a4a00", nose: "#c0a0a8", highlight: "#fff", mouth: "#4a4a4e", outline: "#4a4a4e", cheek: "#c0909a" },
  // 5: Siamese
  { body: "#f0e0c0", earInner: "#c49a6c", eye: "#2a4070", nose: "#c49a6c", highlight: "#fff", mouth: "#6a5030", outline: "#6a5030", cheek: "#e0b0a0" },
  // 6: Tuxedo
  { body: "#2c2c2e", earInner: "#4a4a4c", eye: "#2a5010", nose: "#ff8fab", highlight: "#fff", mouth: "#1a1a1e", outline: "#1a1a1e", cheek: "#4a3a4a" },
  // 7: Brown Tabby
  { body: "#c49a6c", earInner: "#ffb6c1", eye: "#2a5010", nose: "#ff8fab", highlight: "#fff", mouth: "#5a3a10", outline: "#5a3a10", cheek: "#e0a090" },
];

const CODEX_THEMES: LogoTheme[] = [
  // 0: Codex Green
  { body: "#2dd4a0", earInner: "#a3f0d0", eye: "#0a2a1a", nose: "#ff8fab", highlight: "#fff", mouth: "#0a3020", outline: "#0a3020", cheek: "#7aecc0" },
  // 1: Codex Mint
  { body: "#34d399", earInner: "#b0f0d8", eye: "#0a2a1a", nose: "#ffaacc", highlight: "#fff", mouth: "#0a4030", outline: "#0a4030", cheek: "#80e8b8" },
  // 2: Codex Teal
  { body: "#14b8a6", earInner: "#80e0d0", eye: "#0a1a18", nose: "#ff8fab", highlight: "#fff", mouth: "#063a34", outline: "#063a34", cheek: "#60d0c0" },
  // 3: Codex Emerald
  { body: "#10b981", earInner: "#a0ecc8", eye: "#0a2010", nose: "#ff99bb", highlight: "#fff", mouth: "#054030", outline: "#054030", cheek: "#70d8a8" },
];

// State-specific color overrides for better visual distinction
const STATE_OVERRIDES: Partial<Record<string, Partial<Record<number, string>>>> = {
  working: {
    // no color override — uses eye-scanning animation instead
  },
  sleeping: {
    [B]: undefined,  // handled via tint below
    [Y]: "#6a6a7a",  // muted gray-purple closed eyes
  },
  scared: {
    [Y]: "#ff3333",  // red wide eyes
    [M]: "#ff3333",  // red mouth
  },
  anxious: {
    [H]: "#44ccff",  // bright cyan sweat drops
  },
  sweating: {
    [H]: "#44ccff",  // bright cyan sweat drops
  },
  done: {
    [Y]: "#ffcc00",  // golden happy eyes
    [K]: "#ffaacc",  // rosy cheeks
  },
};

function getColor(zone: number, t: LogoTheme, state?: string): string | null {
  if (zone === 0) return null;

  // Check for state-specific override
  const overrides = state ? STATE_OVERRIDES[state] : undefined;
  if (overrides && zone in overrides) {
    return overrides[zone] ?? null;
  }

  switch (zone) {
    case O: return t.outline;
    case B: {
      // Sleeping: darken/desaturate body
      if (state === "sleeping") return darken(t.body, 0.25);
      // Scared: reddish tint
      if (state === "scared") return tint(t.body, "#ff4444", 0.2);
      return t.body;
    }
    case E: return t.earInner;
    case Y: return t.eye;
    case N: return t.nose;
    case H: return t.highlight;
    case M: return t.mouth;
    case K: return t.cheek;
    default: return t.body;
  }
}

// Simple color utilities for state tinting
function darken(hex: string, amount: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const f = 1 - amount;
  return `#${Math.round(r * f).toString(16).padStart(2, "0")}${Math.round(g * f).toString(16).padStart(2, "0")}${Math.round(b * f).toString(16).padStart(2, "0")}`;
}

function tint(hex: string, tintHex: string, amount: number): string {
  const r1 = parseInt(hex.slice(1, 3), 16);
  const g1 = parseInt(hex.slice(3, 5), 16);
  const b1 = parseInt(hex.slice(5, 7), 16);
  const r2 = parseInt(tintHex.slice(1, 3), 16);
  const g2 = parseInt(tintHex.slice(3, 5), 16);
  const b2 = parseInt(tintHex.slice(5, 7), 16);
  const f = 1 - amount;
  return `#${Math.round(r1 * f + r2 * amount).toString(16).padStart(2, "0")}${Math.round(g1 * f + g2 * amount).toString(16).padStart(2, "0")}${Math.round(b1 * f + b2 * amount).toString(16).padStart(2, "0")}`;
}

const GRID_W = 12;
const GRID_H = 10;

// Animation config per state
const ANIM: Record<string, { frames: number[][][]; speed: number }> = {
  idle: { frames: [FACE_IDLE, FACE_IDLE, FACE_IDLE, FACE_IDLE, FACE_IDLE, FACE_WORKING_BLINK], speed: 30 },
  working: { frames: [FACE_WORK_TAP_L, FACE_WORK_TAP_R, FACE_WORK_TAP_L, FACE_WORK_TAP_R, FACE_WORK_REST, FACE_WORK_TAP_L, FACE_WORK_TAP_R, FACE_WORKING_BLINK], speed: 8 },
  sleeping: { frames: [FACE_SLEEPING], speed: 60 },
  done: { frames: [FACE_DONE], speed: 60 },
  // Emotion states with dedicated pixel art
  scared: { frames: [FACE_SCARED, FACE_SCARED_ALT], speed: 5 },             // fast trembling
  yawning: { frames: [FACE_YAWN_CLOSE, FACE_YAWN_CLOSE, FACE_YAWN_OPEN, FACE_YAWN_OPEN, FACE_YAWN_OPEN, FACE_YAWN_CLOSE], speed: 25 }, // slow yawn cycle
  anxious: { frames: [FACE_ANXIOUS_L, FACE_ANXIOUS_L, FACE_ANXIOUS_R, FACE_ANXIOUS_R, FACE_ANXIOUS_SWEAT, FACE_ANXIOUS_SWEAT], speed: 10 }, // darting eyes + sweat
  sweating: { frames: [FACE_SWEAT_A, FACE_SWEAT_A, FACE_SWEAT_B, FACE_SWEAT_B], speed: 15 }, // dripping sweat
};

function getStateIndicator(state: string, _size: number): string | null {
  switch (state) {
    case "working": return "_";
    case "sleeping": return "z";
    case "done": return "\u2713";     // ✓
    case "scared": return "!";
    case "anxious": return "?";
    case "sweating": return "!";
    case "yawning": return "z";
    default: return null;
  }
}

export default function CatLogo({ state = "idle", size = 16, themeIndex = 0, provider, className }: CatLogoProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const theme = useMemo(() => {
    if (provider === "codex") {
      return CODEX_THEMES[themeIndex % CODEX_THEMES.length];
    }
    return THEMES[themeIndex % THEMES.length];
  }, [themeIndex, provider]);

  const prefersReducedMotion = useMemo(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  );

  // Pixel scale: each grid cell = px pixels
  const px = Math.max(1, Math.round(size / GRID_W));
  const canvasW = GRID_W * px;
  const canvasH = GRID_H * px;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;

    const { frames, speed } = ANIM[state] || ANIM.idle;
    let tick = 0;
    let rafId: number;

    const draw = () => {
      ctx.clearRect(0, 0, canvasW, canvasH);
      ctx.imageSmoothingEnabled = false;

      const frameIdx = prefersReducedMotion ? 0 : Math.floor(tick / speed) % frames.length;
      const sprite = frames[frameIdx];

      for (let row = 0; row < GRID_H; row++) {
        for (let col = 0; col < GRID_W; col++) {
          const zone = sprite[row]?.[col] ?? 0;
          const color = getColor(zone, theme, state);
          if (color) {
            ctx.fillStyle = color;
            ctx.fillRect(col * px, row * px, px, px);
          }
        }
      }

      tick++;
      if (prefersReducedMotion) return;
      rafId = requestAnimationFrame(draw);
    };

    draw();
    return () => cancelAnimationFrame(rafId);
  }, [state, theme, px, canvasW, canvasH, prefersReducedMotion]);

  const indicator = getStateIndicator(state, size);

  return (
    <span className={`cat-logo-wrap ${state === "working" ? "cat-logo--working" : ""} ${className || ""}`} style={{ position: "relative", display: "inline-flex", flexShrink: 0 }}>
      <canvas
        ref={canvasRef}
        width={canvasW}
        height={canvasH}
        className="pixel-cat-canvas"
        style={{
          imageRendering: "pixelated",
          width: size,
          height: Math.round(size * (GRID_H / GRID_W)),
          flexShrink: 0,
        }}
      />
      {indicator && !prefersReducedMotion && (
        <span className={`cat-indicator cat-indicator--${state}`} style={{ fontSize: Math.max(7, Math.round(size * 0.4)) }}>
          {indicator}
        </span>
      )}
    </span>
  );
}

export { THEMES };
