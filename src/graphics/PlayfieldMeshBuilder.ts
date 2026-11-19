/**
 * HYPERNOVA — Parametric 3D Playfield Mechanism & Geometry Builder
 *
 * Builds every physical mechanism directly from `TABLE_LAYOUT` in playfield-local
 * coordinates (Y = 0 wood surface, +X right, +Y up, +Z toward player):
 *   - Clear-coated playfield wood deck (exact UV alignment: Z=-10.6 top, Z=+10.6 bottom)
 *   - Sculpted anodized/chrome walls, parabolic arch, shooter divider, apron & one-way gate
 *   - 3 Pop Bumpers with animated solenoid kick collars & illuminated dome caps
 *   - 2 Triangular Slingshots with flexing rubber bands & translucent polycarbonate top caps
 *   - 3 Tapered Flippers (left, right, upperRight) with molded rubber bands & chrome hubs
 *   - 3 Retracting Drop Targets (R-A-Y) & 3 Right Standup Targets (2X/3X/5X)
 *   - 3 Top I-O-N Rollover Lanes & Left Orbit Dual-Sided Metal Spinner
 *   - Elevated Transparent Acrylic Warp Ramp + Dual-Rail Chrome Wireform Habitrail
 *   - 38 Recessed LED Inserts + 4 Flasher Domes driven smoothly by LampController
 *   - Pooled ultra-reflective liquid-chrome pinballs with grounded contact shadow decals
 */

import * as THREE from 'three';
import {
  BALL_RADIUS,
  MAX_BALLS,
  PALETTE,
  PLAYFIELD_LENGTH,
  PLAYFIELD_WIDTH,
} from '../config/constants';
import {
  DROP_TARGETS,
  FLASHER_LAMPS,
  FLIPPERS,
  HYPERCORE_SAUCER,
  KICKBACK,
  LED_INSERTS,
  ONE_WAY_GATE,
  POP_BUMPERS,
  ROLLOVER_LANES,
  RUBBER_POSTS,
  SLINGSHOTS,
  SPINNER,
  STANDUP_TARGETS,
  WALLS,
  WARP_RAMP,
  WIREFORM_RAIL,
  type FlipperDef,
  type InsertShape,
  type WallPolylineDef,
} from '../config/tableLayout';
import type { BallState, FlipperSide, LampId, LampState, Vec2 } from '../config/types';
import type { LampStateCollection } from './SceneManager';

export interface PlayfieldTextureBundle {
  readonly map: THREE.Texture;
  readonly roughnessMap: THREE.Texture;
  readonly bumpMap: THREE.Texture;
}

export interface PlayfieldVisuals {
  /** Playfield-local root group (mount inside CabinetRig.playfieldMount at origin). */
  readonly group: THREE.Group;
  /** Advances smooth visual animations (bumper kicks, slingshot flex, drop targets, standup recoil, gate). */
  update(dt: number): void;
  /** Syncs pooled chrome pinballs and grounded contact shadow blobs from physics state. */
  syncBalls(balls: readonly BallState[]): void;
  /** Updates flipper rotation around Y (accepts FlipperSide or flipper layout id). */
  setFlipperAngle(idOrSide: FlipperSide | string, angleRad: number): void;
  /** Animates left R-A-Y drop target (index 0..2) smoothly up or flush into the playfield deck. */
  setDropTargetDropped(index: number, dropped: boolean): void;
  /** Triggers impact recoil & flash on a right standup target (index 0..2). */
  triggerStandupHit(index: number): void;
  /** Rotates the left-orbit metal spinner blade around its horizontal wire axle. */
  setSpinnerAngle(angleRad: number): void;
  /** Triggers solenoid collar snap & dome flash on a pop bumper (index 0..2). */
  triggerBumperKick(index: number): void;
  /** Triggers slingshot active-rubber flex & lamp flash (index 0|1 or 'left'|'right'). */
  triggerSlingshotKick(indexOrSide: number | 'left' | 'right'): void;
  /** Triggers a brief swing deflection on the shooter-exit one-way wire gate. */
  triggerGateSwing(): void;
  /** Applies LampController emissive intensities & colors to all inserts, bumpers, slings, and flasher domes. */
  applyLamps(lampStates: LampStateCollection): void;
  /** Rebinds the playfield wood deck albedo, roughness, and bump textures at runtime (e.g. on quality change). */
  setPlayfieldTextures(bundle: PlayfieldTextureBundle): void;
  /** Disposes all geometries, materials, and internally generated procedural textures. */
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Geometry & Texture Utility Helpers
// ---------------------------------------------------------------------------

function readLamp(lamps: LampStateCollection, id: LampId): LampState | undefined {
  if (lamps instanceof Map) {
    return lamps.get(id);
  }
  return (lamps as Partial<Record<LampId, LampState>>)[id];
}

/** Ensures a 2D polygon in ShapeXY space has counter-clockwise winding (positive signed area). */
function ensureCCW(pts: THREE.Vector2[]): THREE.Vector2[] {
  let area2 = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    area2 += a.x * b.y - b.x * a.y;
  }
  if (area2 < 0) {
    pts.reverse();
  }
  return pts;
}

/**
 * Converts a playfield XZ polyline centerline into a closed CCW `THREE.Shape` in ShapeXY
 * (`sx = x, sy = -z`) so that extruding along +Z and rotating `rotation.x = -Math.PI / 2`
 * produces exact playfield-local XZ alignment with upward +Y extrusion!
 */
function buildPolylineShape(
  points: readonly Vec2[],
  halfWidth: number,
  roundedCaps: boolean,
): THREE.Shape {
  const n = points.length;
  const sp = points.map((p) => new THREE.Vector2(p.x, -p.z));

  const segNormals: THREE.Vector2[] = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = sp[i + 1].x - sp[i].x;
    const dy = sp[i + 1].y - sp[i].y;
    const len = Math.hypot(dx, dy) || 1;
    // Left-hand normal in ShapeXY
    segNormals.push(new THREE.Vector2(-dy / len, dx / len));
  }

  const leftPts: THREE.Vector2[] = [];
  const rightPts: THREE.Vector2[] = [];

  for (let i = 0; i < n; i++) {
    let nx: number;
    let ny: number;
    let scale = halfWidth;

    if (i === 0) {
      nx = segNormals[0].x;
      ny = segNormals[0].y;
    } else if (i === n - 1) {
      nx = segNormals[n - 2].x;
      ny = segNormals[n - 2].y;
    } else {
      const n0 = segNormals[i - 1];
      const n1 = segNormals[i];
      const bx = n0.x + n1.x;
      const by = n0.y + n1.y;
      const bLen = Math.hypot(bx, by);
      if (bLen < 1e-4) {
        nx = n0.x;
        ny = n0.y;
      } else {
        nx = bx / bLen;
        ny = by / bLen;
        const dot = Math.max(0.42, nx * n0.x + ny * n0.y);
        scale = Math.min(halfWidth * 2.1, halfWidth / dot);
      }
    }

    leftPts.push(new THREE.Vector2(sp[i].x + nx * scale, sp[i].y + ny * scale));
    rightPts.push(new THREE.Vector2(sp[i].x - nx * scale, sp[i].y - ny * scale));
  }

  // Assemble CCW outline: right side forward (0 -> n-1), optional end cap, left side back (n-1 -> 0), optional start cap
  const outline: THREE.Vector2[] = [];
  for (let i = 0; i < n; i++) {
    outline.push(rightPts[i]);
  }

  if (roundedCaps && n >= 2) {
    const endN = segNormals[n - 2];
    const startAng = Math.atan2(-endN.y, -endN.x);
    const arcSteps = 7;
    for (let k = 1; k < arcSteps; k++) {
      const ang = startAng + (Math.PI * k) / arcSteps;
      outline.push(
        new THREE.Vector2(
          sp[n - 1].x + Math.cos(ang) * halfWidth,
          sp[n - 1].y + Math.sin(ang) * halfWidth,
        ),
      );
    }
  }

  for (let i = n - 1; i >= 0; i--) {
    outline.push(leftPts[i]);
  }

  if (roundedCaps && n >= 2) {
    const startN = segNormals[0];
    const startAng = Math.atan2(startN.y, startN.x);
    const arcSteps = 7;
    for (let k = 1; k < arcSteps; k++) {
      const ang = startAng + (Math.PI * k) / arcSteps;
      outline.push(
        new THREE.Vector2(
          sp[0].x + Math.cos(ang) * halfWidth,
          sp[0].y + Math.sin(ang) * halfWidth,
        ),
      );
    }
  }

  ensureCCW(outline);
  const shape = new THREE.Shape();
  shape.moveTo(outline[0].x, outline[0].y);
  for (let i = 1; i < outline.length; i++) {
    shape.lineTo(outline[i].x, outline[i].y);
  }
  shape.closePath();
  return shape;
}

/** Builds a CCW tapered dual-circle flipper outline in ShapeXY around pivot (0, 0). */
function buildFlipperShape(
  length: number,
  baseRadius: number,
  tipRadius: number,
  direction: 1 | -1,
): THREE.Shape {
  const cosAlpha = Math.max(-0.99, Math.min(0.99, (baseRadius - tipRadius) / length));
  const alpha = Math.acos(cosAlpha);
  const pts: THREE.Vector2[] = [];

  const baseSteps = 18;
  const baseStart = alpha;
  const baseEnd = Math.PI * 2 - alpha;
  for (let i = 0; i <= baseSteps; i++) {
    const theta = baseStart + ((baseEnd - baseStart) * i) / baseSteps;
    pts.push(new THREE.Vector2(Math.cos(theta) * baseRadius, Math.sin(theta) * baseRadius));
  }

  const tipSteps = 14;
  const tipStart = -alpha;
  const tipEnd = alpha;
  for (let i = 0; i <= tipSteps; i++) {
    const theta = tipStart + ((tipEnd - tipStart) * i) / tipSteps;
    pts.push(
      new THREE.Vector2(
        length + Math.cos(theta) * tipRadius,
        Math.sin(theta) * tipRadius,
      ),
    );
  }

  if (direction === -1) {
    for (const p of pts) {
      p.x = -p.x;
    }
    pts.reverse();
  }

  ensureCCW(pts);
  const shape = new THREE.Shape();
  shape.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) {
    shape.lineTo(pts[i].x, pts[i].y);
  }
  shape.closePath();
  return shape;
}

