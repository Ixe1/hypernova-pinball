/**
 * HYPERNOVA — Procedural 1024x1024 Backbox Translite Artwork
 *
 * Generates the illuminated 1990s cosmic sci-fi arcade marquee translite
 * mounted in the upright cabinet backbox:
 *   - Swirling magenta / cyan / plasma-violet nebula & starfield
 *   - Dramatic ringed gas giant planet with luminous crescent atmosphere
 *   - Sleek chrome 90s arcade starfighter streaking across the horizon
 *   - Iconic chrome-beveled & neon-rimmed HYPERNOVA marquee typography
 */

import * as THREE from 'three';
import { PALETTE_CSS } from '../config/constants';

const TRANSLITE_SIZE = 1024;

function createRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function drawStarburst(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  color: string,
  spikeCount = 4,
): void {
  ctx.save();
  ctx.translate(x, y);

  // Soft radial bloom halo
  const halo = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
  halo.addColorStop(0.0, '#ffffff');
  halo.addColorStop(0.18, color);
  halo.addColorStop(0.55, 'rgba(0, 240, 255, 0.16)');
  halo.addColorStop(1.0, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.fill();

  // Razor-sharp diffraction spikes
  ctx.globalCompositeOperation = 'screen';
  for (let i = 0; i < spikeCount; i++) {
    const angle = (i * Math.PI) / spikeCount;
    const len = i < 2 ? radius * 1.45 : radius * 0.82;
    const w = Math.max(2, radius * 0.045);

    ctx.save();
    ctx.rotate(angle);
    const g = ctx.createLinearGradient(-len, 0, len, 0);
    g.addColorStop(0.0, 'rgba(255, 255, 255, 0)');
    g.addColorStop(0.45, color);
    g.addColorStop(0.5, '#ffffff');
    g.addColorStop(0.55, color);
    g.addColorStop(1.0, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(-len, 0);
    ctx.lineTo(0, -w);
    ctx.lineTo(len, 0);
    ctx.lineTo(0, w);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

function drawStarship(ctx: CanvasRenderingContext2D, cx: number, cy: number, scale: number): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-0.34);
  ctx.scale(scale, scale);

  // Twin blazing ion afterburner trails stretching behind the ship
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  const drawPlume = (py: number, len: number, width: number, innerCol: string, outerCol: string): void => {
    const plume = ctx.createLinearGradient(-40, py, -40 - len, py);
    plume.addColorStop(0.0, '#ffffff');
    plume.addColorStop(0.16, innerCol);
    plume.addColorStop(0.55, outerCol);
    plume.addColorStop(1.0, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = plume;
    ctx.beginPath();
    ctx.moveTo(-36, py - width * 0.45);
    ctx.lineTo(-40 - len, py);
    ctx.lineTo(-36, py + width * 0.45);
    ctx.closePath();
    ctx.fill();
  };
  drawPlume(-20, 380, 26, '#90fbff', 'rgba(0, 240, 255, 0.38)');
  drawPlume(20, 380, 26, '#90fbff', 'rgba(0, 240, 255, 0.38)');
  drawPlume(0, 440, 38, '#ffe28c', 'rgba(255, 43, 214, 0.34)');
  ctx.restore();

  // Outer swept delta wings (dark gunmetal + magenta neon trim)
  const wingGrad = ctx.createLinearGradient(0, -95, 0, 95);
  wingGrad.addColorStop(0.0, '#d8f4ff');
  wingGrad.addColorStop(0.28, '#3b589c');
  wingGrad.addColorStop(0.5, '#0b122b');
  wingGrad.addColorStop(0.72, '#62288f');
  wingGrad.addColorStop(1.0, '#ff8be9');

  ctx.beginPath();
  ctx.moveTo(95, 0);
  ctx.lineTo(-10, -28);
  ctx.lineTo(-78, -94);
  ctx.lineTo(-92, -84);
  ctx.lineTo(-56, -24);
  ctx.lineTo(-72, -16);
  ctx.lineTo(-72, 16);
  ctx.lineTo(-56, 24);
  ctx.lineTo(-92, 84);
  ctx.lineTo(-78, 94);
  ctx.lineTo(-10, 28);
  ctx.closePath();
  ctx.fillStyle = wingGrad;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#9ef8ff';
  ctx.stroke();

  // Wing accent laser stripes
  ctx.strokeStyle = PALETTE_CSS.magenta;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(-14, -30);
  ctx.lineTo(-76, -86);
  ctx.moveTo(-14, 30);
  ctx.lineTo(-76, 86);
  ctx.stroke();

  // Sleek central chrome needle fuselage
  const hullGrad = ctx.createLinearGradient(0, -26, 0, 26);
  hullGrad.addColorStop(0.0, '#ffffff');
  hullGrad.addColorStop(0.35, '#86e9ff');
  hullGrad.addColorStop(0.52, '#131d46');
  hullGrad.addColorStop(0.75, '#7e48d8');
  hullGrad.addColorStop(1.0, '#f0d8ff');

  ctx.beginPath();
  ctx.moveTo(156, 0);
  ctx.quadraticCurveTo(82, -26, -54, -22);
  ctx.lineTo(-64, 0);
  ctx.lineTo(-54, 22);
  ctx.quadraticCurveTo(82, 26, 156, 0);
  ctx.closePath();
  ctx.fillStyle = hullGrad;
  ctx.fill();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = '#e8faff';
  ctx.stroke();

  // Glowing golden-cyan bubble cockpit canopy
  const canopyGrad = ctx.createLinearGradient(25, -12, 25, 12);
  canopyGrad.addColorStop(0.0, '#fff7c2');
  canopyGrad.addColorStop(0.45, '#ff9b1a');
  canopyGrad.addColorStop(0.85, '#ff2bd6');
  canopyGrad.addColorStop(1.0, '#3a0b48');
  ctx.beginPath();
  ctx.ellipse(38, 0, 40, 11, 0, 0, Math.PI * 2);
  ctx.fillStyle = canopyGrad;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();

  // Canopy glare streak
  ctx.fillStyle = 'rgba(255, 255, 255, 0.82)';
  ctx.beginPath();
  ctx.ellipse(48, -4, 18, 3, -0.05, 0, Math.PI * 2);
  ctx.fill();

  // Twin engine nozzles
  ctx.fillStyle = '#090e22';
  ctx.strokeStyle = PALETTE_CSS.cyan;
  ctx.lineWidth = 2.5;
  ctx.fillRect(-68, -26, 18, 12);
  ctx.strokeRect(-68, -26, 18, 12);
  ctx.fillRect(-68, 14, 18, 12);
  ctx.strokeRect(-68, 14, 18, 12);

  // Nose specular glint
  drawStarburst(ctx, 154, 0, 26, PALETTE_CSS.cyan, 4);
  ctx.restore();
}

function drawBackboxTitle(ctx: CanvasRenderingContext2D, cx: number, cy: number): void {
  ctx.save();

  // Dynamic neon winged crest behind the title
  ctx.save();
  ctx.translate(cx, cy + 8);
  const crestGrad = ctx.createLinearGradient(-430, 0, 430, 0);
  crestGrad.addColorStop(0.0, 'rgba(0, 240, 255, 0.0)');
  crestGrad.addColorStop(0.18, 'rgba(0, 240, 255, 0.45)');
  crestGrad.addColorStop(0.5, 'rgba(255, 43, 214, 0.62)');
  crestGrad.addColorStop(0.82, 'rgba(0, 240, 255, 0.45)');
  crestGrad.addColorStop(1.0, 'rgba(0, 240, 255, 0.0)');

  ctx.beginPath();
  ctx.moveTo(-455, -18);
  ctx.lineTo(-340, -64);
  ctx.lineTo(340, -64);
  ctx.lineTo(455, -18);
  ctx.lineTo(395, 58);
  ctx.lineTo(-395, 58);
  ctx.closePath();
  ctx.fillStyle = 'rgba(7, 10, 30, 0.72)';
  ctx.fill();
  ctx.lineWidth = 5;
  ctx.strokeStyle = crestGrad;
  ctx.stroke();

  // Speed bars flanking the crest
  ctx.fillStyle = PALETTE_CSS.cyan;
  ctx.fillRect(-425, -4, 48, 5);
  ctx.fillRect(377, -4, 48, 5);
  ctx.fillStyle = PALETTE_CSS.magenta;
  ctx.fillRect(-405, 10, 36, 4);
  ctx.fillRect(369, 10, 36, 4);
  ctx.restore();

  const title = 'HYPERNOVA';
  ctx.font = 'italic 900 132px "Impact", "Arial Black", "Orbitron", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Extruded 3D chrome bevel shadow layers
  for (let i = 10; i >= 1; i--) {
    ctx.fillStyle = i > 5 ? '#1c0940' : '#4a1878';
    ctx.fillText(title, cx + i * 1.1, cy + i * 1.8);
  }

  // Intense magenta + cyan outer marquee neon glow
  ctx.shadowColor = PALETTE_CSS.magenta;
  ctx.shadowBlur = 44;
  ctx.lineWidth = 20;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = PALETTE_CSS.magenta;
  ctx.strokeText(title, cx, cy);

  ctx.shadowColor = PALETTE_CSS.cyan;
  ctx.shadowBlur = 20;
  ctx.lineWidth = 11;
  ctx.strokeStyle = '#070c22';
  ctx.strokeText(title, cx, cy);

  // Iconic 1990s retro chrome horizon reflection gradient
  ctx.shadowBlur = 0;
  const chromeGrad = ctx.createLinearGradient(cx, cy - 66, cx, cy + 66);
  chromeGrad.addColorStop(0.0, '#ffffff');
  chromeGrad.addColorStop(0.2, '#b3f9ff');
  chromeGrad.addColorStop(0.42, '#00e6ff');
  chromeGrad.addColorStop(0.49, '#081238');
  chromeGrad.addColorStop(0.55, '#3b1c7a');
  chromeGrad.addColorStop(0.72, '#ff3ed8');
  chromeGrad.addColorStop(0.88, '#ffd470');
  chromeGrad.addColorStop(1.0, '#ffffff');
  ctx.fillStyle = chromeGrad;
  ctx.fillText(title, cx, cy);

  // Crisp inner white specular bevel rim
  ctx.lineWidth = 2.6;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.86)';
  ctx.strokeText(title, cx, cy - 1.5);

  // Subtitle plate
  ctx.save();
  ctx.font = '900 28px "Arial Black", "Trebuchet MS", sans-serif';
  ctx.fillStyle = '#070c20';
  ctx.strokeStyle = PALETTE_CSS.amber;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.roundRect(cx - 210, cy + 68, 420, 42, 21);
  ctx.fill();
  ctx.stroke();

  ctx.shadowColor = PALETTE_CSS.amber;
  ctx.shadowBlur = 14;
  ctx.fillStyle = '#ffe596';
  ctx.fillText('★  COSMIC ARCADE PINBALL  ★', cx, cy + 90);
  ctx.restore();

  // Sparkle glints on marquee letters
  drawStarburst(ctx, cx - 320, cy - 42, 34, '#ffffff', 4);
  drawStarburst(ctx, cx + 62, cy - 48, 40, PALETTE_CSS.cyan, 4);
  drawStarburst(ctx, cx + 312, cy + 28, 30, PALETTE_CSS.magenta, 4);

  ctx.restore();
}

/**
 * Generates the procedural 1024x1024 backlit translite CanvasTexture for the backbox.
 */
export function createBackboxTransliteTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = TRANSLITE_SIZE;
  canvas.height = TRANSLITE_SIZE;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Failed to acquire 2D canvas context for backbox translite.');
  }

  const w = TRANSLITE_SIZE;
  const h = TRANSLITE_SIZE;
  const rng = createRng(0x905c_f177);

  // =========================================================================
  // 1. DEEP SPACE BACKDROP & SWIRLING MAGENTA / CYAN NEBULA
  // =========================================================================
  const skyGrad = ctx.createLinearGradient(0, 0, 0, h);
  skyGrad.addColorStop(0.0, '#040615');
  skyGrad.addColorStop(0.35, '#0b1033');
  skyGrad.addColorStop(0.68, '#170c3b');
  skyGrad.addColorStop(0.88, '#1d0d3a');
  skyGrad.addColorStop(1.0, '#07091a');
  ctx.fillStyle = skyGrad;
  ctx.fillRect(0, 0, w, h);

  // Swirling nebula blooms
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  const clouds: Array<[number, number, number, string, string]> = [
    [260, 340, 440, 'rgba(255, 43, 214, 0.44)', 'rgba(98, 22, 180, 0.16)'],
    [770, 420, 460, 'rgba(0, 240, 255, 0.40)', 'rgba(20, 68, 195, 0.15)'],
    [512, 540, 500, 'rgba(139, 61, 255, 0.36)', 'rgba(255, 43, 214, 0.14)'],
    [180, 740, 340, 'rgba(255, 155, 26, 0.28)', 'rgba(190, 24, 120, 0.10)'],
    [820, 760, 340, 'rgba(0, 240, 255, 0.28)', 'rgba(80, 28, 180, 0.10)'],
  ];
  for (const [cx, cy, r, c0, c1] of clouds) {
    const g = ctx.createRadialGradient(cx, cy, r * 0.05, cx, cy, r);
    g.addColorStop(0.0, c0);
    g.addColorStop(0.5, c1);
    g.addColorStop(1.0, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Dramatic supernova burst rays radiating from upper-right planet limb
  const burstX = 635;
  const burstY = 475;
  for (let i = 0; i < 36; i++) {
    const a = (i / 36) * Math.PI * 2;
    const len = i % 3 === 0 ? 580 : 380;
    const spread = i % 3 === 0 ? 0.036 : 0.02;
    const g = ctx.createRadialGradient(burstX, burstY, 30, burstX, burstY, len);
    g.addColorStop(0.0, i % 2 === 0 ? 'rgba(0, 240, 255, 0.30)' : 'rgba(255, 43, 214, 0.26)');
    g.addColorStop(0.6, 'rgba(139, 61, 255, 0.08)');
    g.addColorStop(1.0, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(burstX, burstY);
    ctx.lineTo(burstX + Math.cos(a - spread) * len, burstY + Math.sin(a - spread) * len);
    ctx.lineTo(burstX + Math.cos(a + spread) * len, burstY + Math.sin(a + spread) * len);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();

  // Crisp starfield
  for (let i = 0; i < 420; i++) {
    const sx = rng() * w;
    const sy = rng() * (h * 0.84);
    const m = rng();
    const r = 0.7 + m * m * 2.5;
    const col = m < 0.65 ? '#ffffff' : m < 0.82 ? '#9ff9ff' : m < 0.94 ? '#ffaef2' : '#ffe399';
    ctx.globalAlpha = 0.25 + m * 0.75;
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // =========================================================================
  // 2. DRAMATIC RINGED COSMIC PLANET
  // =========================================================================
  const planetX = 635;
  const planetY = 535;
  const planetR = 215;

  // Back half of planetary rings (drawn behind sphere)
  ctx.save();
  ctx.translate(planetX, planetY);
  ctx.rotate(-0.34);
  const drawRings = (frontHalf: boolean): void => {
    const startA = frontHalf ? 0 : Math.PI;
    const endA = frontHalf ? Math.PI : Math.PI * 2;
    const bands: Array<[number, number, string, number]> = [
      [395, 96, 'rgba(255, 43, 214, 0.52)', 16],
      [360, 86, 'rgba(0, 240, 255, 0.78)', 22],
      [325, 76, 'rgba(255, 208, 77, 0.56)', 10],
      [295, 68, 'rgba(139, 61, 255, 0.48)', 14],
    ];
    for (const [rx, ry, col, lw] of bands) {
      ctx.beginPath();
      ctx.ellipse(0, 0, rx, ry, 0, startA, endA);
      ctx.strokeStyle = col;
      ctx.lineWidth = lw;
      ctx.stroke();
    }
  };
  drawRings(false);
  ctx.restore();

  // Planet atmosphere outer glow
  ctx.save();
  const atmo = ctx.createRadialGradient(planetX, planetY, planetR * 0.82, planetX, planetY, planetR * 1.28);
  atmo.addColorStop(0.0, 'rgba(0, 240, 255, 0.55)');
  atmo.addColorStop(0.45, 'rgba(255, 43, 214, 0.24)');
  atmo.addColorStop(1.0, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = atmo;
  ctx.beginPath();
  ctx.arc(planetX, planetY, planetR * 1.28, 0, Math.PI * 2);
  ctx.fill();

  // Planet sphere body + atmospheric bands
  ctx.beginPath();
  ctx.arc(planetX, planetY, planetR, 0, Math.PI * 2);
  const bodyGrad = ctx.createRadialGradient(
    planetX - planetR * 0.42,
    planetY - planetR * 0.42,
    planetR * 0.1,
    planetX,
    planetY,
    planetR,
  );
  bodyGrad.addColorStop(0.0, '#c8fcff');
  bodyGrad.addColorStop(0.22, '#00c8ff');
  bodyGrad.addColorStop(0.54, '#3623a8');
  bodyGrad.addColorStop(0.82, '#220b4d');
  bodyGrad.addColorStop(1.0, '#070518');
  ctx.fillStyle = bodyGrad;
  ctx.fill();

  ctx.clip();
  ctx.save();
  ctx.translate(planetX, planetY);
  ctx.rotate(-0.34);
  for (let i = -6; i <= 6; i++) {
    const by = i * 32;
    const bandGrad = ctx.createLinearGradient(-planetR, by, planetR, by);
    bandGrad.addColorStop(0.0, 'rgba(0, 240, 255, 0.24)');
    bandGrad.addColorStop(0.45, i % 2 === 0 ? 'rgba(255, 43, 214, 0.26)' : 'rgba(139, 61, 255, 0.22)');
    bandGrad.addColorStop(1.0, 'rgba(8, 6, 24, 0.45)');
    ctx.fillStyle = bandGrad;
    ctx.fillRect(-planetR * 1.2, by, planetR * 2.4, 16);
  }
  ctx.restore();

  // Terminator shadow crescent on lower-right limb
  const shadowGrad = ctx.createRadialGradient(
    planetX + planetR * 0.48,
    planetY + planetR * 0.42,
    planetR * 0.25,
    planetX + planetR * 0.18,
    planetY + planetR * 0.18,
    planetR * 1.12,
  );
  shadowGrad.addColorStop(0.0, 'rgba(3, 4, 16, 0.88)');
  shadowGrad.addColorStop(0.55, 'rgba(6, 7, 26, 0.42)');
  shadowGrad.addColorStop(1.0, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = shadowGrad;
  ctx.fillRect(planetX - planetR, planetY - planetR, planetR * 2, planetR * 2);

  // Hot magenta rim bounce along bottom-right edge
  ctx.strokeStyle = 'rgba(255, 70, 224, 0.72)';
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.arc(planetX, planetY, planetR - 3, -0.2, Math.PI * 0.65);
  ctx.stroke();
  ctx.restore();

  // Front half of planetary rings overlapping planet
  ctx.save();
  ctx.translate(planetX, planetY);
  ctx.rotate(-0.34);
  drawRings(true);
  ctx.restore();

  // Secondary distant moon on upper-left
  ctx.save();
  const moonGrad = ctx.createRadialGradient(178, 412, 8, 195, 430, 56);
  moonGrad.addColorStop(0.0, '#ffe8aa');
  moonGrad.addColorStop(0.35, '#ff73d8');
  moonGrad.addColorStop(0.8, '#2b1256');
  moonGrad.addColorStop(1.0, '#09061b');
  ctx.fillStyle = moonGrad;
  ctx.beginPath();
  ctx.arc(195, 430, 54, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // =========================================================================
  // 3. RETRO 90s SYNTHWAVE PERSPECTIVE HORIZON GRID ALONG LOWER EDGE
  // =========================================================================
  const horizonY = 785;
  ctx.save();
  const floorGrad = ctx.createLinearGradient(0, horizonY, 0, h);
  floorGrad.addColorStop(0.0, 'rgba(255, 43, 214, 0.36)');
  floorGrad.addColorStop(0.2, 'rgba(38, 14, 86, 0.85)');
  floorGrad.addColorStop(1.0, '#050718');
  ctx.fillStyle = floorGrad;
  ctx.fillRect(0, horizonY, w, h - horizonY);

  // Glowing horizon bar
  ctx.strokeStyle = PALETTE_CSS.cyan;
  ctx.shadowColor = PALETTE_CSS.cyan;
  ctx.shadowBlur = 22;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(0, horizonY);
  ctx.lineTo(w, horizonY);
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Perspective grid lines
  ctx.strokeStyle = 'rgba(0, 240, 255, 0.42)';
  ctx.lineWidth = 2.2;
  const vanishX = w * 0.5;
  for (let i = -10; i <= 10; i++) {
    ctx.beginPath();
    ctx.moveTo(vanishX + i * 38, horizonY);
    ctx.lineTo(vanishX + i * 190, h);
    ctx.stroke();
  }
  for (let row = 1; row <= 8; row++) {
    const t = (row / 8) ** 1.85;
    const y = horizonY + t * (h - horizonY);
    ctx.strokeStyle = `rgba(255, 43, 214, ${(0.22 + t * 0.42).toFixed(2)})`;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  ctx.restore();

  // =========================================================================
  // 4. SLEEK CHROME STARSHIP STREAKING ACROSS THE HORIZON
  // =========================================================================
  drawStarship(ctx, 435, 675, 1.32);

  // Hero starburst highlights
  drawStarburst(ctx, 488, 375, 76, PALETTE_CSS.cyan, 6);
  drawStarburst(ctx, 845, 310, 52, PALETTE_CSS.magenta, 4);
  drawStarburst(ctx, 138, 608, 44, PALETTE_CSS.amberBright, 4);

  // =========================================================================
  // 5. HERO CHROME / NEON "HYPERNOVA" MARQUEE TYPOGRAPHY
  // =========================================================================
  drawBackboxTitle(ctx, w * 0.5, 185);

  // =========================================================================
  // 6. ARCADE TRANSLITE FRAME TRIM & SUBTLE BACKLIGHT VIGNETTE
  // =========================================================================
  // Subtle perimeter vignette like a real lightbox behind glass
  const vig = ctx.createRadialGradient(w * 0.5, h * 0.46, w * 0.25, w * 0.5, h * 0.5, w * 0.72);
  vig.addColorStop(0.0, 'rgba(255, 255, 255, 0.04)');
  vig.addColorStop(0.75, 'rgba(0, 0, 0, 0)');
  vig.addColorStop(1.0, 'rgba(2, 4, 14, 0.52)');
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, w, h);

  // Crisp inner chrome & neon marquee border
  ctx.save();
  ctx.strokeStyle = 'rgba(0, 240, 255, 0.72)';
  ctx.lineWidth = 6;
  ctx.strokeRect(20, 20, w - 40, h - 40);

  ctx.strokeStyle = 'rgba(255, 43, 214, 0.55)';
  ctx.lineWidth = 2.5;
  ctx.strokeRect(32, 32, w - 64, h - 64);

  // Corner tech brackets
  const cornerLen = 48;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 4;
  const corners: Array<[number, number, number, number]> = [
    [20, 20, 1, 1],
    [w - 20, 20, -1, 1],
    [20, h - 20, 1, -1],
    [w - 20, h - 20, -1, -1],
  ];
  for (const [cx, cy, dx, dy] of corners) {
    ctx.beginPath();
    ctx.moveTo(cx, cy + dy * cornerLen);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx + dx * cornerLen, cy);
    ctx.stroke();
  }
  ctx.restore();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}
