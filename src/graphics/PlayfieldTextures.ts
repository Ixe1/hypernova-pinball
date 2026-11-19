/**
 * HYPERNOVA — Procedural High-DPI Playfield Textures
 *
 * Generates aligned 2048x4096 (or scaled) albedo, roughness, and bump textures
 * for the clear-coated 1990s cosmic sci-fi pinball deck.
 *
 * UV convention (Three.js PlaneGeometry rotated -PI/2 around X, CanvasTexture flipY = true):
 *   Canvas X: 0 -> PLAYFIELD_MIN_X (-5.2),  W -> PLAYFIELD_MAX_X (+5.2)
 *   Canvas Y: 0 -> PLAYFIELD_MIN_Z (-10.6), H -> PLAYFIELD_MAX_Z (+10.6)
 */

import * as THREE from 'three';
import {
  ACTIVE_CENTER_X,
  PALETTE_CSS,
  PLAYFIELD_LENGTH,
  PLAYFIELD_MIN_X,
  PLAYFIELD_MIN_Z,
  PLAYFIELD_WIDTH,
  SHOOTER_LANE_CENTER_X,
  SHOOTER_LANE_MAX_X,
  SHOOTER_LANE_MIN_X,
} from '../config/constants';
import {
  DROP_TARGETS,
  FLIPPERS,
  HYPERCORE_SAUCER,
  KICKBACK,
  LED_INSERTS,
  POP_BUMPERS,
  ROLLOVER_LANES,
  RUBBER_POSTS,
  SLINGSHOTS,
  SPINNER,
  STANDUP_TARGETS,
  TABLE_LAYOUT,
  WARP_RAMP,
} from '../config/tableLayout';
import type { InsertShape } from '../config/tableLayout';
import type { Vec2 } from '../config/types';

export interface PlayfieldTextureSet {
  map: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
  bumpMap: THREE.CanvasTexture;
  dispose(): void;
}

const BASE_WIDTH = 2048;
const BASE_HEIGHT = 4096;

/** Deterministic Mulberry32 PRNG for reproducible starfields and nebula accents. */
function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hexToCss(hex: number, alpha = 1): string {
  const r = (hex >> 16) & 0xff;
  const g = (hex >> 8) & 0xff;
  const b = hex & 0xff;
  if (alpha >= 1) {
    return `rgb(${r}, ${g}, ${b})`;
  }
  return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`;
}

function traceInsertPath(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  shape: InsertShape,
  radiusPx: number,
  rotationRad: number,
): void {
  ctx.save();
  ctx.translate(cx, cy);
  // Playfield Y rotation: positive rotation turns +Z toward +X, -Z toward -X -> canvas -rotation
  ctx.rotate(-rotationRad);
  ctx.beginPath();

  switch (shape) {
    case 'circle': {
      ctx.arc(0, 0, radiusPx, 0, Math.PI * 2);
      break;
    }
    case 'diamond': {
      ctx.moveTo(0, -radiusPx * 1.15);
      ctx.lineTo(radiusPx * 0.85, 0);
      ctx.lineTo(0, radiusPx * 1.15);
      ctx.lineTo(-radiusPx * 0.85, 0);
      ctx.closePath();
      break;
    }
    case 'arrow': {
      ctx.moveTo(0, -radiusPx * 1.35);
      ctx.lineTo(radiusPx * 0.95, radiusPx * 0.35);
      ctx.lineTo(radiusPx * 0.38, radiusPx * 0.35);
      ctx.lineTo(radiusPx * 0.38, radiusPx * 1.15);
      ctx.lineTo(-radiusPx * 0.38, radiusPx * 1.15);
      ctx.lineTo(-radiusPx * 0.38, radiusPx * 0.35);
      ctx.lineTo(-radiusPx * 0.95, radiusPx * 0.35);
      ctx.closePath();
      break;
    }
    case 'chevron': {
      ctx.moveTo(0, -radiusPx * 1.15);
      ctx.lineTo(radiusPx * 1.05, radiusPx * 0.45);
      ctx.lineTo(radiusPx * 0.55, radiusPx * 0.95);
      ctx.lineTo(0, -radiusPx * 0.25);
      ctx.lineTo(-radiusPx * 0.55, radiusPx * 0.95);
      ctx.lineTo(-radiusPx * 1.05, radiusPx * 0.45);
      ctx.closePath();
      break;
    }
    case 'star': {
      const spikes = 5;
      const outer = radiusPx * 1.18;
      const inner = radiusPx * 0.52;
      for (let i = 0; i < spikes * 2; i++) {
        const r = i % 2 === 0 ? outer : inner;
        const a = -Math.PI / 2 + (i * Math.PI) / spikes;
        const px = Math.cos(a) * r;
        const py = Math.sin(a) * r;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      break;
    }
    case 'bar': {
      // Vertical pill matching PlayfieldMeshBuilder's 3D 'bar' mesh (hw=0.42s, hh=1.18s)
      const w = radiusPx * 0.84;
      const h = radiusPx * 2.36;
      const r = w * 0.35;
      ctx.roundRect(-w / 2, -h / 2, w, h, r);
      break;
    }
  }

  ctx.restore();
}

/**
 * Draws retro 90s sci-fi metallic chrome + neon trimmed lettering.
 */
function drawChromeText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  fontPx: number,
  opts?: {
    italic?: boolean;
    accentColor?: string;
    glowColor?: string;
    strokeWidth?: number;
    letterSpacing?: number;
  },
): void {
  const italic = opts?.italic ?? false;
  const accentColor = opts?.accentColor ?? PALETTE_CSS.cyan;
  const glowColor = opts?.glowColor ?? PALETTE_CSS.magenta;
  const strokeWidth = opts?.strokeWidth ?? Math.max(4, fontPx * 0.085);

  ctx.save();
  ctx.font = `${italic ? 'italic ' : ''}900 ${fontPx}px "Impact", "Arial Black", "Orbitron", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Outer neon aura
  ctx.shadowColor = glowColor;
  ctx.shadowBlur = fontPx * 0.34;
  ctx.lineWidth = strokeWidth * 1.65;
  ctx.strokeStyle = glowColor;
  ctx.lineJoin = 'round';
  ctx.strokeText(text, x, y);

  // Dark metallic ink outline for razor readability
  ctx.shadowBlur = 0;
  ctx.lineWidth = strokeWidth * 1.05;
  ctx.strokeStyle = '#060a1c';
  ctx.strokeText(text, x, y);

  // Classic 90s chrome horizon gradient fill (sky cyan -> silver white -> dark cobalt -> magenta bounce)
  const grad = ctx.createLinearGradient(x, y - fontPx * 0.52, x, y + fontPx * 0.52);
  grad.addColorStop(0.0, '#ffffff');
  grad.addColorStop(0.24, '#aef8ff');
  grad.addColorStop(0.46, accentColor);
  grad.addColorStop(0.51, '#0c163a');
  grad.addColorStop(0.68, '#7a52ff');
  grad.addColorStop(0.86, '#ff86eb');
  grad.addColorStop(1.0, '#ffffff');
  ctx.fillStyle = grad;
  ctx.fillText(text, x, y);

  // Crisp top specular highlight line
  ctx.lineWidth = Math.max(1.5, strokeWidth * 0.25);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.72)';
  ctx.strokeText(text, x, y - fontPx * 0.018);
  ctx.restore();
}