/** Builds a centered 2D insert shape in ShapeXY (0 rad points toward +Y in ShapeXY => -Z on playfield). */
function buildInsertShape(kind: InsertShape, size: number): THREE.Shape {
  const s = new THREE.Shape();
  switch (kind) {
    case 'circle': {
      s.absarc(0, 0, size, 0, Math.PI * 2, false);
      return s;
    }
    case 'diamond': {
      const rx = size * 0.78;
      const ry = size * 1.1;
      s.moveTo(0, ry);
      s.lineTo(-rx, 0);
      s.lineTo(0, -ry);
      s.lineTo(rx, 0);
      s.closePath();
      return s;
    }
    case 'bar': {
      const hw = size * 0.42;
      const hh = size * 1.18;
      const r = hw * 0.7;
      s.moveTo(-hw + r, -hh);
      s.lineTo(hw - r, -hh);
      s.quadraticCurveTo(hw, -hh, hw, -hh + r);
      s.lineTo(hw, hh - r);
      s.quadraticCurveTo(hw, hh, hw - r, hh);
      s.lineTo(-hw + r, hh);
      s.quadraticCurveTo(-hw, hh, -hw, hh - r);
      s.lineTo(-hw, -hh + r);
      s.quadraticCurveTo(-hw, -hh, -hw + r, -hh);
      s.closePath();
      return s;
    }
    case 'arrow': {
      // Sleek tapered sci-fi triangular shot arrow pointing up (+Y -> -Z)
      const tipY = size * 1.25;
      const wingX = size * 0.82;
      const wingY = -size * 0.45;
      const tailX = size * 0.36;
      const tailY = -size * 1.02;
      s.moveTo(0, tipY);
      s.lineTo(-wingX, wingY);
      s.lineTo(-tailX, wingY + size * 0.14);
      s.lineTo(-tailX, tailY);
      s.lineTo(tailX, tailY);
      s.lineTo(tailX, wingY + size * 0.14);
      s.lineTo(wingX, wingY);
      s.closePath();
      return s;
    }
    case 'chevron': {
      const topY = size * 0.92;
      const wingX = size * 0.96;
      const outerBotY = -size * 0.45;
      const innerPeakY = size * 0.18;
      const innerBotY = -size * 0.88;
      s.moveTo(0, topY);
      s.lineTo(-wingX, outerBotY);
      s.lineTo(-wingX * 0.72, innerBotY);
      s.lineTo(0, innerPeakY);
      s.lineTo(wingX * 0.72, innerBotY);
      s.lineTo(wingX, outerBotY);
      s.closePath();
      return s;
    }
    case 'star': {
      const spikes = 5;
      const outerR = size * 1.12;
      const innerR = size * 0.48;
      for (let i = 0; i < spikes * 2; i++) {
        const r = i % 2 === 0 ? outerR : innerR;
        const angle = Math.PI / 2 + (i * Math.PI) / spikes;
        const x = Math.cos(angle) * r;
        const y = Math.sin(angle) * r;
        if (i === 0) s.moveTo(x, y);
        else s.lineTo(x, y);
      }
      s.closePath();
      return s;
    }
  }
}

