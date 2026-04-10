import { useEffect, useRef, useMemo } from "react";
import { CatState } from "../types";

interface CatLogoProps {
  state?: CatState;
  size?: number;
  themeIndex?: number;
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

// ── Working face (alert, focused eyes) ──
const FACE_WORKING: number[][] = [
  [_,O,O,_,_,_,_,_,_,O,O,_],
  [O,E,B,O,_,_,_,_,O,B,E,O],
  [O,B,B,B,O,O,O,O,B,B,B,O],
  [O,B,B,B,B,B,B,B,B,B,B,O],
  [O,B,Y,H,B,B,B,B,Y,H,B,O],
  [O,B,Y,B,B,B,B,B,Y,B,B,O],
  [O,B,B,K,B,N,N,B,K,B,B,O],
  [O,B,B,B,B,B,B,B,B,B,B,O],
  [_,O,B,B,B,B,B,B,B,B,O,_],
  [_,_,O,O,O,O,O,O,O,O,_,_],
];

// ── Working face alt (blink) ──
const FACE_WORKING_BLINK: number[][] = [
  [_,O,O,_,_,_,_,_,_,O,O,_],
  [O,E,B,O,_,_,_,_,O,B,E,O],
  [O,B,B,B,O,O,O,O,B,B,B,O],
  [O,B,B,B,B,B,B,B,B,B,B,O],
  [O,B,B,B,B,B,B,B,B,B,B,O],
  [O,B,Y,Y,B,B,B,B,Y,Y,B,O],
  [O,B,B,K,B,N,N,B,K,B,B,O],
  [O,B,B,B,B,B,B,B,B,B,B,O],
  [_,O,B,B,B,B,B,B,B,B,O,_],
  [_,_,O,O,O,O,O,O,O,O,_,_],
];

// ── Sleeping face (closed eyes) ──
const FACE_SLEEPING: number[][] = [
  [_,O,O,_,_,_,_,_,_,O,O,_],
  [O,E,B,O,_,_,_,_,O,B,E,O],
  [O,B,B,B,O,O,O,O,B,B,B,O],
  [O,B,B,B,B,B,B,B,B,B,B,O],
  [O,B,B,B,B,B,B,B,B,B,B,O],
  [O,B,Y,Y,B,B,B,B,Y,Y,B,O],
  [O,B,B,K,B,N,N,B,K,B,B,O],
  [O,B,B,B,B,B,B,B,B,B,B,O],
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
  [O,Y,H,B,B,B,B,Y,H,B,B,O],  // eyes looking left
  [O,B,B,B,B,B,B,B,B,B,B,O],
  [O,B,B,K,B,N,N,B,K,B,B,O],
  [O,B,B,B,M,M,M,B,B,B,B,O],  // worried wavy mouth
  [_,O,B,B,B,B,B,B,B,B,O,_],
  [_,_,O,O,O,O,O,O,O,O,_,_],
];

const FACE_ANXIOUS_R: number[][] = [
  [_,O,O,_,_,_,_,_,_,O,O,_],
  [O,E,B,O,_,_,_,_,O,B,E,O],
  [O,B,B,B,O,O,O,O,B,B,B,O],
  [O,B,B,B,B,B,B,B,B,B,B,O],
  [O,B,B,Y,H,B,B,B,B,Y,H,O],  // eyes looking right
  [O,B,B,B,B,B,B,B,B,B,B,O],
  [O,B,B,K,B,N,N,B,K,B,B,O],
  [O,B,B,B,B,M,M,M,B,B,B,O],  // worried mouth other side
  [_,O,B,B,B,B,B,B,B,B,O,_],
  [_,_,O,O,O,O,O,O,O,O,_,_],
];

const FACE_ANXIOUS_SWEAT: number[][] = [
  [_,O,O,_,_,_,_,_,_,O,O,_],
  [O,E,B,O,_,_,_,_,O,B,E,O],
  [O,B,B,B,O,O,O,O,B,B,B,O],
  [O,B,B,B,B,B,B,B,B,B,B,O],
  [O,B,Y,H,B,B,B,B,Y,H,B,O],  // normal eyes
  [O,B,B,B,B,B,B,B,B,B,H,O],  // sweat drop (H=white)
  [O,B,B,K,B,N,N,B,K,B,B,O],
  [O,B,B,B,M,M,M,B,B,B,B,O],  // worried mouth
  [_,O,B,B,B,B,B,B,B,B,O,_],
  [_,_,O,O,O,O,O,O,O,O,_,_],
];

// ── Sweating face (normal + sweat drops — rate limit approaching) ──
const FACE_SWEAT_A: number[][] = [
  [_,O,O,_,_,_,_,_,_,O,O,_],
  [O,E,B,O,_,_,_,_,O,B,E,O],
  [O,B,B,B,O,O,O,O,B,B,B,O],
  [O,B,B,B,B,B,B,B,B,B,H,O],  // sweat drop high
  [O,B,Y,H,B,B,B,B,Y,H,B,O],
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
  [O,B,B,B,B,B,B,B,B,B,H,O],  // sweat drop lower
  [O,B,B,K,B,N,N,B,K,B,H,O],  // sweat continues
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

function getColor(zone: number, t: LogoTheme): string | null {
  switch (zone) {
    case 0: return null;
    case O: return t.outline;
    case B: return t.body;
    case E: return t.earInner;
    case Y: return t.eye;
    case N: return t.nose;
    case H: return t.highlight;
    case M: return t.mouth;
    case K: return t.cheek;
    default: return t.body;
  }
}

const GRID_W = 12;
const GRID_H = 10;

// Animation config per state
const ANIM: Record<string, { frames: number[][][]; speed: number }> = {
  idle: { frames: [FACE_IDLE, FACE_IDLE, FACE_IDLE, FACE_IDLE, FACE_IDLE, FACE_WORKING_BLINK], speed: 30 },
  working: { frames: [FACE_WORKING, FACE_WORKING, FACE_WORKING, FACE_WORKING_BLINK], speed: 20 },
  sleeping: { frames: [FACE_SLEEPING], speed: 60 },
  done: { frames: [FACE_DONE], speed: 60 },
  // Emotion states with dedicated pixel art
  scared: { frames: [FACE_SCARED, FACE_SCARED_ALT], speed: 5 },             // fast trembling
  yawning: { frames: [FACE_YAWN_CLOSE, FACE_YAWN_CLOSE, FACE_YAWN_OPEN, FACE_YAWN_OPEN, FACE_YAWN_OPEN, FACE_YAWN_CLOSE], speed: 25 }, // slow yawn cycle
  anxious: { frames: [FACE_ANXIOUS_L, FACE_ANXIOUS_L, FACE_ANXIOUS_R, FACE_ANXIOUS_R, FACE_ANXIOUS_SWEAT, FACE_ANXIOUS_SWEAT], speed: 10 }, // darting eyes + sweat
  sweating: { frames: [FACE_SWEAT_A, FACE_SWEAT_A, FACE_SWEAT_B, FACE_SWEAT_B], speed: 15 }, // dripping sweat
};

export default function CatLogo({ state = "idle", size = 16, themeIndex = 0, className }: CatLogoProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const theme = useMemo(() => {
    return THEMES[themeIndex % THEMES.length];
  }, [themeIndex]);

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
          const color = getColor(zone, theme);
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

  return (
    <canvas
      ref={canvasRef}
      width={canvasW}
      height={canvasH}
      className={`pixel-cat-canvas ${className || ""}`}
      style={{
        imageRendering: "pixelated",
        width: size,
        height: Math.round(size * (GRID_H / GRID_W)),
        flexShrink: 0,
      }}
    />
  );
}

export { THEMES };