/**
 * Draws a sleek glowing arcade callout pill label on the playfield.
 */
function drawLaneLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  cy: number,
  fontPx: number,
  color: string,
  rotationRad = 0,
  pill = true,
): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rotationRad);
  ctx.font = `900 ${fontPx}px "Arial Black", "Trebuchet MS", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  if (pill) {
    const metrics = ctx.measureText(text);
    const padX = fontPx * 0.55;
    const padY = fontPx * 0.32;
    const w = metrics.width + padX * 2;
    const h = fontPx + padY * 2;

    ctx.fillStyle = 'rgba(5, 9, 26, 0.84)';
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(2, fontPx * 0.11);
    ctx.shadowColor = color;
    ctx.shadowBlur = fontPx * 0.45;
    ctx.beginPath();
    ctx.roundRect(-w / 2, -h / 2, w, h, h * 0.34);
    ctx.fill();
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  ctx.lineWidth = Math.max(2, fontPx * 0.14);
  ctx.strokeStyle = '#040714';
  ctx.strokeText(text, 0, 0);

  ctx.fillStyle = '#f5fbff';
  ctx.fillText(text, 0, 0);

  ctx.fillStyle = color;
  ctx.globalAlpha = 0.4;
  ctx.fillText(text, 0, fontPx * 0.04);
  ctx.restore();
}

/**
 * Draws diagonal arcade hazard stripes clipped to a rectangle.
 */
function drawHazardStripes(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  colorA: string,
  colorB: string,
  stripeWidth: number,
  angleDeg = -45,
): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();

  ctx.fillStyle = colorB;
  ctx.fillRect(x, y, w, h);

  ctx.translate(x + w / 2, y + h / 2);
  ctx.rotate((angleDeg * Math.PI) / 180);
  const diag = Math.hypot(w, h) + stripeWidth * 4;
  ctx.fillStyle = colorA;
  for (let sx = -diag; sx < diag; sx += stripeWidth * 2) {
    ctx.fillRect(sx, -diag, stripeWidth, diag * 2);
  }
  ctx.restore();
}

/**
 * Creates the full 1990s cosmic sci-fi playfield texture set (albedo, roughness, bump).
 *
 * @param scale Resolution multiplier: `1` = 2048x4096 (high), `0.5` = 1024x2048 (medium).
 */
export function createPlayfieldTextures(scale = 1): PlayfieldTextureSet {
  const clampedScale = Math.max(0.25, Math.min(1, scale));
  const width = Math.round(BASE_WIDTH * clampedScale);
  const height = Math.round(BASE_HEIGHT * clampedScale);

  const albedoCanvas = document.createElement('canvas');
  albedoCanvas.width = width;
  albedoCanvas.height = height;

  const roughCanvas = document.createElement('canvas');
  roughCanvas.width = width;
  roughCanvas.height = height;

  const bumpCanvas = document.createElement('canvas');
  bumpCanvas.width = width;
  bumpCanvas.height = height;

  const ctx = albedoCanvas.getContext('2d');
  const rCtx = roughCanvas.getContext('2d');
  const bCtx = bumpCanvas.getContext('2d');

  if (!ctx || !rCtx || !bCtx) {
    throw new Error('Failed to acquire 2D canvas context for playfield textures.');
  }

  // Coordinate converters: playfield XZ -> canvas pixel XY
  const px = (x: number): number => ((x - PLAYFIELD_MIN_X) / PLAYFIELD_WIDTH) * width;
  const py = (z: number): number => ((z - PLAYFIELD_MIN_Z) / PLAYFIELD_LENGTH) * height;
  const scaleX = width / PLAYFIELD_WIDTH;
  const scaleZ = height / PLAYFIELD_LENGTH;
  const scaleAvg = (scaleX + scaleZ) * 0.5;
  const s = (worldUnits: number): number => worldUnits * scaleAvg;

  const rng = createRng(0x1994_490a);

  // =========================================================================
  // 1. ALBEDO BASE: DEEP MIDNIGHT COSMOS & NEBULA CLOUDS
  // =========================================================================
  const bgGrad = ctx.createLinearGradient(0, 0, 0, height);
  bgGrad.addColorStop(0.0, '#070c22');
  bgGrad.addColorStop(0.26, '#0d153c');
  bgGrad.addColorStop(0.55, '#0b102f');
  bgGrad.addColorStop(0.82, '#101536');
  bgGrad.addColorStop(1.0, '#060918');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, width, height);

  // Rich cosmic nebula clouds painted with layered radial gradients
  const nebulae: Array<{ x: number; z: number; r: number; inner: string; mid: string }> = [
    { x: ACTIVE_CENTER_X, z: -4.2, r: 6.0, inner: 'rgba(139, 61, 255, 0.42)', mid: 'rgba(0, 240, 255, 0.16)' },
    { x: -3.2, z: -6.2, r: 4.2, inner: 'rgba(255, 43, 214, 0.34)', mid: 'rgba(100, 30, 190, 0.14)' },
    { x: 2.3, z: -4.8, r: 3.8, inner: 'rgba(0, 240, 255, 0.28)', mid: 'rgba(20, 75, 190, 0.12)' },
    { x: ACTIVE_CENTER_X, z: 2.0, r: 5.4, inner: 'rgba(255, 43, 214, 0.30)', mid: 'rgba(42, 24, 128, 0.16)' },
    { x: -2.9, z: 2.2, r: 3.4, inner: 'rgba(0, 240, 255, 0.22)', mid: 'rgba(18, 48, 120, 0.08)' },
    { x: 2.2, z: 1.8, r: 3.2, inner: 'rgba(0, 255, 157, 0.18)', mid: 'rgba(12, 82, 110, 0.08)' },
    { x: ACTIVE_CENTER_X, z: 6.4, r: 3.6, inner: 'rgba(255, 155, 26, 0.16)', mid: 'rgba(140, 25, 110, 0.08)' },
  ];

  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  for (const n of nebulae) {
    const cx = px(n.x);
    const cy = py(n.z);
    const rad = s(n.r);
    const g = ctx.createRadialGradient(cx, cy, rad * 0.05, cx, cy, rad);
    g.addColorStop(0.0, n.inner);
    g.addColorStop(0.45, n.mid);
    g.addColorStop(1.0, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, rad, 0, Math.PI * 2);
    ctx.fill();
  }

  // Sweeping galactic dust ribbon curving from upper-left Warp Ramp down through Hypernova core
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(px(-5.2), py(-9.5));
  ctx.bezierCurveTo(px(-2.2), py(-5.5), px(1.5), py(-1.2), px(-1.2), py(4.5));
  ctx.bezierCurveTo(px(-2.8), py(7.2), px(1.0), py(8.5), px(4.15), py(6.2));
  ctx.lineWidth = s(2.4);
  const dustGrad = ctx.createLinearGradient(px(-5.2), py(-9.5), px(4.15), py(7.5));
  dustGrad.addColorStop(0.0, 'rgba(0, 240, 255, 0.10)');
  dustGrad.addColorStop(0.35, 'rgba(160, 72, 255, 0.18)');
  dustGrad.addColorStop(0.68, 'rgba(255, 43, 214, 0.16)');
  dustGrad.addColorStop(1.0, 'rgba(255, 155, 26, 0.08)');
  ctx.strokeStyle = dustGrad;
  ctx.lineCap = 'round';
  ctx.filter = `blur(${Math.max(8, Math.round(s(0.45)))}px)`;
  ctx.stroke();
  ctx.restore();
  ctx.restore();

  // Crisp multi-layer cosmic starfield
  const starCount = Math.round(680 * (0.65 + 0.35 * clampedScale));
  for (let i = 0; i < starCount; i++) {
    const sx = rng() * width;
    const sy = rng() * height;
    const mag = rng();
    const r = (0.6 + mag * mag * 2.4) * clampedScale;
    const tintRoll = rng();
    const starColor =
      tintRoll < 0.6
        ? '#ffffff'
        : tintRoll < 0.8
          ? '#a8f9ff'
          : tintRoll < 0.93
            ? '#ffb3f4'
            : '#ffe49e';

    ctx.globalAlpha = 0.25 + mag * 0.75;
    ctx.fillStyle = starColor;
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fill();

    // 4-point diffraction spikes on hero stars
    if (mag > 0.93) {
      const spike = r * 4.5;
      ctx.strokeStyle = starColor;
      ctx.lineWidth = Math.max(0.8, clampedScale * 1.1);
      ctx.beginPath();
      ctx.moveTo(sx - spike, sy);
      ctx.lineTo(sx + spike, sy);
      ctx.moveTo(sx, sy - spike);
      ctx.lineTo(sx, sy + spike);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;

  // =========================================================================
  // 2. SCI-FI ORBITAL SCHEMATICS & TECH GRID AROUND HYPERCORE
  // =========================================================================
  const hcX = px(HYPERCORE_SAUCER.position.x);
  const hcY = py(HYPERCORE_SAUCER.position.z);

  // Perspective sci-fi coordinate grid over active playfield
  ctx.save();
  ctx.strokeStyle = 'rgba(0, 240, 255, 0.065)';
  ctx.lineWidth = Math.max(1, clampedScale * 1.5);
  for (let gx = -5; gx <= 4; gx += 1) {
    ctx.beginPath();
    ctx.moveTo(px(gx), py(-10.6));
    ctx.lineTo(px(gx), py(10.6));
    ctx.stroke();
  }
  for (let gz = -10; gz <= 10; gz += 1) {
    ctx.beginPath();
    ctx.moveTo(px(-5.2), py(gz));
    ctx.lineTo(px(4.15), py(gz));
    ctx.stroke();
  }
  ctx.restore();

  // Concentric Hypercore astrolabe rings & degree ticks centered at (-0.525, -4.2)
  ctx.save();
  const ringRadii = [0.76, 1.18, 1.85, 2.75, 3.85];
  ringRadii.forEach((worldR, idx) => {
    const rPx = s(worldR);
    ctx.beginPath();
    ctx.arc(hcX, hcY, rPx, 0, Math.PI * 2);
    ctx.strokeStyle =
      idx % 2 === 0 ? 'rgba(0, 240, 255, 0.28)' : 'rgba(255, 43, 214, 0.24)';
    ctx.lineWidth = idx === 0 ? s(0.05) : Math.max(1.5, clampedScale * 2.2);
    if (idx === 2 || idx === 4) {
      ctx.setLineDash([s(0.28), s(0.16)]);
    } else {
      ctx.setLineDash([]);
    }
    ctx.stroke();
  });
  ctx.setLineDash([]);

  // Astrolabe radial ticks around ring 1.18
  for (let deg = 0; deg < 360; deg += 15) {
    const rad = (deg * Math.PI) / 180;
    const inner = s(deg % 45 === 0 ? 0.92 : 1.06);
    const outer = s(1.24);
    ctx.strokeStyle =
      deg % 45 === 0 ? 'rgba(0, 240, 255, 0.65)' : 'rgba(140, 180, 255, 0.30)';
    ctx.lineWidth = deg % 45 === 0 ? s(0.035) : s(0.018);
    ctx.beginPath();
    ctx.moveTo(hcX + Math.cos(rad) * inner, hcY + Math.sin(rad) * inner);
    ctx.lineTo(hcX + Math.cos(rad) * outer, hcY + Math.sin(rad) * outer);
    ctx.stroke();
  }

  // Deep glowing reactor recess graphic right inside saucer pocket
  const saucerGrad = ctx.createRadialGradient(hcX, hcY, s(0.06), hcX, hcY, s(0.68));
  saucerGrad.addColorStop(0.0, '#ffffff');
  saucerGrad.addColorStop(0.22, '#7b4dff');
  saucerGrad.addColorStop(0.55, '#190c42');
  saucerGrad.addColorStop(0.84, '#00f0ff');
  saucerGrad.addColorStop(1.0, 'rgba(0, 240, 255, 0)');
  ctx.fillStyle = saucerGrad;
  ctx.beginPath();
  ctx.arc(hcX, hcY, s(0.68), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // =========================================================================
  // 3. UPPER ARCH, I-O-N LANES & POP BUMPER FIELD ART
  // =========================================================================
  // Glowing neon accent track tracing the upper parabolic arch
  ctx.save();
  const archCenterX = px(0);
  const archCenterY = py(-5.4);
  const archR = s(4.82);
  const archGrad = ctx.createLinearGradient(px(-5.2), py(-10.6), px(5.2), py(-5.4));
  archGrad.addColorStop(0.0, 'rgba(0, 240, 255, 0.55)');
  archGrad.addColorStop(0.5, 'rgba(255, 43, 214, 0.55)');
  archGrad.addColorStop(1.0, 'rgba(255, 155, 26, 0.55)');
  ctx.strokeStyle = archGrad;
  ctx.lineWidth = s(0.11);
  ctx.beginPath();
  ctx.arc(archCenterX, archCenterY, archR, Math.PI, 0, false);
  ctx.stroke();
  ctx.restore();

  // I - O - N rollover lane painted tracks & header
  for (const lane of ROLLOVER_LANES) {
    const lx = px(lane.position.x);
    const ly = py(lane.position.z);
    ctx.save();
    const laneGrad = ctx.createLinearGradient(lx, py(-8.8), lx, py(-7.1));
    laneGrad.addColorStop(0.0, 'rgba(0, 240, 255, 0.05)');
    laneGrad.addColorStop(0.5, 'rgba(0, 240, 255, 0.25)');
    laneGrad.addColorStop(1.0, 'rgba(0, 240, 255, 0.05)');
    ctx.fillStyle = laneGrad;
    ctx.fillRect(lx - s(0.36), py(-8.65), s(0.72), s(1.4));

    ctx.strokeStyle = 'rgba(0, 240, 255, 0.45)';
    ctx.lineWidth = Math.max(1.5, clampedScale * 2);
    ctx.strokeRect(lx - s(0.34), py(-8.55), s(0.68), s(1.2));
    ctx.restore();

    // Crisp I / O / N badge slightly above each lane fin entrance
    drawLaneLabel(ctx, lane.label, lx, py(-8.98), s(0.26), PALETTE_CSS.cyan, 0, true);
    // Subtle chevron pointing down into bumper nest
    ctx.save();
    ctx.strokeStyle = 'rgba(102, 247, 255, 0.55)';
    ctx.lineWidth = s(0.045);
    ctx.beginPath();
    ctx.moveTo(lx - s(0.16), ly + s(0.52));
    ctx.lineTo(lx, ly + s(0.68));
    ctx.lineTo(lx + s(0.16), ly + s(0.52));
    ctx.stroke();
    ctx.restore();
  }
  drawLaneLabel(ctx, 'SKILL SHOT', px(0.55), py(-9.56), s(0.22), PALETTE_CSS.amber, 0, false);

  // Pop Bumper shockwave rings & energy conduit traces linking all 3 jets
  ctx.save();
  ctx.strokeStyle = 'rgba(0, 240, 255, 0.32)';
  ctx.lineWidth = s(0.07);
  ctx.beginPath();
  ctx.moveTo(px(POP_BUMPERS[0].position.x), py(POP_BUMPERS[0].position.z));
  ctx.lineTo(px(POP_BUMPERS[1].position.x), py(POP_BUMPERS[1].position.z));
  ctx.lineTo(px(POP_BUMPERS[2].position.x), py(POP_BUMPERS[2].position.z));
  ctx.closePath();
  ctx.stroke();

  for (const bumper of POP_BUMPERS) {
    const bx = px(bumper.position.x);
    const by = py(bumper.position.z);
    const col = hexToCss(bumper.color);

    // Outer plasma splash halo
    const splash = ctx.createRadialGradient(bx, by, s(0.35), bx, by, s(0.98));
    splash.addColorStop(0.0, hexToCss(bumper.color, 0.52));
    splash.addColorStop(0.55, hexToCss(bumper.color, 0.18));
    splash.addColorStop(1.0, 'rgba(0,0,0,0)');
    ctx.fillStyle = splash;
    ctx.beginPath();
    ctx.arc(bx, by, s(0.98), 0, Math.PI * 2);
    ctx.fill();

    // Jagged retro starburst collar around bumper base
    ctx.beginPath();
    const pts = 16;
    for (let i = 0; i < pts * 2; i++) {
      const r = s(i % 2 === 0 ? 0.78 : 0.56);
      const a = (i * Math.PI) / pts;
      const x = bx + Math.cos(a) * r;
      const y = by + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(8, 12, 30, 0.72)';
    ctx.fill();
    ctx.strokeStyle = col;
    ctx.lineWidth = s(0.032);
    ctx.stroke();

    // Chrome inner mounting ring
    ctx.beginPath();
    ctx.arc(bx, by, s(bumper.radius * 1.06), 0, Math.PI * 2);
    ctx.strokeStyle = '#d4e6ff';
    ctx.lineWidth = s(0.04);
    ctx.stroke();
  }
  ctx.restore();

  // =========================================================================
  // 4. MAJOR SHOT LANES, RAMP PERSPECTIVE TRACKS & DIRECTIONAL CALLOUTS
  // =========================================================================
  // Left Orbit & Spinner lane stripe
  ctx.save();
  const orbitLGrad = ctx.createLinearGradient(px(-4.675), py(-0.2), px(-4.675), py(-5.5));
  orbitLGrad.addColorStop(0.0, 'rgba(0, 240, 255, 0.04)');
  orbitLGrad.addColorStop(0.5, 'rgba(0, 240, 255, 0.30)');
  orbitLGrad.addColorStop(1.0, 'rgba(255, 43, 214, 0.14)');
  ctx.fillStyle = orbitLGrad;
  ctx.fillRect(px(-5.05), py(-5.2), s(0.75), s(5.0));

  // Painted cyan chevron rails along left orbit
  ctx.strokeStyle = 'rgba(0, 240, 255, 0.65)';
  ctx.lineWidth = s(0.04);
  for (let cz = -0.35; cz >= -4.8; cz -= 0.75) {
    ctx.beginPath();
    ctx.moveTo(px(-4.92), py(cz));
    ctx.lineTo(px(-4.675), py(cz - 0.28));
    ctx.lineTo(px(-4.43), py(cz));
    ctx.stroke();
  }
  ctx.restore();
  drawLaneLabel(ctx, 'ORBIT', px(-4.62), py(-0.42), s(0.24), PALETTE_CSS.cyan, 0, true);
  drawLaneLabel(ctx, 'SPIN', px(SPINNER.position.x), py(SPINNER.position.z - 0.56), s(0.24), PALETTE_CSS.amber, 0, true);

  // Warp Ramp dramatic perspective speed runway & entrance stripes
  ctx.save();
  ctx.beginPath();
  const rampPts = WARP_RAMP.controlPoints;
  ctx.moveTo(px(rampPts[0].x), py(rampPts[0].z));
  for (let i = 1; i < rampPts.length; i++) {
    ctx.lineTo(px(rampPts[i].x), py(rampPts[i].z));
  }
  ctx.strokeStyle = 'rgba(255, 43, 214, 0.22)';
  ctx.lineWidth = s(WARP_RAMP.width * 0.92);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();

  // Inner speed centerline along ramp shadow on playfield
  ctx.strokeStyle = 'rgba(0, 240, 255, 0.45)';
  ctx.lineWidth = s(0.07);
  ctx.setLineDash([s(0.32), s(0.22)]);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();

  // Warp Ramp callout positioned cleanly below arrow_warp_ramp (clear of ramp entry arch & drop bank)
  drawLaneLabel(ctx, 'WARP RAMP', px(-2.78), py(-0.42), s(0.22), PALETTE_CSS.magenta, -0.14, true);

  // Hypercore approach lane stripes & labels
  ctx.save();
  const hcLaneGrad = ctx.createLinearGradient(hcX, py(-1.2), hcX, py(-3.7));
  hcLaneGrad.addColorStop(0.0, 'rgba(139, 61, 255, 0.05)');
  hcLaneGrad.addColorStop(0.55, 'rgba(139, 61, 255, 0.34)');
  hcLaneGrad.addColorStop(1.0, 'rgba(0, 240, 255, 0.48)');
  ctx.fillStyle = hcLaneGrad;
  ctx.beginPath();
  ctx.moveTo(px(ACTIVE_CENTER_X - 0.65), py(-1.6));
  ctx.lineTo(px(ACTIVE_CENTER_X - 0.48), py(-3.7));
  ctx.lineTo(px(ACTIVE_CENTER_X + 0.48), py(-3.7));
  ctx.lineTo(px(ACTIVE_CENTER_X + 0.65), py(-1.6));
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  drawLaneLabel(ctx, 'HYPERCORE', px(ACTIVE_CENTER_X), py(-3.36), s(0.24), PALETTE_CSS.cyan, 0, true);

  // Right Orbit lane track & label
  ctx.save();
  ctx.strokeStyle = 'rgba(0, 240, 255, 0.45)';
  ctx.lineWidth = s(0.05);
  ctx.beginPath();
  ctx.moveTo(px(3.32), py(-1.55));
  ctx.quadraticCurveTo(px(3.75), py(-2.95), px(3.62), py(-4.45));
  ctx.stroke();
  ctx.restore();
  drawLaneLabel(ctx, 'ORBIT', px(3.38), py(-1.68), s(0.23), PALETTE_CSS.cyan, 0.22, true);

  // =========================================================================
  // 5. DROP TARGETS (R-A-Y) & STANDUPS (2X-3X-5X) DECK PANELS
  // =========================================================================
  // Left R-A-Y target deck plate
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(px(-5.15), py(0.0));
  ctx.lineTo(px(-3.65), py(0.1));
  ctx.lineTo(px(-3.52), py(2.12));
  ctx.lineTo(px(-5.15), py(2.25));
  ctx.closePath();
  ctx.fillStyle = 'rgba(38, 10, 56, 0.66)';
  ctx.fill();
  ctx.strokeStyle = PALETTE_CSS.magenta;
  ctx.lineWidth = s(0.045);
  ctx.stroke();
  ctx.restore();

  // Subtle recessed slot markers under R-A-Y drop targets (3D diamond inserts carry R/A/Y labels)
  ctx.save();
  ctx.fillStyle = 'rgba(255, 43, 214, 0.32)';
  for (const dt of DROP_TARGETS) {
    ctx.save();
    ctx.translate(px(dt.position.x), py(dt.position.z));
    ctx.rotate(-dt.angleY);
    ctx.fillRect(-s(dt.width * 0.5), -s(dt.depth * 0.55), s(dt.width), s(dt.depth * 1.1));
    ctx.restore();
  }
  ctx.restore();
  drawLaneLabel(ctx, 'LOCK + SHIELD', px(-3.82), py(2.48), s(0.165), PALETTE_CSS.amber, 0, false);

  // Right 2X-3X-5X standup target deck plate
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(px(4.12), py(0.95));
  ctx.lineTo(px(2.65), py(1.1));
  ctx.lineTo(px(2.85), py(2.92));
  ctx.lineTo(px(4.12), py(2.95));
  ctx.closePath();
  ctx.fillStyle = 'rgba(8, 42, 42, 0.62)';
  ctx.fill();
  ctx.strokeStyle = PALETTE_CSS.emerald;
  ctx.lineWidth = s(0.045);
  ctx.stroke();
  ctx.restore();

  // Subtle recessed mounting footprints under right standup targets (3D inserts carry 2X/3X/5X labels)
  ctx.save();
  ctx.fillStyle = 'rgba(0, 255, 157, 0.30)';
  for (const st of STANDUP_TARGETS) {
    ctx.save();
    ctx.translate(px(st.position.x), py(st.position.z));
    ctx.rotate(-st.angleY);
    ctx.fillRect(-s(st.width * 0.5), -s(st.depth * 0.55), s(st.width), s(st.depth * 1.1));
    ctx.restore();
  }
  ctx.restore();
  drawLaneLabel(ctx, 'PLAYFIELD X', px(1.52), py(3.58), s(0.18), PALETTE_CSS.emerald, 0, false);

  // =========================================================================
  // 6. ICONIC LOWER-MIDFIELD CENTERPIECE: COSMIC RINGED PLANET + HYPERNOVA
  // =========================================================================
  const heroX = px(ACTIVE_CENTER_X);
  const heroY = py(1.88);

  // Cosmic supernova starburst rays behind logo
  ctx.save();
  ctx.translate(heroX, heroY);
  const rayCount = 24;
  for (let i = 0; i < rayCount; i++) {
    const a = (i / rayCount) * Math.PI * 2;
    const longRay = i % 2 === 0;
    const len = s(longRay ? 2.65 : 1.75);
    const spread = longRay ? 0.055 : 0.035;
    const rayGrad = ctx.createRadialGradient(0, 0, s(0.2), 0, 0, len);
    rayGrad.addColorStop(0.0, longRay ? 'rgba(0, 240, 255, 0.42)' : 'rgba(255, 43, 214, 0.34)');
    rayGrad.addColorStop(0.6, longRay ? 'rgba(139, 61, 255, 0.16)' : 'rgba(255, 155, 26, 0.12)');
    rayGrad.addColorStop(1.0, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = rayGrad;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(a - spread) * len, Math.sin(a - spread) * len);
    ctx.lineTo(Math.cos(a + spread) * len, Math.sin(a + spread) * len);
    ctx.closePath();
    ctx.fill();
  }

  // Stylized ringed cosmic planet right behind the logo
  const planetR = s(1.18);
  const planetGrad = ctx.createRadialGradient(
    -planetR * 0.35,
    -planetR * 0.35,
    planetR * 0.12,
    0,
    0,
    planetR,
  );
  planetGrad.addColorStop(0.0, '#7df9ff');
  planetGrad.addColorStop(0.28, '#2948d6');
  planetGrad.addColorStop(0.65, '#3b1073');
  planetGrad.addColorStop(0.9, '#12072b');
  planetGrad.addColorStop(1.0, '#ff2bd6');

  ctx.save();
  ctx.beginPath();
  ctx.arc(0, 0, planetR, 0, Math.PI * 2);
  ctx.fillStyle = planetGrad;
  ctx.fill();
  ctx.clip();

  // Horizontal retro-synth planet latitude bands
  for (let b = -4; b <= 5; b++) {
    ctx.fillStyle =
      b % 2 === 0 ? 'rgba(0, 240, 255, 0.14)' : 'rgba(255, 43, 214, 0.16)';
    ctx.fillRect(-planetR, b * planetR * 0.18, planetR * 2, planetR * 0.08);
  }
  ctx.restore();

  // Tilted luminous planetary rings
  ctx.save();
  ctx.rotate(-0.26);
  ctx.strokeStyle = 'rgba(0, 240, 255, 0.78)';
  ctx.lineWidth = s(0.08);
  ctx.beginPath();
  ctx.ellipse(0, 0, s(2.18), s(0.46), 0, -0.15, Math.PI + 0.15);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(255, 43, 214, 0.65)';
  ctx.lineWidth = s(0.045);
  ctx.beginPath();
  ctx.ellipse(0, 0, s(2.42), s(0.56), 0, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(255, 208, 77, 0.55)';
  ctx.lineWidth = s(0.028);
  ctx.beginPath();
  ctx.ellipse(0, 0, s(1.88), s(0.36), 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  // Chrome diamond shield crest framing the title
  ctx.beginPath();
  ctx.moveTo(0, -s(1.18));
  ctx.lineTo(s(2.45), -s(0.42));
  ctx.lineTo(s(2.05), s(0.56));
  ctx.lineTo(0, s(1.05));
  ctx.lineTo(-s(2.05), s(0.56));
  ctx.lineTo(-s(2.45), -s(0.42));
  ctx.closePath();
  ctx.strokeStyle = 'rgba(190, 238, 255, 0.58)';
  ctx.lineWidth = s(0.042);
  ctx.stroke();
  ctx.restore();

  // Hero metallic-gradient HYPERNOVA arcade typography cleanly framed between super_jackpot, pf_2x & bonus_3x
  drawChromeText(ctx, 'HYPERNOVA', heroX, py(1.36), s(0.60), {
    italic: true,
    accentColor: PALETTE_CSS.cyan,
    glowColor: PALETTE_CSS.magenta,
    strokeWidth: s(0.065),
  });

  // Glowing chrome subtitle bar & energy chevron
  drawLaneLabel(ctx, 'STAR CORE PINBALL', heroX, py(2.18), s(0.185), PALETTE_CSS.amberBright, 0, true);

  // Bonus Multiplier arch graphics framing bonus_2x .. bonus_6x
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 155, 26, 0.45)';
  ctx.lineWidth = s(0.055);
  ctx.beginPath();
  ctx.arc(px(ACTIVE_CENTER_X), py(4.55), s(1.42), Math.PI * 1.15, Math.PI * 1.85);
  ctx.stroke();
  ctx.restore();
  drawLaneLabel(ctx, 'BONUS X', px(ACTIVE_CENTER_X), py(4.76), s(0.19), PALETTE_CSS.amber, 0, false);

  // =========================================================================
  // 7. SLINGSHOTS, INLANES, OUTLANES, KICKBACK & SHOOTER LANE HAZARD STRIPES
  // =========================================================================
  // Translucent neon deck panels underneath twin slingshots
  for (const sling of SLINGSHOTS) {
    const col = hexToCss(sling.color);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(px(sling.vertices[0].x), py(sling.vertices[0].z));
    ctx.lineTo(px(sling.vertices[1].x), py(sling.vertices[1].z));
    ctx.lineTo(px(sling.vertices[2].x), py(sling.vertices[2].z));
    ctx.closePath();
    ctx.fillStyle = hexToCss(sling.color, 0.18);
    ctx.fill();
    ctx.strokeStyle = col;
    ctx.lineWidth = s(0.055);
    ctx.stroke();

    // Active kicker edge neon highlight
    ctx.beginPath();
    ctx.moveTo(px(sling.activeEdge[0].x), py(sling.activeEdge[0].z));
    ctx.lineTo(px(sling.activeEdge[1].x), py(sling.activeEdge[1].z));
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = s(0.035);
    ctx.stroke();
    ctx.restore();
  }

  // Left Outlane: SHIELD KICKBACK hazard chevrons
  drawHazardStripes(
    ctx,
    px(-5.16),
    py(6.0),
    s(0.84),
    s(1.55),
    'rgba(0, 255, 157, 0.78)',
    'rgba(8, 18, 28, 0.92)',
    s(0.16),
    -35,
  );
  ctx.save();
  ctx.strokeStyle = PALETTE_CSS.emerald;
  ctx.lineWidth = s(0.045);
  ctx.strokeRect(px(-5.14), py(6.0), s(0.8), s(1.55));
  ctx.restore();
  drawLaneLabel(ctx, 'SHIELD', px(KICKBACK.position.x), py(4.56), s(0.2), PALETTE_CSS.emerald, 0, true);

  // Right Outlane subtle crimson warning stripes
  drawHazardStripes(
    ctx,
    px(3.32),
    py(6.0),
    s(0.76),
    s(1.45),
    'rgba(255, 38, 68, 0.55)',
    'rgba(16, 8, 22, 0.9)',
    s(0.16),
    35,
  );
  ctx.save();
  ctx.strokeStyle = PALETTE_CSS.crimson;
  ctx.lineWidth = s(0.04);
  ctx.strokeRect(px(3.32), py(6.0), s(0.76), s(1.45));
  ctx.restore();

  // Left & Right Inlane glowing feed chevrons leading onto the flippers
  const drawInlaneFeed = (laneX: number, targetFlipperX: number): void => {
    ctx.save();
    ctx.strokeStyle = 'rgba(0, 240, 255, 0.55)';
    ctx.lineWidth = s(0.05);
    for (let z = 4.35; z <= 6.2; z += 0.62) {
      ctx.beginPath();
      ctx.moveTo(px(laneX - 0.22), py(z));
      ctx.lineTo(px(laneX), py(z + 0.24));
      ctx.lineTo(px(laneX + 0.22), py(z));
      ctx.stroke();
    }
    // Guide line sloping onto flipper
    ctx.strokeStyle = 'rgba(0, 240, 255, 0.35)';
    ctx.lineWidth = s(0.07);
    ctx.beginPath();
    ctx.moveTo(px(laneX), py(6.65));
    ctx.lineTo(px(targetFlipperX), py(7.72));
    ctx.stroke();
    ctx.restore();
  };
  drawInlaneFeed(-3.7, -2.55);
  drawInlaneFeed(2.65, 1.5);

  // HYPER SAVE wing emblem above drain gap
  ctx.save();
  const hsX = px(ACTIVE_CENTER_X);
  const hsY = py(6.65);
  ctx.strokeStyle = 'rgba(255, 38, 68, 0.65)';
  ctx.lineWidth = s(0.045);
  ctx.beginPath();
  ctx.moveTo(hsX - s(1.2), hsY - s(0.18));
  ctx.lineTo(hsX - s(0.58), hsY);
  ctx.lineTo(hsX - s(1.02), hsY + s(0.24));
  ctx.moveTo(hsX + s(1.2), hsY - s(0.18));
  ctx.lineTo(hsX + s(0.58), hsY);
  ctx.lineTo(hsX + s(1.02), hsY + s(0.24));
  ctx.stroke();
  ctx.restore();
  drawLaneLabel(ctx, 'HYPER SAVE', px(ACTIVE_CENTER_X), py(7.35), s(0.22), PALETTE_CSS.crimson, 0, true);

  // Flipper arc motion sweeps subtly silkscreened on deck
  ctx.save();
  ctx.strokeStyle = 'rgba(0, 240, 255, 0.22)';
  ctx.lineWidth = s(0.035);
  ctx.setLineDash([s(0.15), s(0.12)]);
  for (const fl of FLIPPERS) {
    const fx = px(fl.pivot.x);
    const fy = py(fl.pivot.z);
    ctx.beginPath();
    ctx.arc(fx, fy, s(fl.length), 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.restore();

  // Shooter Lane background, hazard stripes & launch power calibration gauge
  ctx.save();
  const slX = px(SHOOTER_LANE_MIN_X);
  const slW = px(SHOOTER_LANE_MAX_X) - slX;
  const slGrad = ctx.createLinearGradient(slX, 0, slX + slW, 0);
  slGrad.addColorStop(0.0, '#070b1a');
  slGrad.addColorStop(0.5, '#101833');
  slGrad.addColorStop(1.0, '#060916');
  ctx.fillStyle = slGrad;
  ctx.fillRect(slX, py(-5.4), slW, py(10.6) - py(-5.4));

  // Shooter launch hazard stripes at bottom
  drawHazardStripes(
    ctx,
    slX + s(0.04),
    py(8.1),
    slW - s(0.08),
    py(10.5) - py(8.1),
    'rgba(255, 155, 26, 0.85)',
    'rgba(10, 12, 22, 0.94)',
    s(0.18),
    -45,
  );
  ctx.strokeStyle = PALETTE_CSS.amber;
  ctx.lineWidth = s(0.04);
  ctx.strokeRect(slX + s(0.04), py(8.1), slW - s(0.08), py(10.5) - py(8.1));

  // Power gauge ruler ticks ascending the shooter lane
  const slMidX = px(SHOOTER_LANE_CENTER_X);
  for (let gz = 7.4; gz >= -3.8; gz -= 0.4) {
    const major = Math.abs(Math.round(gz) - gz) < 0.05;
    const tickW = s(major ? 0.28 : 0.14);
    ctx.strokeStyle = gz < 0 ? 'rgba(255, 43, 214, 0.65)' : 'rgba(0, 240, 255, 0.58)';
    ctx.lineWidth = s(major ? 0.036 : 0.02);
    ctx.beginPath();
    ctx.moveTo(slMidX - tickW, py(gz));
    ctx.lineTo(slMidX + tickW, py(gz));
    ctx.stroke();
  }
  // Launch upward chevrons in shooter lane
  ctx.strokeStyle = PALETTE_CSS.cyan;
  ctx.lineWidth = s(0.045);
  for (let cz = 6.8; cz >= 0.5; cz -= 1.6) {
    ctx.beginPath();
    ctx.moveTo(slMidX - s(0.2), py(cz));
    ctx.lineTo(slMidX, py(cz - 0.28));
    ctx.lineTo(slMidX + s(0.2), py(cz));
    ctx.stroke();
  }
  ctx.restore();
  drawLaneLabel(ctx, 'LAUNCH', slMidX, py(7.72), s(0.17), PALETTE_CSS.amber, 0, true);

  // Subtle metallic lower apron dark backing triangles (behind apron walls)
  ctx.save();
  ctx.fillStyle = '#080c18';
  ctx.beginPath();
  ctx.moveTo(px(-5.2), py(7.9));
  ctx.lineTo(px(-1.25), py(10.23));
  ctx.lineTo(px(-1.25), py(10.6));
  ctx.lineTo(px(-5.2), py(10.6));
  ctx.closePath();
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(px(4.15), py(7.9));
  ctx.lineTo(px(0.2), py(10.23));
  ctx.lineTo(px(0.2), py(10.6));
  ctx.lineTo(px(4.15), py(10.6));
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // =========================================================================
  // 8. LED INSERT BEZELS ON ALBEDO (ALIGNED TO 0.68 * size -> 0.64 lens / 0.74 bezel)
  // =========================================================================
  for (const ins of LED_INSERTS) {
    // Skip elevated ramp chase LEDs — those live on the acrylic ramp above the deck
    if (ins.y !== undefined && ins.y > 0.05) continue;

    const ix = px(ins.position.x);
    const iy = py(ins.position.z);
    const radPx = s(ins.size * 0.68);

    // Outer recessed bezel dark ring + subtle color halo (matches 3D bezel ~0.74 * size)
    traceInsertPath(ctx, ix, iy, ins.shape, radPx * 1.1, ins.rotation);
    ctx.fillStyle = '#050814';
    ctx.fill();
    ctx.strokeStyle = hexToCss(ins.color, 0.72);
    ctx.lineWidth = Math.max(2, s(0.032));
    ctx.stroke();

    // Inner muted acrylic tint matching 3D lens (~0.64 * size)
    traceInsertPath(ctx, ix, iy, ins.shape, radPx * 0.94, ins.rotation);
    ctx.fillStyle = hexToCss(ins.color, 0.22);
    ctx.fill();

    // 3D inserts render crisp backlit stencils (compact emblems on star lenses);
    // silkscreen clean non-overlapping deck callouts beneath upper cross-shot arrows
    // and beneath the JACKPOT, SUPER JACKPOT, and EXTRA BALL star inserts.
    const starDeckLabel =
      ins.lampId === 'jackpot'
        ? { text: 'JACKPOT', offsetZ: 0.43, fontSize: 0.145, color: PALETTE_CSS.gold }
        : ins.lampId === 'super_jackpot'
          ? { text: 'SUPER JACKPOT', offsetZ: 0.51, fontSize: 0.145, color: PALETTE_CSS.magenta }
          : ins.lampId === 'extra_ball'
            ? { text: 'EXTRA BALL', offsetZ: 0.57, fontSize: 0.155, color: PALETTE_CSS.amber }
            : null;

    if (starDeckLabel) {
      drawLaneLabel(
        ctx,
        starDeckLabel.text,
        ix,
        py(ins.position.z + starDeckLabel.offsetZ),
        s(starDeckLabel.fontSize),
        starDeckLabel.color,
        0,
        false,
      );
    } else if (
      ins.label &&
      ins.shape === 'arrow' &&
      (ins.lampId === 'arrow_upper_ramp' || ins.lampId === 'arrow_upper_drop')
    ) {
      ctx.save();
      const fontPx = s(0.145);
      ctx.font = `900 ${fontPx}px "Arial Black", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#eef8ff';
      ctx.strokeStyle = '#04060f';
      ctx.lineWidth = Math.max(2, fontPx * 0.22);
      ctx.strokeText(ins.label, ix, iy + radPx * 1.25);
      ctx.fillText(ins.label, ix, iy + radPx * 1.25);
      ctx.restore();
    }
  }

  // Subtle clearcoat edge bevel border around active playfield perimeter
  ctx.save();
  ctx.strokeStyle = 'rgba(0, 240, 255, 0.24)';
  ctx.lineWidth = s(0.06);
  ctx.strokeRect(s(0.05), s(0.05), width - s(0.1), height - s(0.1));
  ctx.restore();

  // =========================================================================
  // 9. ROUGHNESS MAP (GLOSSY LACQUER ~0.20, SATIN TRIM ~0.34, LENSES ~0.10)
  // =========================================================================
  // Base lacquered maple deck (~0.20 => 52/255) for rich sheen without mirror glare
  rCtx.fillStyle = 'rgb(52, 52, 52)';
  rCtx.fillRect(0, 0, width, height);

  // Subtle vertical wood-grain lacquer micro-sheen variation
  rCtx.save();
  for (let i = 0; i < 180; i++) {
    const gx = rng() * width;
    const gw = (4 + rng() * 18) * clampedScale;
    const val = Math.round(46 + rng() * 14);
    rCtx.fillStyle = `rgba(${val}, ${val}, ${val}, 0.28)`;
    rCtx.fillRect(gx, 0, gw, height);
  }
  rCtx.restore();

  // Slightly satin finish in shooter lane & hazard zones (~0.32 => 82/255)
  rCtx.fillStyle = 'rgb(82, 82, 82)';
  rCtx.fillRect(slX, py(-5.4), slW, py(10.6) - py(-5.4));
  rCtx.fillRect(px(-5.16), py(6.0), s(0.84), s(1.55));
  rCtx.fillRect(px(3.32), py(6.0), s(0.76), s(1.45));

  // Satin mounting plates under bumpers, slingshots, posts & saucer ring
  rCtx.fillStyle = 'rgb(96, 96, 96)';
  for (const bumper of POP_BUMPERS) {
    rCtx.beginPath();
    rCtx.arc(px(bumper.position.x), py(bumper.position.z), s(bumper.radius * 1.35), 0, Math.PI * 2);
    rCtx.fill();
  }
  for (const post of RUBBER_POSTS) {
    rCtx.beginPath();
    rCtx.arc(px(post.position.x), py(post.position.z), s(post.radius * 1.9), 0, Math.PI * 2);
    rCtx.fill();
  }
  rCtx.beginPath();
  rCtx.arc(hcX, hcY, s(0.76), 0, Math.PI * 2);
  rCtx.fill();

  // Smooth acrylic LED insert lenses (~0.10 => 26/255) with satin rim (~0.38 => 98)
  for (const ins of LED_INSERTS) {
    if (ins.y !== undefined && ins.y > 0.05) continue;
    const ix = px(ins.position.x);
    const iy = py(ins.position.z);
    const radPx = s(ins.size * 0.68);

    traceInsertPath(rCtx, ix, iy, ins.shape, radPx * 1.1, ins.rotation);
    rCtx.strokeStyle = 'rgb(98, 98, 98)';
    rCtx.lineWidth = Math.max(2, s(0.05));
    rCtx.stroke();

    traceInsertPath(rCtx, ix, iy, ins.shape, radPx * 0.94, ins.rotation);
    rCtx.fillStyle = 'rgb(26, 26, 26)';
    rCtx.fill();
  }

  // =========================================================================
  // 10. BUMP MAP (RECESSED INSERT GROOVES, MOUNTING PLATES & PANEL SEAMS)
  // =========================================================================
  bCtx.fillStyle = 'rgb(128, 128, 128)';
  bCtx.fillRect(0, 0, width, height);

  // Subtle recessed groove along shooter divider seam & wall paths
  bCtx.save();
  bCtx.strokeStyle = 'rgb(96, 96, 96)';
  bCtx.lineWidth = s(0.06);
  for (const wall of TABLE_LAYOUT.walls) {
    if (wall.id === 'outer_perimeter' || wall.id === 'bottom_backstop') continue;
    if (wall.points.length < 2) continue;
    bCtx.beginPath();
    const first: Vec2 = wall.points[0];
    bCtx.moveTo(px(first.x), py(first.z));
    for (let i = 1; i < wall.points.length; i++) {
      bCtx.lineTo(px(wall.points[i].x), py(wall.points[i].z));
    }
    bCtx.stroke();
  }
  bCtx.restore();

  // Recessed circular grooves & mounting collars for bumpers, saucer, flippers & posts
  for (const bumper of POP_BUMPERS) {
    const bx = px(bumper.position.x);
    const by = py(bumper.position.z);
    bCtx.beginPath();
    bCtx.arc(bx, by, s(bumper.radius * 1.12), 0, Math.PI * 2);
    bCtx.strokeStyle = 'rgb(72, 72, 72)';
    bCtx.lineWidth = s(0.055);
    bCtx.stroke();

    bCtx.beginPath();
    bCtx.arc(bx, by, s(bumper.radius * 1.24), 0, Math.PI * 2);
    bCtx.strokeStyle = 'rgb(165, 165, 165)';
    bCtx.lineWidth = s(0.03);
    bCtx.stroke();
  }

  // Hypercore saucer recessed dish
  const hcBumpGrad = bCtx.createRadialGradient(hcX, hcY, s(0.1), hcX, hcY, s(0.65));
  hcBumpGrad.addColorStop(0.0, 'rgb(42, 42, 42)');
  hcBumpGrad.addColorStop(0.75, 'rgb(88, 88, 88)');
  hcBumpGrad.addColorStop(0.92, 'rgb(172, 172, 172)');
  hcBumpGrad.addColorStop(1.0, 'rgb(128, 128, 128)');
  bCtx.fillStyle = hcBumpGrad;
  bCtx.beginPath();
  bCtx.arc(hcX, hcY, s(0.65), 0, Math.PI * 2);
  bCtx.fill();

  // Flipper pivot bushing rings
  for (const fl of FLIPPERS) {
    const fx = px(fl.pivot.x);
    const fy = py(fl.pivot.z);
    bCtx.beginPath();
    bCtx.arc(fx, fy, s(fl.baseRadius * 1.15), 0, Math.PI * 2);
    bCtx.strokeStyle = 'rgb(82, 82, 82)';
    bCtx.lineWidth = s(0.045);
    bCtx.stroke();
  }

  // Post mounting washers
  for (const post of RUBBER_POSTS) {
    const ptx = px(post.position.x);
    const pty = py(post.position.z);
    bCtx.beginPath();
    bCtx.arc(ptx, pty, s(post.radius * 1.4), 0, Math.PI * 2);
    bCtx.fillStyle = 'rgb(152, 152, 152)';
    bCtx.fill();
    bCtx.strokeStyle = 'rgb(80, 80, 80)';
    bCtx.lineWidth = s(0.03);
    bCtx.stroke();
  }

  // Recessed LED insert bezels (dark trench + slightly raised clear edge, aligned to 0.68 * size)
  for (const ins of LED_INSERTS) {
    if (ins.y !== undefined && ins.y > 0.05) continue;
    const ix = px(ins.position.x);
    const iy = py(ins.position.z);
    const radPx = s(ins.size * 0.68);

    traceInsertPath(bCtx, ix, iy, ins.shape, radPx * 1.1, ins.rotation);
    bCtx.strokeStyle = 'rgb(64, 64, 64)';
    bCtx.lineWidth = Math.max(2, s(0.055));
    bCtx.stroke();

    traceInsertPath(bCtx, ix, iy, ins.shape, radPx * 0.94, ins.rotation);
    bCtx.fillStyle = 'rgb(138, 138, 138)';
    bCtx.fill();
  }

  // =========================================================================
  // 11. BUILD THREE.JS TEXTURES
  // =========================================================================
  const map = new THREE.CanvasTexture(albedoCanvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;
  map.wrapS = THREE.ClampToEdgeWrapping;
  map.wrapT = THREE.ClampToEdgeWrapping;
  map.needsUpdate = true;

  const roughnessMap = new THREE.CanvasTexture(roughCanvas);
  roughnessMap.colorSpace = THREE.NoColorSpace;
  roughnessMap.anisotropy = 4;
  roughnessMap.wrapS = THREE.ClampToEdgeWrapping;
  roughnessMap.wrapT = THREE.ClampToEdgeWrapping;
  roughnessMap.needsUpdate = true;

  const bumpMap = new THREE.CanvasTexture(bumpCanvas);
  bumpMap.colorSpace = THREE.NoColorSpace;
  bumpMap.anisotropy = 4;
  bumpMap.wrapS = THREE.ClampToEdgeWrapping;
  bumpMap.wrapT = THREE.ClampToEdgeWrapping;
  bumpMap.needsUpdate = true;

  return {
    map,
    roughnessMap,
    bumpMap,
    dispose() {
      map.dispose();
      roughnessMap.dispose();
      bumpMap.dispose();
    },
  };
}