/** Creates a procedural soft radial contact-shadow CanvasTexture for pinballs. */
function createContactShadowTexture(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const grad = ctx.createRadialGradient(64, 64, 6, 64, 64, 60);
  grad.addColorStop(0.0, 'rgba(2, 4, 12, 0.78)');
  grad.addColorStop(0.38, 'rgba(3, 5, 16, 0.48)');
  grad.addColorStop(0.7, 'rgba(4, 6, 18, 0.16)');
  grad.addColorStop(1.0, 'rgba(4, 6, 18, 0.0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);

  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

/** Creates a very fine brushed-metal micro-glint roughness texture so chrome ball spin is perceptible. */
function createBallMicroGlintTexture(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  // Base ultra-smooth mirror steel (roughness ~0.05 -> grayscale ~14)
  ctx.fillStyle = 'rgb(14, 14, 14)';
  ctx.fillRect(0, 0, 256, 256);

  // Subtle deterministic hairline polish streaks & micro speckles so spin catches overhead light
  let seed = 1337;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  for (let i = 0; i < 160; i++) {
    const x = rand() * 256;
    const y = rand() * 256;
    const len = 8 + rand() * 26;
    const ang = rand() * Math.PI * 2;
    const val = 24 + Math.floor(rand() * 34);
    ctx.strokeStyle = `rgba(${val},${val},${val},0.45)`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

/** Creates a crisp backlit graphic plate texture for drop targets, standups, spinner, or slingshot caps. */
function createTargetFaceTexture(
  label: string,
  accentHex: number,
  darkBgHex = '#101628',
): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const col = new THREE.Color(accentHex);
  const css = `#${col.getHexString()}`;

  ctx.fillStyle = darkBgHex;
  ctx.fillRect(0, 0, 128, 128);

  const grad = ctx.createRadialGradient(64, 64, 8, 64, 64, 72);
  grad.addColorStop(0, css);
  grad.addColorStop(0.7, css);
  grad.addColorStop(1, darkBgHex);
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = grad;
  ctx.fillRect(6, 6, 116, 116);
  ctx.globalAlpha = 1;

  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 5;
  ctx.strokeRect(8, 8, 112, 112);

  ctx.fillStyle = '#080c18';
  ctx.font = label.length > 1 ? 'bold 54px "Arial Black", sans-serif' : 'bold 74px "Arial Black", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, 64, 66);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Creates a futuristic printed translucent polycarbonate texture for slingshot top plastics. */
function createSlingshotPlasticTexture(accentHex: number): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const accent = `#${new THREE.Color(accentHex).getHexString()}`;
  const grad = ctx.createLinearGradient(0, 0, 256, 256);
  grad.addColorStop(0, '#0e1736');
  grad.addColorStop(0.5, '#1b1144');
  grad.addColorStop(1, '#091128');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 256, 256);

  // Diagonal sci-fi neon lightning chevrons
  ctx.strokeStyle = accent;
  ctx.lineWidth = 10;
  for (let i = -2; i < 8; i++) {
    const offset = i * 44;
    ctx.globalAlpha = i % 2 === 0 ? 0.85 : 0.35;
    ctx.beginPath();
    ctx.moveTo(offset, 0);
    ctx.lineTo(offset + 140, 256);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Metallic highlight hairline grid
  ctx.strokeStyle = 'rgba(230, 248, 255, 0.35)';
  ctx.lineWidth = 2;
  for (let p = 32; p < 256; p += 32) {
    ctx.beginPath();
    ctx.moveTo(0, p);
    ctx.lineTo(256, p);
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

/** Creates a dual-sided sci-fi chevron metallic decal texture for the left-orbit spinner blade. */
function createSpinnerBladeTexture(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const bg = ctx.createLinearGradient(0, 0, 256, 128);
  bg.addColorStop(0, '#c8d6eb');
  bg.addColorStop(0.5, '#f2f8ff');
  bg.addColorStop(1, '#9ab0cf');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 256, 128);

  // Cyan & magenta kinetic spin chevrons
  ctx.fillStyle = '#00d8f0';
  ctx.beginPath();
  ctx.moveTo(24, 18);
  ctx.lineTo(128, 18);
  ctx.lineTo(96, 110);
  ctx.lineTo(14, 110);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = '#ff2bd6';
  ctx.beginPath();
  ctx.moveTo(144, 18);
  ctx.lineTo(238, 18);
  ctx.lineTo(212, 110);
  ctx.lineTo(116, 110);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = '#080e1f';
  ctx.font = 'bold 46px "Arial Black", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('SPIN', 128, 66);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Builds a custom lofted channel BufferGeometry along a 3D CatmullRomCurve3:
 * rectangular floor deck (top surface EXACTLY at P(t)) + left & right vertical acrylic walls.
 */
function buildRampChannelGeometry(
  curve: THREE.CatmullRomCurve3,
  width: number,
  deckThickness: number,
  wallThickness: number,
  wallHeight: number,
  segments: number,
): THREE.BufferGeometry {
  const hw = width * 0.5;
  const ow = hw + wallThickness;

  // Cross-section profile in (right, normal) plane — 8 vertices forming a U-channel:
  // Outer-left top -> Outer-left bottom -> Outer-right bottom -> Outer-right top ->
  // Inner-right top -> Inner-right deck -> Inner-left deck -> Inner-left top
  const profile: readonly [number, number][] = [
    [-ow, wallHeight],
    [-ow, -deckThickness],
    [ow, -deckThickness],
    [ow, wallHeight],
    [hw, wallHeight],
    [hw, 0],
    [-hw, 0],
    [-hw, wallHeight],
  ];
  const pCount = profile.length;

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const up = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const pt = new THREE.Vector3();
  const tan = new THREE.Vector3();

  for (let i = 0; i <= segments; i++) {
    const u = i / segments;
    curve.getPointAt(u, pt);
    curve.getTangentAt(u, tan).normalize();

    // Horizontal right vector R = normalize(T x Up) (zero roll/twist along climbs)
    right.crossVectors(tan, up);
    if (right.lengthSq() < 1e-6) {
      right.set(1, 0, 0);
    } else {
      right.normalize();
    }
    // Deck normal N = normalize(R x T) (always points upward)
    normal.crossVectors(right, tan).normalize();

    for (let j = 0; j < pCount; j++) {
      const [rx, ny] = profile[j];
      const vx = pt.x + right.x * rx + normal.x * ny;
      const vy = pt.y + right.y * rx + normal.y * ny;
      const vz = pt.z + right.z * rx + normal.z * ny;
      positions.push(vx, vy, vz);
      uvs.push(j / pCount, u * 6);
    }
  }

  // Side/deck quads between consecutive cross-section rings
  for (let i = 0; i < segments; i++) {
    const ringA = i * pCount;
    const ringB = (i + 1) * pCount;
    for (let j = 0; j < pCount; j++) {
      const jNext = (j + 1) % pCount;
      const a0 = ringA + j;
      const a1 = ringA + jNext;
      const b0 = ringB + j;
      const b1 = ringB + jNext;
      indices.push(a0, b0, b1, a0, b1, a1);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/** Builds a smooth 3D TubeGeometry offset from a CatmullRomCurve3 by (lateralOffset * R + verticalOffset * N). */
function buildOffsetRailTube(
  curve: THREE.CatmullRomCurve3,
  lateralOffset: number,
  verticalOffset: number,
  tubeRadius: number,
  samples: number,
  radialSegments = 10,
): THREE.TubeGeometry {
  const up = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const pt = new THREE.Vector3();
  const tan = new THREE.Vector3();

  const offsetPts: THREE.Vector3[] = [];
  for (let i = 0; i <= samples; i++) {
    const u = i / samples;
    curve.getPointAt(u, pt);
    curve.getTangentAt(u, tan).normalize();
    right.crossVectors(tan, up);
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
    else right.normalize();
    normal.crossVectors(right, tan).normalize();

    offsetPts.push(
      new THREE.Vector3(
        pt.x + right.x * lateralOffset + normal.x * verticalOffset,
        pt.y + right.y * lateralOffset + normal.y * verticalOffset,
        pt.z + right.z * lateralOffset + normal.z * verticalOffset,
      ),
    );
  }

  const railCurve = new THREE.CatmullRomCurve3(offsetPts, false, 'centripetal', 0.5);
  return new THREE.TubeGeometry(railCurve, samples, tubeRadius, radialSegments, false);
}

// ---------------------------------------------------------------------------
// Internal Animated Rig Structures
// ---------------------------------------------------------------------------

interface BumperVisualRig {
  readonly lampId: LampId;
  readonly kickRingGroup: THREE.Group;
  readonly domeMat: THREE.MeshStandardMaterial;
  readonly coreMat: THREE.MeshStandardMaterial;
  readonly baseColor: number;
  kickAnim: number; // 0..1 decaying fast kick
  kickFlash: number; // 0..1 additive lamp flash
}

interface SlingshotVisualRig {
  readonly side: 'left' | 'right';
  readonly lampId: LampId;
  readonly activeRubberMesh: THREE.Mesh;
  readonly baseRubberPos: THREE.Vector3;
  readonly kickNormal: Vec2;
  readonly glowCoreMat: THREE.MeshStandardMaterial;
  readonly baseColor: number;
  kickAnim: number;
  kickFlash: number;
}

interface DropTargetVisualRig {
  readonly bladeGroup: THREE.Group;
  readonly bladeMat: THREE.MeshStandardMaterial;
  readonly lampId: LampId;
  readonly dropDepth: number;
  readonly baseColor: number;
  targetDropped: boolean;
  currentDropT: number; // 0 = up, 1 = retracted flush
}

interface StandupVisualRig {
  readonly pivotGroup: THREE.Group;
  readonly padMat: THREE.MeshStandardMaterial;
  readonly lampId: LampId;
  readonly baseColor: number;
  recoil: number;
  hitFlash: number;
}

interface InsertVisualRig {
  readonly lampId: LampId;
  readonly lensMat: THREE.MeshStandardMaterial;
  readonly baseColor: number;
  readonly isRampChase: boolean;
}

interface FlasherDomeRig {
  readonly lampId: LampId;
  readonly domeMat: THREE.MeshStandardMaterial;
  readonly baseColor: number;
}

interface BallPoolEntry {
  readonly sphere: THREE.Mesh;
  readonly shadow: THREE.Mesh;
  readonly shadowMat: THREE.MeshBasicMaterial;
}

// ---------------------------------------------------------------------------
// Main Playfield Builder
// ---------------------------------------------------------------------------

export function buildPlayfieldMeshes(
  textures: PlayfieldTextureBundle,
): PlayfieldVisuals {
  const group = new THREE.Group();
  group.name = 'HypernovaPlayfield';

  const ownedGeometries: THREE.BufferGeometry[] = [];
  const ownedMaterials: THREE.Material[] = [];
  const ownedTextures: THREE.Texture[] = [];

  const trackGeo = <T extends THREE.BufferGeometry>(g: T): T => {
    ownedGeometries.push(g);
    return g;
  };
  const trackMat = <T extends THREE.Material>(m: T): T => {
    ownedMaterials.push(m);
    return m;
  };
  const trackTex = <T extends THREE.Texture | null>(t: T): T => {
    if (t) ownedTextures.push(t);
    return t;
  };

  // -------------------------------------------------------------------------
  // Shared Playfield Materials
  // -------------------------------------------------------------------------
  const chromeMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xcbd8e8,
      metalness: 0.92,
      roughness: 0.16,
      envMapIntensity: 0.85,
    }),
  );

  const brushedSteelMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x8693a8,
      metalness: 0.82,
      roughness: 0.34,
      envMapIntensity: 0.62,
    }),
  );

  const darkAnodizedMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x161d30,
      metalness: 0.65,
      roughness: 0.38,
      envMapIntensity: 0.65,
    }),
  );

  const satinApronMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x121828,
      metalness: 0.58,
      roughness: 0.36,
      envMapIntensity: 0.65,
    }),
  );

  const whiteRubberMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xd0d7e0,
      roughness: 0.72,
      metalness: 0.04,
    }),
  );

  const darkBezelMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x090c14,
      roughness: 0.55,
      metalness: 0.35,
    }),
  );

  const ivoryBatMat = trackMat(
    new THREE.MeshPhysicalMaterial({
      color: 0xdcd6c8,
      roughness: 0.34,
      metalness: 0.04,
      clearcoat: 0.35,
      clearcoatRoughness: 0.22,
      envMapIntensity: 0.45,
    }),
  );

  const apronCyanTrimMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: PALETTE.cyan,
      emissive: PALETTE.cyan,
      emissiveIntensity: 0.78,
      roughness: 0.28,
      metalness: 0.2,
    }),
  );

  const apronMagentaTrimMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: PALETTE.magenta,
      emissive: PALETTE.magenta,
      emissiveIntensity: 0.76,
      roughness: 0.28,
      metalness: 0.2,
    }),
  );

  // -------------------------------------------------------------------------
  // 1. Clear-Coated Playfield Wood Deck (Y = 0, Exact UV Mapping)
  // -------------------------------------------------------------------------
  // PlaneGeometry rotated -PI/2 on X maps UV (0,1) -> (-W/2, 0, -L/2) = Z=-10.6 (top)
  // and UV (1,0) -> (+W/2, 0, +L/2) = Z=+10.6 (bottom), matching CanvasTexture flipY=true.
  const deckMaterial = trackMat(
    new THREE.MeshPhysicalMaterial({
      map: textures.map,
      roughnessMap: textures.roughnessMap,
      bumpMap: textures.bumpMap,
      bumpScale: 0.022,
      roughness: 0.94,
      metalness: 0.02,
      clearcoat: 0.55,
      clearcoatRoughness: 0.22,
      reflectivity: 0.5,
      envMapIntensity: 0.35,
    }),
  );

  const deckMesh = new THREE.Mesh(
    trackGeo(new THREE.PlaneGeometry(PLAYFIELD_WIDTH, PLAYFIELD_LENGTH)),
    deckMaterial,
  );
  deckMesh.name = 'PlayfieldDeck';
  deckMesh.rotation.x = -Math.PI / 2;
  deckMesh.position.set(0, 0, 0);
  deckMesh.receiveShadow = true;
  group.add(deckMesh);

  // Solid plywood sub-deck backing underneath Y = 0
  const subDeck = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(PLAYFIELD_WIDTH + 0.04, 0.42, PLAYFIELD_LENGTH + 0.04)),
    darkBezelMat,
  );
  subDeck.position.set(0, -0.215, 0);
  group.add(subDeck);

  // -------------------------------------------------------------------------
  // 2. Parametric Walls, Arch, Shooter Divider, Guides & I-O-N Lane Fins
  // -------------------------------------------------------------------------
  const wallMatCache = new Map<string, THREE.Material>();

  const getWallMaterial = (wall: WallPolylineDef): THREE.Material => {
    const key = `${wall.material}_${wall.color ?? 'default'}`;
    const existing = wallMatCache.get(key);
    if (existing) return existing;

    let mat: THREE.Material;
    switch (wall.material) {
      case 'metal':
        mat = trackMat(
          new THREE.MeshStandardMaterial({
            color: wall.color === PALETTE.chrome ? 0xb4c2d4 : (wall.color ?? 0xb4c2d4),
            metalness: 0.86,
            roughness: 0.26,
            envMapIntensity: 0.72,
          }),
        );
        break;
      case 'apron':
        mat = brushedSteelMat;
        break;
      case 'plastic': {
        const col = wall.color ?? PALETTE.cyan;
        const isBrightLaneFin = col === PALETTE.cyan;
        mat = trackMat(
          new THREE.MeshPhysicalMaterial({
            color: col,
            emissive: isBrightLaneFin ? col : 0x000000,
            emissiveIntensity: isBrightLaneFin ? 0.55 : 0,
            roughness: 0.16,
            metalness: 0.08,
            clearcoat: 1.0,
            clearcoatRoughness: 0.08,
            transparent: isBrightLaneFin,
            opacity: isBrightLaneFin ? 0.86 : 1.0,
          }),
        );
        break;
      }
      case 'rubber':
        mat = whiteRubberMat;
        break;
      case 'cabinet':
      default:
        mat = darkAnodizedMat;
        break;
    }
    wallMatCache.set(key, mat);
    return mat;
  };

  for (const wall of WALLS) {
    if (wall.points.length < 2) continue;
    const bevel = Math.min(0.018, wall.thickness * 0.18);
    const coreHalfT = Math.max(0.02, wall.thickness * 0.5 - bevel);
    const shape = buildPolylineShape(wall.points, coreHalfT, Boolean(wall.roundedCaps));
    const extrudeDepth = Math.max(0.05, wall.height - bevel * 2);

    const geo = trackGeo(
      new THREE.ExtrudeGeometry(shape, {
        depth: extrudeDepth,
        bevelEnabled: true,
        bevelThickness: bevel,
        bevelSize: bevel,
        bevelSegments: 2,
      }),
    );

    const mesh = new THREE.Mesh(geo, getWallMaterial(wall));
    mesh.name = `Wall_${wall.id}`;
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = bevel;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);

    // Chrome top trim rail accent along outer perimeter arch & shooter divider
    if (wall.id === 'outer_perimeter' || wall.id === 'shooter_divider') {
      const capShape = buildPolylineShape(wall.points, wall.thickness * 0.34, Boolean(wall.roundedCaps));
      const capGeo = trackGeo(
        new THREE.ExtrudeGeometry(capShape, { depth: 0.045, bevelEnabled: false }),
      );
      const capMesh = new THREE.Mesh(capGeo, chromeMat);
      capMesh.rotation.x = -Math.PI / 2;
      capMesh.position.y = wall.height + 0.005;
      group.add(capMesh);
    }
  }

  // Sculpted Brushed-Steel & Satin Bottom Apron Corner Plates (leaving center drain & shooter open!)
  const buildApronPlate = (
    ptsXZ: readonly Vec2[],
    trimStart: Vec2,
    trimEnd: Vec2,
    trimMat: THREE.Material,
  ): void => {
    const shapePts = ensureCCW(ptsXZ.map((p) => new THREE.Vector2(p.x, -p.z)));
    const shape = new THREE.Shape();
    shape.moveTo(shapePts[0].x, shapePts[0].y);
    for (let i = 1; i < shapePts.length; i++) shape.lineTo(shapePts[i].x, shapePts[i].y);
    shape.closePath();

    const plateGeo = trackGeo(
      new THREE.ExtrudeGeometry(shape, {
        depth: 0.78,
        bevelEnabled: true,
        bevelThickness: 0.03,
        bevelSize: 0.03,
        bevelSegments: 2,
      }),
    );
    const plate = new THREE.Mesh(plateGeo, satinApronMat);
    plate.rotation.x = -Math.PI / 2;
    plate.position.y = 0.03;
    plate.castShadow = true;
    plate.receiveShadow = true;
    group.add(plate);

    // Glowing neon laser trim along inner sloped apron edge
    const dx = trimEnd.x - trimStart.x;
    const dz = trimEnd.z - trimStart.z;
    const len = Math.hypot(dx, dz);
    const trim = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(len, 0.06, 0.09)),
      trimMat,
    );
    trim.position.set(
      (trimStart.x + trimEnd.x) * 0.5,
      0.86,
      (trimStart.z + trimEnd.z) * 0.5,
    );
    trim.rotation.y = -Math.atan2(dz, dx);
    group.add(trim);
  };

  buildApronPlate(
    [
      { x: -5.2, z: 7.9 },
      { x: -1.25, z: 10.23 },
      { x: -1.25, z: 10.6 },
      { x: -5.2, z: 10.6 },
    ],
    { x: -5.05, z: 8.05 },
    { x: -1.35, z: 10.22 },
    apronCyanTrimMat,
  );
  buildApronPlate(
    [
      { x: 4.15, z: 7.9 },
      { x: 4.15, z: 10.6 },
      { x: 0.2, z: 10.6 },
      { x: 0.2, z: 10.23 },
    ],
    { x: 4.0, z: 8.05 },
    { x: 0.3, z: 10.22 },
    apronMagentaTrimMat,
  );

  // Dark recessed center ball drain arch under the flippers
  const drainTrough = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(1.55, 0.04, 0.42)),
    darkBezelMat,
  );
  drainTrough.position.set(-0.525, 0.01, 10.35);
  group.add(drainTrough);

  // -------------------------------------------------------------------------
  // 3. Swinging One-Way Shooter Wire Gate
  // -------------------------------------------------------------------------
  const gateGroup = new THREE.Group();
  gateGroup.name = 'OneWayShooterGate';
  const gateDx = ONE_WAY_GATE.end.x - ONE_WAY_GATE.start.x;
  const gateDz = ONE_WAY_GATE.end.z - ONE_WAY_GATE.start.z;
  const gateSpan = Math.hypot(gateDx, gateDz);
  const gateAngleY = -Math.atan2(gateDz, gateDx);

  gateGroup.position.set(ONE_WAY_GATE.center.x, ONE_WAY_GATE.height, ONE_WAY_GATE.center.z);
  gateGroup.rotation.y = gateAngleY;

  // Vertical chrome bracket mounts at both gate edges
  const gateMountGeo = trackGeo(new THREE.CylinderGeometry(0.032, 0.032, ONE_WAY_GATE.height, 10));
  for (const s of [-1, 1] as const) {
    const post = new THREE.Mesh(gateMountGeo, chromeMat);
    post.position.set(s * (gateSpan * 0.5), -ONE_WAY_GATE.height * 0.5, 0);
    gateGroup.add(post);
  }

  // Horizontal pivot crossbar + swinging chrome wire flap
  const gateFlapPivot = new THREE.Group();
  const gateBar = new THREE.Mesh(
    trackGeo(new THREE.CylinderGeometry(0.025, 0.025, gateSpan + 0.06, 10)),
    chromeMat,
  );
  gateBar.rotation.z = Math.PI / 2;
  gateFlapPivot.add(gateBar);

  const wireProngGeo = trackGeo(new THREE.CylinderGeometry(0.018, 0.018, 0.56, 8));
  for (const px of [-gateSpan * 0.3, 0, gateSpan * 0.3]) {
    const prong = new THREE.Mesh(wireProngGeo, chromeMat);
    prong.position.set(px, -0.28, 0);
    gateFlapPivot.add(prong);
  }
  const bottomTie = new THREE.Mesh(
    trackGeo(new THREE.CylinderGeometry(0.018, 0.018, gateSpan * 0.62, 8)),
    chromeMat,
  );
  bottomTie.rotation.z = Math.PI / 2;
  bottomTie.position.set(0, -0.55, 0);
  gateFlapPivot.add(bottomTie);

  // Determine swing sign so gate swings in ONE_WAY_GATE.allowedDirection
  // Local +Z of gateGroup points along (sin(gateAngleY), cos(gateAngleY))
  const gateLocalZDotAllowed =
    Math.sin(gateAngleY) * ONE_WAY_GATE.allowedDirection.x +
    Math.cos(gateAngleY) * ONE_WAY_GATE.allowedDirection.z;
  const gateSwingSign = gateLocalZDotAllowed >= 0 ? -1 : 1;

  gateGroup.add(gateFlapPivot);
  group.add(gateGroup);

  let gateSwingAngle = 0;
  let gateSwingVel = 0;

  // -------------------------------------------------------------------------
  // 4. Rubber-Ringed Hex Metal Posts
  // -------------------------------------------------------------------------
  const postHexNutGeo = trackGeo(new THREE.CylinderGeometry(0.095, 0.105, 0.1, 6));
  const postAcornGeo = trackGeo(new THREE.SphereGeometry(0.075, 12, 8));

  for (const post of RUBBER_POSTS) {
    const pGroup = new THREE.Group();
    pGroup.position.set(post.position.x, 0, post.position.z);

    // Chrome cylindrical stud
    const stud = new THREE.Mesh(
      trackGeo(new THREE.CylinderGeometry(post.radius * 0.55, post.radius * 0.62, post.height, 14)),
      chromeMat,
    );
    stud.position.y = post.height * 0.5;
    stud.castShadow = true;
    pGroup.add(stud);

    // Base hex collar
    const baseNut = new THREE.Mesh(postHexNutGeo, brushedSteelMat);
    baseNut.position.y = 0.05;
    pGroup.add(baseNut);

    // Silicone rubber bumper sleeve at ball equator height
    const sleeveMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: post.color,
        emissive: post.color,
        emissiveIntensity: 0.32,
        roughness: 0.52,
        metalness: 0.05,
      }),
    );
    const sleeve = new THREE.Mesh(
      trackGeo(new THREE.TorusGeometry(post.radius * 0.68, post.radius * 0.34, 12, 20)),
      sleeveMat,
    );
    sleeve.rotation.x = Math.PI / 2;
    sleeve.position.y = BALL_RADIUS;
    pGroup.add(sleeve);

    // Top chrome acorn cap
    const cap = new THREE.Mesh(postAcornGeo, chromeMat);
    cap.position.y = post.height + 0.02;
    pGroup.add(cap);

    group.add(pGroup);
  }

  // -------------------------------------------------------------------------
  // 5. Three Pop Bumpers (Chrome Skirt, Solenoid Kick Collar, Glowing Dome Cap)
  // -------------------------------------------------------------------------
  const bumperRigs: BumperVisualRig[] = [];

  // Shared sculpted bumper saucer dome profile
  const domeProfile = [
    new THREE.Vector2(0.0, 0.28),
    new THREE.Vector2(0.18, 0.27),
    new THREE.Vector2(0.36, 0.21),
    new THREE.Vector2(0.46, 0.11),
    new THREE.Vector2(0.47, 0.03),
    new THREE.Vector2(0.42, 0.0),
  ];
  const bumperDomeGeo = trackGeo(new THREE.LatheGeometry(domeProfile, 28));
  const bumperSkirtGeo = trackGeo(new THREE.CylinderGeometry(0.36, 0.48, 0.11, 28));
  const bumperCoreGeo = trackGeo(new THREE.CylinderGeometry(0.32, 0.3, 0.42, 24));
  const bumperKickRingGeo = trackGeo(new THREE.TorusGeometry(0.42, 0.055, 12, 28));
  const bumperTopChromeRingGeo = trackGeo(new THREE.TorusGeometry(0.24, 0.022, 8, 24));
  const bumperCapInlayGeo = trackGeo(new THREE.CylinderGeometry(0.21, 0.21, 0.025, 24));

  for (const def of POP_BUMPERS) {
    const bGroup = new THREE.Group();
    bGroup.name = `PopBumper_${def.id}`;
    bGroup.position.set(def.position.x, 0, def.position.z);

    // Flared chrome base skirt
    const skirt = new THREE.Mesh(bumperSkirtGeo, chromeMat);
    skirt.position.y = 0.055;
    skirt.castShadow = true;
    skirt.receiveShadow = true;
    bGroup.add(skirt);

    // Illuminated translucent inner body core
    const coreMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: def.color,
        emissive: def.color,
        emissiveIntensity: 0.45,
        roughness: 0.24,
        metalness: 0.08,
      }),
    );
    const core = new THREE.Mesh(bumperCoreGeo, coreMat);
    core.position.y = 0.31;
    core.castShadow = true;
    bGroup.add(core);

    // Animated solenoid metal kick collar ring at ball impact height
    const kickRingGroup = new THREE.Group();
    kickRingGroup.position.y = 0.29;
    const kickRing = new THREE.Mesh(bumperKickRingGeo, chromeMat);
    kickRing.rotation.x = Math.PI / 2;
    kickRingGroup.add(kickRing);
    bGroup.add(kickRingGroup);

    // Sculpted translucent colored domed cap
    const domeMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: def.color,
        emissive: def.color,
        emissiveIntensity: 0.55,
        roughness: 0.16,
        metalness: 0.12,
      }),
    );
    const dome = new THREE.Mesh(bumperDomeGeo, domeMat);
    dome.position.y = def.height - 0.28;
    dome.castShadow = true;
    bGroup.add(dome);

    // Chrome crown accent ring + luminous star inlay on top of dome
    const crownRing = new THREE.Mesh(bumperTopChromeRingGeo, chromeMat);
    crownRing.rotation.x = Math.PI / 2;
    crownRing.position.y = def.height - 0.015;
    bGroup.add(crownRing);

    const centerInlay = new THREE.Mesh(bumperCapInlayGeo, coreMat);
    centerInlay.position.y = def.height - 0.01;
    bGroup.add(centerInlay);

    group.add(bGroup);

    bumperRigs.push({
      lampId: def.lampId,
      kickRingGroup,
      domeMat,
      coreMat,
      baseColor: def.color,
      kickAnim: 0,
      kickFlash: 0,
    });
  }

  // -------------------------------------------------------------------------
  // 6. Two Triangular Slingshots (Posts, Flexing White Rubber, Printed Top Cap)
  // -------------------------------------------------------------------------
  const slingshotRigs: SlingshotVisualRig[] = [];
  const slingPostGeo = trackGeo(new THREE.CylinderGeometry(0.085, 0.095, 0.64, 14));
  const slingCapNutGeo = trackGeo(new THREE.CylinderGeometry(0.075, 0.075, 0.07, 6));

  for (const def of SLINGSHOTS) {
    const sGroup = new THREE.Group();
    sGroup.name = `Slingshot_${def.id}`;
    const [vTop, vOuter, vInner] = def.vertices;

    // 3 Corner Chrome Hex Posts
    for (const v of def.vertices) {
      const post = new THREE.Mesh(slingPostGeo, chromeMat);
      post.position.set(v.x, 0.32, v.z);
      post.castShadow = true;
      sGroup.add(post);

      const nut = new THREE.Mesh(slingCapNutGeo, brushedSteelMat);
      nut.position.set(v.x, def.height + 0.09, v.z);
      sGroup.add(nut);
    }

    // White silicone rubber bands along the two passive sides + flexing active edge
    const buildRubberBar = (a: Vec2, b: Vec2, radius: number): THREE.Mesh => {
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len = Math.hypot(dx, dz);
      const mesh = new THREE.Mesh(
        trackGeo(new THREE.CylinderGeometry(radius, radius, len, 10)),
        whiteRubberMat,
      );
      mesh.position.set((a.x + b.x) * 0.5, BALL_RADIUS, (a.z + b.z) * 0.5);
      // Orient cylinder (+Y) along segment (dx, 0, dz)
      mesh.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(dx / len, 0, dz / len),
      );
      return mesh;
    };

    // Corner rubber collars wrapping each post cleanly
    const cornerCollarGeo = trackGeo(new THREE.CylinderGeometry(def.postRadius, def.postRadius, 0.22, 16));
    for (const v of def.vertices) {
      const collar = new THREE.Mesh(cornerCollarGeo, whiteRubberMat);
      collar.position.set(v.x, BALL_RADIUS, v.z);
      sGroup.add(collar);
    }

    // Passive outer & bottom rubber stretches
    sGroup.add(buildRubberBar(vTop, vOuter, 0.082));
    sGroup.add(buildRubberBar(vOuter, vInner, 0.082));

    // Active kicking face rubber band (flexes outward along kickNormal on hit!)
    const activeRubberMesh = buildRubberBar(def.activeEdge[0], def.activeEdge[1], 0.092);
    const baseRubberPos = activeRubberMesh.position.clone();
    sGroup.add(activeRubberMesh);

    // Under-glow illuminated core tucked inside the slingshot triangle
    const cx = (vTop.x + vOuter.x + vInner.x) / 3;
    const cz = (vTop.z + vOuter.z + vInner.z) / 3;
    const glowCoreMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: def.color,
        emissive: def.color,
        emissiveIntensity: 0.4,
        roughness: 0.28,
        metalness: 0.1,
      }),
    );
    const glowCore = new THREE.Mesh(
      trackGeo(new THREE.CylinderGeometry(0.24, 0.3, 0.36, 16)),
      glowCoreMat,
    );
    glowCore.position.set(cx, 0.2, cz);
    sGroup.add(glowCore);

    // Translucent Printed Polycarbonate Triangular Top Plastic
    // Expand vertices slightly outward from triangle centroid for authentic overhang past posts
    const capPts = def.vertices.map((v) => {
      const ox = v.x - cx;
      const oz = v.z - cz;
      const d = Math.hypot(ox, oz) || 1;
      return new THREE.Vector2(v.x + (ox / d) * 0.17, -(v.z + (oz / d) * 0.17));
    });
    ensureCCW(capPts);
    const capShape = new THREE.Shape();
    capShape.moveTo(capPts[0].x, capPts[0].y);
    capShape.lineTo(capPts[1].x, capPts[1].y);
    capShape.lineTo(capPts[2].x, capPts[2].y);
    capShape.closePath();

    const slingTex = trackTex(createSlingshotPlasticTexture(def.color));
    const capMat = trackMat(
      new THREE.MeshPhysicalMaterial({
        color: 0xffffff,
        map: slingTex ?? null,
        emissive: def.color,
        emissiveIntensity: 0.18,
        roughness: 0.14,
        metalness: 0.08,
        clearcoat: 1.0,
        clearcoatRoughness: 0.06,
        transparent: true,
        opacity: 0.9,
      }),
    );

    const capGeo = trackGeo(
      new THREE.ExtrudeGeometry(capShape, {
        depth: 0.055,
        bevelEnabled: true,
        bevelThickness: 0.015,
        bevelSize: 0.015,
        bevelSegments: 2,
      }),
    );
    const capMesh = new THREE.Mesh(capGeo, capMat);
    capMesh.rotation.x = -Math.PI / 2;
    capMesh.position.y = def.height;
    capMesh.castShadow = true;
    capMesh.receiveShadow = true;
    sGroup.add(capMesh);

    group.add(sGroup);

    slingshotRigs.push({
      side: def.side,
      lampId: def.lampId,
      activeRubberMesh,
      baseRubberPos,
      kickNormal: def.kickNormal,
      glowCoreMat,
      baseColor: def.color,
      kickAnim: 0,
      kickFlash: 0,
    });
  }

  // -------------------------------------------------------------------------
  // 7. Three Flippers (Left, Right, Upper-Right Mini-Flipper)
  // -------------------------------------------------------------------------
  const flipperGroupsBySide = new Map<FlipperSide, THREE.Group>();
  const flipperGroupsById = new Map<string, THREE.Group>();

  const buildFlipperMesh = (def: FlipperDef): THREE.Group => {
    const fGroup = new THREE.Group();
    fGroup.name = `Flipper_${def.id}`;
    fGroup.position.set(def.pivot.x, 0, def.pivot.z);
    fGroup.rotation.y = def.restAngle;

    // Outer molded rubber sleeve (exact baseRadius -> tipRadius silhouette at ball equator)
    const rubberShape = buildFlipperShape(def.length, def.baseRadius, def.tipRadius, def.direction);
    const rubberGeo = trackGeo(
      new THREE.ExtrudeGeometry(rubberShape, {
        depth: def.height * 0.72,
        bevelEnabled: true,
        bevelThickness: 0.02,
        bevelSize: 0.015,
        bevelSegments: 2,
      }),
    );
    const rubberMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: def.rubberColor,
        emissive: def.rubberColor,
        emissiveIntensity: 0.22,
        roughness: 0.56,
        metalness: 0.06,
      }),
    );
    const rubberMesh = new THREE.Mesh(rubberGeo, rubberMat);
    rubberMesh.rotation.x = -Math.PI / 2;
    rubberMesh.position.y = 0.06;
    rubberMesh.castShadow = true;
    rubberMesh.receiveShadow = true;
    fGroup.add(rubberMesh);

    // Tapered ivory-white inner bat core rising slightly above rubber band
    const coreInset = 0.036;
    const batShape = buildFlipperShape(
      def.length,
      Math.max(0.05, def.baseRadius - coreInset),
      Math.max(0.04, def.tipRadius - coreInset),
      def.direction,
    );
    const batGeo = trackGeo(
      new THREE.ExtrudeGeometry(batShape, {
        depth: def.height - 0.05,
        bevelEnabled: true,
        bevelThickness: 0.025,
        bevelSize: 0.02,
        bevelSegments: 3,
      }),
    );
    const batMesh = new THREE.Mesh(batGeo, ivoryBatMat);
    batMesh.rotation.x = -Math.PI / 2;
    batMesh.position.y = 0.04;
    batMesh.castShadow = true;
    batMesh.receiveShadow = true;
    fGroup.add(batMesh);

    // Decorative brushed-chrome top groove accent & pivot hub cap
    const hubCap = new THREE.Mesh(
      trackGeo(new THREE.CylinderGeometry(def.baseRadius * 0.58, def.baseRadius * 0.64, 0.06, 20)),
      chromeMat,
    );
    hubCap.position.set(0, def.height + 0.015, 0);
    fGroup.add(hubCap);

    const ridgeLen = def.length * 0.62;
    const ridge = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(ridgeLen, 0.028, 0.055)),
      brushedSteelMat,
    );
    ridge.position.set(def.direction * (def.length * 0.45), def.height + 0.012, 0);
    fGroup.add(ridge);

    return fGroup;
  };

  for (const def of FLIPPERS) {
    const fGroup = buildFlipperMesh(def);
    group.add(fGroup);
    flipperGroupsBySide.set(def.side, fGroup);
    flipperGroupsById.set(def.id, fGroup);
  }

  // -------------------------------------------------------------------------
  // 8. Left 3-Bank Drop Targets (R - A - Y)
  // -------------------------------------------------------------------------
  const dropTargetRigs: DropTargetVisualRig[] = [];

  for (const def of DROP_TARGETS) {
    const tRoot = new THREE.Group();
    tRoot.name = `DropTarget_${def.id}`;
    tRoot.position.set(def.position.x, 0, def.position.z);
    tRoot.rotation.y = def.angleY;

    // Flush recessed mechanical slot bezel in playfield wood
    const slotBezel = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(def.width + 0.08, 0.018, def.depth + 0.07)),
      darkBezelMat,
    );
    slotBezel.position.y = 0.008;
    tRoot.add(slotBezel);

    // Retractable glowing translucent target blade with crisp letter graphic
    const bladeGroup = new THREE.Group();
    const faceTex = trackTex(createTargetFaceTexture(def.label, def.color));
    const bladeMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: faceTex ? 0xffffff : def.color,
        map: faceTex ?? null,
        emissive: def.color,
        emissiveIntensity: 0.48,
        roughness: 0.2,
        metalness: 0.08,
      }),
    );

    const blade = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(def.width, def.height, def.depth)),
      bladeMat,
    );
    blade.position.y = def.height * 0.5;
    blade.castShadow = true;
    blade.receiveShadow = true;
    bladeGroup.add(blade);

    // Crisp white bevel lip along top of drop target
    const topLip = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(def.width + 0.02, 0.04, def.depth + 0.02)),
      ivoryBatMat,
    );
    topLip.position.y = def.height + 0.01;
    bladeGroup.add(topLip);

    tRoot.add(bladeGroup);
    group.add(tRoot);

    dropTargetRigs.push({
      bladeGroup,
      bladeMat,
      lampId: def.lampId,
      dropDepth: def.height - 0.015,
      baseColor: def.color,
      targetDropped: false,
      currentDropT: 0,
    });
  }

  // -------------------------------------------------------------------------
  // 9. Right 3-Bank Standup Targets (2X / 3X / 5X)
  // -------------------------------------------------------------------------
  const standupRigs: StandupVisualRig[] = [];

  for (const def of STANDUP_TARGETS) {
    const sRoot = new THREE.Group();
    sRoot.name = `StandupTarget_${def.id}`;
    sRoot.position.set(def.position.x, 0, def.position.z);
    sRoot.rotation.y = def.angleY;

    // Chrome L-bracket base bolted to playfield
    const bracket = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(def.width * 0.72, 0.06, def.depth + 0.14)),
      chromeMat,
    );
    bracket.position.set(0, 0.03, -0.04);
    sRoot.add(bracket);

    const pivotGroup = new THREE.Group();
    pivotGroup.position.set(0, 0.04, 0);

    const faceTex = trackTex(createTargetFaceTexture(def.label, def.color, '#0a1c18'));
    const padMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: faceTex ? 0xffffff : def.color,
        map: faceTex ?? null,
        emissive: def.color,
        emissiveIntensity: 0.45,
        roughness: 0.22,
        metalness: 0.1,
      }),
    );

    const pad = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(def.width, def.height - 0.04, def.depth)),
      padMat,
    );
    pad.position.y = (def.height - 0.04) * 0.5;
    pad.castShadow = true;
    pad.receiveShadow = true;
    pivotGroup.add(pad);

    // Back steel leaf spring plate behind standup face
    const backLeaf = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(def.width * 0.6, def.height * 0.85, 0.035)),
      brushedSteelMat,
    );
    backLeaf.position.set(0, def.height * 0.44, -(def.depth * 0.5 + 0.02));
    pivotGroup.add(backLeaf);

    sRoot.add(pivotGroup);
    group.add(sRoot);

    standupRigs.push({
      pivotGroup,
      padMat,
      lampId: def.lampId,
      baseColor: def.color,
      recoil: 0,
      hitFlash: 0,
    });
  }

  // -------------------------------------------------------------------------
  // 10. Top I-O-N Rollover Wire Switches
  // -------------------------------------------------------------------------
  const rolloverSlotGeo = trackGeo(new THREE.BoxGeometry(0.08, 0.012, 0.52));
  const rolloverWireGeo = trackGeo(new THREE.CylinderGeometry(0.015, 0.015, 0.36, 8));

  for (const lane of ROLLOVER_LANES) {
    const slot = new THREE.Mesh(rolloverSlotGeo, darkBezelMat);
    slot.position.set(lane.position.x, 0.006, lane.position.z - 0.32);
    group.add(slot);

    const wire = new THREE.Mesh(rolloverWireGeo, chromeMat);
    wire.rotation.x = Math.PI / 2 - 0.22;
    wire.position.set(lane.position.x, 0.055, lane.position.z - 0.32);
    group.add(wire);
  }

  // -------------------------------------------------------------------------
  // 11. Left Orbit Metal Spinner (Wire Arch + Dual-Sided Blade)
  // -------------------------------------------------------------------------
  const spinnerGroup = new THREE.Group();
  spinnerGroup.name = 'LeftOrbitSpinner';
  spinnerGroup.position.set(SPINNER.position.x, 0, SPINNER.position.z);

  const halfSpinW = SPINNER.width * 0.5;
  const spinLegGeo = trackGeo(new THREE.CylinderGeometry(0.026, 0.026, SPINNER.pivotY + 0.14, 10));
  for (const s of [-1, 1] as const) {
    const leg = new THREE.Mesh(spinLegGeo, chromeMat);
    leg.position.set(s * halfSpinW, (SPINNER.pivotY + 0.14) * 0.5, 0);
    spinnerGroup.add(leg);
  }
  const spinTopArch = new THREE.Mesh(
    trackGeo(new THREE.CylinderGeometry(0.026, 0.026, SPINNER.width + 0.04, 10)),
    chromeMat,
  );
  spinTopArch.rotation.z = Math.PI / 2;
  spinTopArch.position.set(0, SPINNER.pivotY + 0.14, 0);
  spinnerGroup.add(spinTopArch);

  // Rotating horizontal axle + hanging dual-sided spinner blade
  const spinnerBladePivot = new THREE.Group();
  spinnerBladePivot.position.set(0, SPINNER.pivotY, 0);

  const spinAxle = new THREE.Mesh(
    trackGeo(new THREE.CylinderGeometry(0.02, 0.02, SPINNER.width, 10)),
    chromeMat,
  );
  spinAxle.rotation.z = Math.PI / 2;
  spinnerBladePivot.add(spinAxle);

  const spinnerTex = trackTex(createSpinnerBladeTexture());
  const spinnerBladeMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: spinnerTex ?? null,
      metalness: 0.78,
      roughness: 0.2,
      envMapIntensity: 1.35,
    }),
  );
  const spinnerBlade = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(SPINNER.width * 0.76, SPINNER.bladeHeight, 0.026)),
    spinnerBladeMat,
  );
  // Hangs mostly below the pivot axle so balls cleanly bat the blade around
  spinnerBlade.position.y = -SPINNER.bladeHeight * 0.34;
  spinnerBlade.castShadow = true;
  spinnerBladePivot.add(spinnerBlade);

  spinnerGroup.add(spinnerBladePivot);
  group.add(spinnerGroup);

  // -------------------------------------------------------------------------
  // 12. Hypercore Lock Saucer Recess & Left Outlane Kickback Mechanism
  // -------------------------------------------------------------------------
  const saucerGroup = new THREE.Group();
  saucerGroup.name = 'HypercoreSaucerRecess';
  saucerGroup.position.set(HYPERCORE_SAUCER.position.x, 0, HYPERCORE_SAUCER.position.z);

  const saucerWell = new THREE.Mesh(
    trackGeo(new THREE.CylinderGeometry(HYPERCORE_SAUCER.captureRadius, HYPERCORE_SAUCER.captureRadius * 0.75, 0.04, 28)),
    darkBezelMat,
  );
  saucerWell.position.y = 0.012;
  saucerGroup.add(saucerWell);

  const saucerRimMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: PALETTE.violet,
      emissive: PALETTE.violet,
      emissiveIntensity: 0.85,
      metalness: 0.6,
      roughness: 0.24,
    }),
  );
  const saucerRim = new THREE.Mesh(
    trackGeo(new THREE.TorusGeometry(HYPERCORE_SAUCER.captureRadius + 0.04, 0.042, 10, 28)),
    saucerRimMat,
  );
  saucerRim.rotation.x = Math.PI / 2;
  saucerRim.position.y = 0.028;
  saucerGroup.add(saucerRim);
  group.add(saucerGroup);

  // Left Outlane Kickback — flush recessed under-deck kicker slot & glowing emerald emitter
  // (recessed flush at y <= 0.016 so draining balls roll cleanly over it with zero visual clipping)
  const kickbackGroup = new THREE.Group();
  kickbackGroup.name = 'LeftOutlaneKickback';
  kickbackGroup.position.set(KICKBACK.position.x, 0, KICKBACK.position.z + 0.35);

  const kbPlate = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(0.46, 0.01, 0.56)),
    brushedSteelMat,
  );
  kbPlate.position.y = 0.005;
  kickbackGroup.add(kbPlate);

  const kbTrack = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(0.22, 0.012, 0.44)),
    darkBezelMat,
  );
  kbTrack.position.y = 0.007;
  kickbackGroup.add(kbTrack);

  const kbTipMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: PALETTE.emerald,
      emissive: PALETTE.emerald,
      emissiveIntensity: 0.4,
      roughness: 0.28,
      metalness: 0.2,
    }),
  );
  const kbTip = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(0.18, 0.012, 0.32)),
    kbTipMat,
  );
  kbTip.position.set(0, 0.01, 0);
  kickbackGroup.add(kbTip);
  group.add(kickbackGroup);

  // -------------------------------------------------------------------------
  // 13. Elevated Transparent Acrylic WARP RAMP
  // -------------------------------------------------------------------------
  const rampPoints = WARP_RAMP.controlPoints.map((p) => new THREE.Vector3(p.x, p.y, p.z));
  const rampCurve = new THREE.CatmullRomCurve3(rampPoints, false, 'centripetal', 0.5);

  const rampAcrylicMat = trackMat(
    new THREE.MeshPhysicalMaterial({
      color: 0xa8ecff,
      transparent: true,
      opacity: 0.22,
      roughness: 0.1,
      metalness: 0.04,
      clearcoat: 0.65,
      clearcoatRoughness: 0.1,
      reflectivity: 0.65,
      envMapIntensity: 0.7,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );

  const rampChannelMesh = new THREE.Mesh(
    trackGeo(
      buildRampChannelGeometry(
        rampCurve,
        WARP_RAMP.width,
        WARP_RAMP.deckThickness,
        WARP_RAMP.guardrailThickness,
        WARP_RAMP.guardrailHeight,
        52,
      ),
    ),
    rampAcrylicMat,
  );
  rampChannelMesh.name = 'WarpRampAcrylicChannel';
  rampChannelMesh.renderOrder = 6;
  group.add(rampChannelMesh);

  // Twin polished chrome top trim rails running cleanly along the left & right acrylic walls
  const rampRailOffset = WARP_RAMP.width * 0.5 + WARP_RAMP.guardrailThickness * 0.5;
  for (const side of [-1, 1] as const) {
    const railTube = new THREE.Mesh(
      trackGeo(
        buildOffsetRailTube(
          rampCurve,
          side * rampRailOffset,
          WARP_RAMP.guardrailHeight + 0.02,
          0.036,
          52,
          10,
        ),
      ),
      chromeMat,
    );
    railTube.castShadow = true;
    group.add(railTube);
  }

  // Polished chrome ramp entrance flap & glowing portal header arch at ramp mouth
  const mouthPt = rampCurve.getPointAt(0.055);
  const mouthTan = rampCurve.getTangentAt(0.055).normalize();
  const mouthAngleY = Math.atan2(mouthTan.x, mouthTan.z);
  const rampMouthArch = new THREE.Group();
  rampMouthArch.position.set(mouthPt.x, 0, mouthPt.z);
  rampMouthArch.rotation.y = mouthAngleY;

  const flapPlate = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(WARP_RAMP.width - 0.04, 0.015, 0.32)),
    chromeMat,
  );
  flapPlate.position.set(0, 0.01, -0.06);
  rampMouthArch.add(flapPlate);

  // Glowing magenta/cyan neon portal arch framing the Warp Ramp entrance
  const archSpan = WARP_RAMP.width + 0.16;
  const portalHeight = 0.88;
  for (const s of [-1, 1] as const) {
    const pillar = new THREE.Mesh(
      trackGeo(new THREE.CylinderGeometry(0.045, 0.055, portalHeight, 12)),
      chromeMat,
    );
    pillar.position.set(s * (archSpan * 0.5), portalHeight * 0.5, 0);
    pillar.castShadow = true;
    rampMouthArch.add(pillar);
  }
  const portalBar = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(archSpan + 0.1, 0.14, 0.12)),
    apronMagentaTrimMat,
  );
  portalBar.position.set(0, portalHeight + 0.04, 0);
  rampMouthArch.add(portalBar);
  group.add(rampMouthArch);

  // Vertical chrome support stanchions beneath elevated ramp sections (outside ball lanes)
  for (const u of [0.55, 0.82, 0.98]) {
    const sp = rampCurve.getPointAt(u);
    const st = rampCurve.getTangentAt(u).normalize();
    const sr = new THREE.Vector3().crossVectors(st, new THREE.Vector3(0, 1, 0)).normalize();
    const postPos = sp.clone().addScaledVector(sr, -(WARP_RAMP.width * 0.5 + 0.04));
    const postH = Math.max(0.1, postPos.y - WARP_RAMP.deckThickness);
    const stanchion = new THREE.Mesh(
      trackGeo(new THREE.CylinderGeometry(0.045, 0.055, postH, 10)),
      chromeMat,
    );
    stanchion.position.set(postPos.x, postH * 0.5, postPos.z);
    stanchion.castShadow = true;
    group.add(stanchion);
  }

  // -------------------------------------------------------------------------
  // 14. Dual-Rail Chrome Wireform Habitrail (4-Wire Cradle + U-Brackets)
  // -------------------------------------------------------------------------
  const wfPoints = WIREFORM_RAIL.controlPoints.map((p) => new THREE.Vector3(p.x, p.y, p.z));
  const wfCurve = new THREE.CatmullRomCurve3(wfPoints, false, 'centripetal', 0.5);
  const halfGauge = WIREFORM_RAIL.railGauge * 0.5; // 0.15
  const wfVertOffset = -WIREFORM_RAIL.tubeVerticalOffset; // -0.277

  // Primary twin parallel load-bearing stainless steel rails (ball rests tangent on both!)
  for (const side of [-1, 1] as const) {
    const mainRail = new THREE.Mesh(
      trackGeo(
        buildOffsetRailTube(
          wfCurve,
          side * halfGauge,
          wfVertOffset,
          WIREFORM_RAIL.tubeRadius,
          72,
          10,
        ),
      ),
      chromeMat,
    );
    mainRail.name = `WireformMainRail_${side < 0 ? 'L' : 'R'}`;
    mainRail.castShadow = true;
    group.add(mainRail);

    // Outer upper containment guard wires (authentic 4-wire Williams habitrail!)
    const guardRail = new THREE.Mesh(
      trackGeo(
        buildOffsetRailTube(
          wfCurve,
          side * 0.32,
          0.035,
          WIREFORM_RAIL.tubeRadius * 0.72,
          72,
          8,
        ),
      ),
      chromeMat,
    );
    guardRail.castShadow = true;
    group.add(guardRail);
  }

  // Periodic curved U-bracket weld ties connecting all 4 chrome wires along the habitrail
  const bracketCount = 12;
  const upVec = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i <= bracketCount; i++) {
    const u = 0.04 + (0.92 * i) / bracketCount;
    const p = wfCurve.getPointAt(u);
    const t = wfCurve.getTangentAt(u).normalize();
    const r = new THREE.Vector3().crossVectors(t, upVec).normalize();
    const n = new THREE.Vector3().crossVectors(r, t).normalize();

    const makePt = (lat: number, vert: number) =>
      new THREE.Vector3(
        p.x + r.x * lat + n.x * vert,
        p.y + r.y * lat + n.y * vert,
        p.z + r.z * lat + n.z * vert,
      );

    // Smooth curved U-cradle passing just outside the 4 wire tubes
    const uCurve = new THREE.CatmullRomCurve3([
      makePt(-0.335, 0.04),
      makePt(-0.31, -0.15),
      makePt(-halfGauge, wfVertOffset - 0.035),
      makePt(0, wfVertOffset - 0.06),
      makePt(halfGauge, wfVertOffset - 0.035),
      makePt(0.31, -0.15),
      makePt(0.335, 0.04),
    ]);
    const uTie = new THREE.Mesh(
      trackGeo(new THREE.TubeGeometry(uCurve, 14, 0.026, 6, false)),
      chromeMat,
    );
    group.add(uTie);

    // Slim outer-left vertical support posts anchored near left cabinet edge (clear of lanes)
    if (i === 1 || i === 4 || i === 8 || i === 11) {
      const anchorPt = makePt(-0.335, 0.02);
      const postH = Math.max(0.12, anchorPt.y);
      const support = new THREE.Mesh(
        trackGeo(new THREE.CylinderGeometry(0.034, 0.042, postH, 8)),
        brushedSteelMat,
      );
      support.position.set(anchorPt.x, postH * 0.5, anchorPt.z);
      support.castShadow = true;
      group.add(support);
    }
  }

  // -------------------------------------------------------------------------
  // 15. 38 Recessed LED Inserts & 4 Physical Flasher Domes
  // -------------------------------------------------------------------------
  const insertRigs: InsertVisualRig[] = [];
  const insertLabelTexCache = new Map<string, THREE.CanvasTexture | null>();

  const STAR_INSERT_EMBLEMS: Readonly<Record<string, string>> = {
    JACKPOT: 'JP',
    SUPER: 'SJP',
    'EX BALL': 'EB',
    SAVE: 'SAVE',
  };

  /** Creates a white-with-black-stencil mask texture so emissive/color tinting backlights silk-screened text. */
  const getInsertStencilTexture = (
    label: string,
    shape: InsertShape,
  ): THREE.CanvasTexture | null => {
    const displayLabel =
      shape === 'star' ? (STAR_INSERT_EMBLEMS[label] ?? label.slice(0, 4)) : label;
    const cacheKey = `${shape}:${displayLabel}`;
    if (insertLabelTexCache.has(cacheKey)) {
      return insertLabelTexCache.get(cacheKey) ?? null;
    }
    if (typeof document === 'undefined') {
      insertLabelTexCache.set(cacheKey, null);
      return null;
    }
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      insertLabelTexCache.set(cacheKey, null);
      return null;
    }

    // Bright translucent acrylic lens body (tinted dynamically by material color/emissive)
    const grad = ctx.createRadialGradient(64, 64, 10, 64, 64, 66);
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(0.75, '#dce4f0');
    grad.addColorStop(1, '#8a96aa');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 128, 128);

    // Crisp silk-screened dark legend clamped safely inside the shape's inscribed core
    ctx.fillStyle = '#090d18';
    const isStar = shape === 'star';
    const isDiamond = shape === 'diamond';
    const maxWidth = isStar ? 46 : isDiamond ? 66 : 92;
    const fontSize = isStar
      ? displayLabel.length <= 2
        ? 28
        : displayLabel.length === 3
          ? 23
          : 19
      : displayLabel.length <= 1
        ? 66
        : displayLabel.length <= 2
          ? 48
          : displayLabel.length <= 4
            ? 30
            : 22;
    ctx.font = `900 ${fontSize}px "Arial Black", "Impact", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(displayLabel, 64, isStar ? 67 : 66, maxWidth);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    ownedTextures.push(tex);
    insertLabelTexCache.set(cacheKey, tex);
    return tex;
  };

  const normalizeShapeUVs = (geo: THREE.ShapeGeometry, radius: number): void => {
    const pos = geo.attributes.position;
    const uv = geo.attributes.uv;
    if (!pos || !uv || radius <= 0) return;
    const invSpan = 1 / (radius * 2.05);
    for (let i = 0; i < pos.count; i++) {
      const sx = pos.getX(i);
      const sy = pos.getY(i);
      uv.setXY(i, sx * invSpan + 0.5, sy * invSpan + 0.5);
    }
    uv.needsUpdate = true;
  };

  for (const def of LED_INSERTS) {
    const isRampChase = def.y !== undefined && def.y > 0.05;
    const insertY = isRampChase ? Math.max(0.04, (def.y ?? 0.004) - 0.065) : (def.y ?? 0.004);

    const lensRadius = def.size * 0.64;
    const lensShape = buildInsertShape(def.shape, lensRadius);
    const bezelShape = buildInsertShape(def.shape, def.size * 0.74);

    const iGroup = new THREE.Group();
    iGroup.name = `Insert_${def.lampId}`;
    iGroup.position.set(def.position.x, insertY, def.position.z);
    iGroup.rotation.order = 'YXZ';
    iGroup.rotation.y = def.rotation;

    // Tilt ramp chase chevrons upward strictly along their local travel direction
    if (isRampChase) {
      iGroup.rotation.x = 0.24;
    }

    // Dark recessed mounting bezel
    const bezelMesh = new THREE.Mesh(
      trackGeo(new THREE.ShapeGeometry(bezelShape)),
      darkBezelMat,
    );
    bezelMesh.rotation.x = -Math.PI / 2;
    bezelMesh.position.y = -0.0015;
    iGroup.add(bezelMesh);

    const useStencil =
      Boolean(def.label) &&
      (def.shape === 'circle' || def.shape === 'diamond' || def.shape === 'star');
    const stencilTex =
      useStencil && def.label ? getInsertStencilTexture(def.label, def.shape) : null;

    // Backlit colored translucent acrylic insert lens
    const lensGeo = trackGeo(new THREE.ShapeGeometry(lensShape));
    if (stencilTex) {
      normalizeShapeUVs(lensGeo, lensRadius);
    }

    const lensMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: def.color,
        map: stencilTex ?? null,
        emissive: def.color,
        emissiveMap: stencilTex ?? null,
        emissiveIntensity: 0.08,
        roughness: 0.14,
        metalness: 0.05,
      }),
    );
    const lensMesh = new THREE.Mesh(lensGeo, lensMat);
    lensMesh.rotation.x = -Math.PI / 2;
    lensMesh.position.y = 0.001;
    iGroup.add(lensMesh);

    group.add(iGroup);

    insertRigs.push({
      lampId: def.lampId,
      lensMat,
      baseColor: def.color,
      isRampChase,
    });
  }

  // 4 Physical Translucent Flasher Strobe Domes mounted at FLASHER_LAMPS
  const flasherDomeRigs: FlasherDomeRig[] = [];
  const flasherBaseGeo = trackGeo(new THREE.CylinderGeometry(0.18, 0.22, 0.12, 16));
  const flasherCapGeo = trackGeo(new THREE.SphereGeometry(0.18, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.6));

  for (const fl of FLASHER_LAMPS) {
    const fGroup = new THREE.Group();
    fGroup.name = `FlasherDome_${fl.lampId}`;
    fGroup.position.set(fl.position.x, fl.position.y, fl.position.z);

    const base = new THREE.Mesh(flasherBaseGeo, chromeMat);
    fGroup.add(base);

    const domeMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: fl.color,
        emissive: fl.color,
        emissiveIntensity: 0.12,
        roughness: 0.12,
        metalness: 0.08,
        transparent: true,
        opacity: 0.85,
      }),
    );
    const dome = new THREE.Mesh(flasherCapGeo, domeMat);
    dome.position.y = 0.04;
    fGroup.add(dome);

    group.add(fGroup);

    flasherDomeRigs.push({
      lampId: fl.lampId,
      domeMat,
      baseColor: fl.color,
    });
  }

  // -------------------------------------------------------------------------
  // 16. Ultra-Reflective Chrome Pinball Pool (MAX_BALLS = 3) + Contact Shadows
  // -------------------------------------------------------------------------
  const ballMicroTex = trackTex(createBallMicroGlintTexture());
  const shadowTex = trackTex(createContactShadowTexture());

  const ballSphereGeo = trackGeo(new THREE.SphereGeometry(BALL_RADIUS, 32, 24));
  const ballMaterial = trackMat(
    new THREE.MeshPhysicalMaterial({
      color: PALETTE.ballSteel,
      metalness: 1.0,
      roughness: 1.0,
      roughnessMap: ballMicroTex ?? null,
      clearcoat: 1.0,
      clearcoatRoughness: 0.03,
      envMapIntensity: 1.85,
    }),
  );
  if (!ballMicroTex) {
    ballMaterial.roughness = 0.05;
  }

  const shadowPlaneGeo = trackGeo(new THREE.PlaneGeometry(BALL_RADIUS * 2.85, BALL_RADIUS * 2.85));

  const ballPool: BallPoolEntry[] = [];
  for (let i = 0; i < MAX_BALLS; i++) {
    const sphere = new THREE.Mesh(ballSphereGeo, ballMaterial);
    sphere.name = `Pinball_${i}`;
    sphere.castShadow = true;
    sphere.receiveShadow = false;
    sphere.visible = false;
    group.add(sphere);

    const shadowMat = trackMat(
      new THREE.MeshBasicMaterial({
        color: 0x000000,
        map: shadowTex ?? null,
        transparent: true,
        opacity: 0.62,
        depthWrite: false,
      }),
    );
    const shadow = new THREE.Mesh(shadowPlaneGeo, shadowMat);
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.008;
    shadow.renderOrder = 3;
    shadow.visible = false;
    group.add(shadow);

    ballPool.push({ sphere, shadow, shadowMat });
  }

  // -------------------------------------------------------------------------
  // Runtime Animation & State Synchronization
  // -------------------------------------------------------------------------
  const syncBalls = (balls: readonly BallState[]): void => {
    let slot = 0;
    for (let i = 0; i < balls.length && slot < ballPool.length; i++) {
      const b = balls[i];
      if (!b.active || b.zone === 'drained') continue;

      const entry = ballPool[slot++];
      entry.sphere.visible = true;
      entry.sphere.position.set(b.position.x, b.position.y, b.position.z);
      entry.sphere.quaternion.set(b.rotation.x, b.rotation.y, b.rotation.z, b.rotation.w);

      // Soft contact shadow decal directly beneath ball on playfield surface (Y = 0.008)
      const altitude = Math.max(0, b.position.y - BALL_RADIUS);
      const shadowScale = 1.0 + Math.min(1.6, altitude * 0.65);
      const shadowOpacity = Math.max(0.08, 0.66 * Math.exp(-altitude * 0.95));

      entry.shadow.visible = true;
      entry.shadow.position.set(b.position.x, 0.008, b.position.z);
      entry.shadow.scale.set(shadowScale, shadowScale, 1);
      entry.shadowMat.opacity = shadowOpacity;
    }

    // Hide unused pooled balls
    for (; slot < ballPool.length; slot++) {
      ballPool[slot].sphere.visible = false;
      ballPool[slot].shadow.visible = false;
    }
  };

  const setFlipperAngle = (idOrSide: FlipperSide | string, angleRad: number): void => {
    const bySide = flipperGroupsBySide.get(idOrSide as FlipperSide);
    if (bySide) {
      bySide.rotation.y = angleRad;
      return;
    }
    const byId = flipperGroupsById.get(idOrSide);
    if (byId) {
      byId.rotation.y = angleRad;
    }
  };

  const setDropTargetDropped = (index: number, dropped: boolean): void => {
    const rig = dropTargetRigs[index];
    if (!rig) return;
    rig.targetDropped = dropped;
  };

  const triggerStandupHit = (index: number): void => {
    const rig = standupRigs[index];
    if (!rig) return;
    rig.recoil = 1.0;
    rig.hitFlash = 1.0;
  };

  const setSpinnerAngle = (angleRad: number): void => {
    spinnerBladePivot.rotation.x = angleRad;
  };

  const triggerBumperKick = (index: number): void => {
    const rig = bumperRigs[index];
    if (!rig) return;
    rig.kickAnim = 1.0;
    rig.kickFlash = 1.0;
  };

  const triggerSlingshotKick = (indexOrSide: number | 'left' | 'right'): void => {
    const idx =
      typeof indexOrSide === 'number'
        ? indexOrSide
        : indexOrSide === 'left'
          ? 0
          : 1;
    const rig = slingshotRigs[idx];
    if (!rig) return;
    rig.kickAnim = 1.0;
    rig.kickFlash = 1.0;
  };

  const triggerGateSwing = (): void => {
    gateSwingVel = 14.0 * gateSwingSign;
  };

  const applyLamps = (lampStates: LampStateCollection): void => {
    // 1. 38 Recessed LED Inserts + Warp Ramp sequential chase chevrons
    for (const rig of insertRigs) {
      const state = readLamp(lampStates, rig.lampId);
      const intensity = state ? Math.min(1.6, Math.max(0, state.intensity)) : 0;
      const colorHex = state ? state.color : rig.baseColor;

      rig.lensMat.color.setHex(colorHex);
      rig.lensMat.emissive.setHex(colorHex);

      // Calibrated so unlit inserts sit as subtle dark colored jewels (0.04) while lit
      // inserts glow with saturated arcade neon without clipping white or obscuring legends
      const boost = rig.isRampChase ? 1.15 : 0.95;
      rig.lensMat.emissiveIntensity = 0.04 + intensity * boost;
    }

    // 2. Pop Bumpers (combined lamp state + transient solenoid hit flash)
    for (const rig of bumperRigs) {
      const state = readLamp(lampStates, rig.lampId);
      const baseInt = state ? Math.min(1.2, Math.max(0, state.intensity)) : 0.2;
      const colorHex = state ? state.color : rig.baseColor;
      const total = Math.min(1.85, baseInt + rig.kickFlash * 0.95);

      rig.domeMat.emissive.setHex(colorHex);
      rig.coreMat.emissive.setHex(colorHex);
      rig.domeMat.emissiveIntensity = 0.16 + total * 0.68;
      rig.coreMat.emissiveIntensity = 0.2 + total * 0.86;
    }

    // 3. Slingshots (lamp state + kick flash)
    for (const rig of slingshotRigs) {
      const state = readLamp(lampStates, rig.lampId);
      const baseInt = state ? Math.min(1.2, Math.max(0, state.intensity)) : 0.18;
      const colorHex = state ? state.color : rig.baseColor;
      const total = Math.min(1.85, baseInt + rig.kickFlash * 1.0);

      rig.glowCoreMat.emissive.setHex(colorHex);
      rig.glowCoreMat.emissiveIntensity = 0.14 + total * 0.78;
    }

    // 4. Drop Target & Standup emissive accents
    for (const rig of dropTargetRigs) {
      const state = readLamp(lampStates, rig.lampId);
      const intensity = state ? Math.min(1.2, Math.max(0, state.intensity)) : 0.2;
      rig.bladeMat.emissiveIntensity = 0.16 + intensity * 0.62;
    }

    for (const rig of standupRigs) {
      const state = readLamp(lampStates, rig.lampId);
      const intensity = state ? Math.min(1.2, Math.max(0, state.intensity)) : 0.18;
      rig.padMat.emissiveIntensity = 0.16 + intensity * 0.62 + rig.hitFlash * 0.85;
    }

    // 5. Kickback emerald glow reflects shield_kickback state
    const kbState = readLamp(lampStates, KICKBACK.lampId);
    kbTipMat.emissiveIntensity = kbState
      ? 0.14 + Math.min(1.3, Math.max(0, kbState.intensity)) * 0.95
      : 0.1;

    // 6. Hypercore saucer rim responds subtly to arrow_hypercore / flasher_hypercore
    const hcFlash = readLamp(lampStates, 'flasher_hypercore');
    const hcArrow = readLamp(lampStates, 'arrow_hypercore');
    const hcGlow = Math.min(1.5, Math.max(hcFlash?.intensity ?? 0, (hcArrow?.intensity ?? 0) * 0.7));
    saucerRimMat.emissiveIntensity = 0.35 + hcGlow * 0.9;

    // 7. 4 Physical Flasher Domes
    for (const rig of flasherDomeRigs) {
      const state = readLamp(lampStates, rig.lampId);
      const intensity = state ? Math.min(1.8, Math.max(0, state.intensity)) : 0;
      const colorHex = state ? state.color : rig.baseColor;
      rig.domeMat.color.setHex(colorHex);
      rig.domeMat.emissive.setHex(colorHex);
      rig.domeMat.emissiveIntensity = 0.06 + intensity * 1.45;
    }
  };

  const update = (dt: number): void => {
    const safeDt = Math.min(0.05, Math.max(0, dt));

    // Pop bumper vertical solenoid ring kick + flash decay
    for (const rig of bumperRigs) {
      if (rig.kickAnim > 0) {
        rig.kickAnim = Math.max(0, rig.kickAnim - safeDt * 9.5);
        // Fast downward snap then spring return
        const snap = Math.sin(rig.kickAnim * Math.PI);
        rig.kickRingGroup.position.y = 0.29 - snap * 0.145;
        const scale = 1.0 + snap * 0.085;
        rig.kickRingGroup.scale.set(scale, 1, scale);
      } else {
        rig.kickRingGroup.position.y = 0.29;
        rig.kickRingGroup.scale.set(1, 1, 1);
      }
      if (rig.kickFlash > 0) {
        rig.kickFlash = Math.max(0, rig.kickFlash - safeDt * 6.5);
      }
    }

    // Slingshot active-rubber outward kick flex + flash decay
    for (const rig of slingshotRigs) {
      if (rig.kickAnim > 0) {
        rig.kickAnim = Math.max(0, rig.kickAnim - safeDt * 12.0);
        const bulge = Math.sin(rig.kickAnim * Math.PI) * 0.12;
        rig.activeRubberMesh.position.set(
          rig.baseRubberPos.x + rig.kickNormal.x * bulge,
          rig.baseRubberPos.y,
          rig.baseRubberPos.z + rig.kickNormal.z * bulge,
        );
      } else {
        rig.activeRubberMesh.position.copy(rig.baseRubberPos);
      }
      if (rig.kickFlash > 0) {
        rig.kickFlash = Math.max(0, rig.kickFlash - safeDt * 7.0);
      }
    }

    // Drop target smooth vertical retraction / pop-up solenoid reset
    for (const rig of dropTargetRigs) {
      const target = rig.targetDropped ? 1 : 0;
      const diff = target - rig.currentDropT;
      if (Math.abs(diff) > 0.001) {
        const speed = rig.targetDropped ? 18.0 : 12.0;
        rig.currentDropT += Math.sign(diff) * Math.min(Math.abs(diff), safeDt * speed);
        rig.bladeGroup.position.y = -rig.currentDropT * rig.dropDepth;
      }
    }

    // Standup target spring recoil & flash decay
    for (const rig of standupRigs) {
      if (rig.recoil > 0) {
        rig.recoil = Math.max(0, rig.recoil - safeDt * 11.0);
        rig.pivotGroup.rotation.x = -Math.sin(rig.recoil * Math.PI) * 0.22;
      } else {
        rig.pivotGroup.rotation.x = 0;
      }
      if (rig.hitFlash > 0) {
        rig.hitFlash = Math.max(0, rig.hitFlash - safeDt * 6.5);
      }
    }

    // One-way shooter wire gate spring damping
    if (Math.abs(gateSwingAngle) > 0.001 || Math.abs(gateSwingVel) > 0.001) {
      const k = 110;
      const c = 12;
      const accel = -k * gateSwingAngle - c * gateSwingVel;
      gateSwingVel += accel * safeDt;
      gateSwingAngle += gateSwingVel * safeDt;
      // Prevent swinging backwards through the one-way stop
      if (gateSwingSign > 0 && gateSwingAngle < 0) {
        gateSwingAngle = 0;
        gateSwingVel = 0;
      } else if (gateSwingSign < 0 && gateSwingAngle > 0) {
        gateSwingAngle = 0;
        gateSwingVel = 0;
      }
      gateSwingAngle = Math.max(-1.05, Math.min(1.05, gateSwingAngle));
      gateFlapPivot.rotation.x = gateSwingAngle;
    }
  };

  const setPlayfieldTextures = (bundle: PlayfieldTextureBundle): void => {
    deckMaterial.map = bundle.map;
    deckMaterial.roughnessMap = bundle.roughnessMap;
    deckMaterial.bumpMap = bundle.bumpMap;
    bundle.map.needsUpdate = true;
    bundle.roughnessMap.needsUpdate = true;
    bundle.bumpMap.needsUpdate = true;
    deckMaterial.needsUpdate = true;
  };

  const dispose = (): void => {
    for (const geo of ownedGeometries) geo.dispose();
    for (const mat of ownedMaterials) mat.dispose();
    for (const tex of ownedTextures) tex.dispose();
  };

  return {
    group,
    update,
    syncBalls,
    setFlipperAngle,
    setDropTargetDropped,
    triggerStandupHit,
    setSpinnerAngle,
    triggerBumperKick,
    triggerSlingshotKick,
    triggerGateSwing,
    applyLamps,
    setPlayfieldTextures,
    dispose,
  };
}
