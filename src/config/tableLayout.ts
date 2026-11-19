/**
 * HYPERNOVA — Parametric Playfield Geometry & Layout Specification
 *
 * Single source of truth consumed by BOTH:
 *   - Physics collider builders (`src/physics/TableColliders.ts`, `FlipperPhysics.ts`,
 *     `PlungerPhysics.ts`, `WireformRail.ts`, `BallManager.ts`)
 *   - 3D visual builders (`src/graphics/PlayfieldMeshBuilder.ts`, `PlayfieldTextures.ts`,
 *     `HypercoreToy.ts`, `LampController.ts`)
 *
 * Coordinate frame:
 *   Playfield surface is the XZ plane at Y = 0.
 *   +X = right, +Y = up, +Z = down toward flippers/drain.
 *   All 2D points use `{ x, z }` (`Vec2`); all 3D spline points use `{ x, y, z }` (`Vec3`).
 *
 * Clearances verified mathematically across every lane, channel, and obstacle pair:
 *   - Ball diameter = 0.54 units (radius 0.27).
 *   - Every passable channel >= 0.88 units (>= 1.63x ball diameter).
 *   - Pop bumper center-to-center = 1.88..2.49 units (>= 1.85 with radius 0.45).
 *   - Main flipper tip gap at rest = 1.07 units (1.98x ball diameter).
 */

import {
  ACTIVE_CENTER_X,
  BALL_RADIUS,
  PALETTE,
  PLAYFIELD_MAX_X,
  PLAYFIELD_MAX_Z,
  PLAYFIELD_MIN_X,
  PLAYFIELD_WALL_HEIGHT,
  SHOOTER_LANE_CENTER_X,
  SHOOTER_WALL_HALF_THICKNESS,
  SHOOTER_WALL_X,
} from './constants';
import type { FlipperSide, LampId, Vec2, Vec3 } from './types';

// ---------------------------------------------------------------------------
// Layout Schema Interfaces
// ---------------------------------------------------------------------------

export type WallMaterialKind = 'metal' | 'plastic' | 'rubber' | 'apron' | 'cabinet';

export interface WallPolylineDef {
  readonly id: string;
  /** Centerline vertices in XZ. Physics & meshes extrude +/- thickness/2 around these segments. */
  readonly points: readonly Vec2[];
  readonly thickness: number;
  readonly height: number;
  readonly restitution: number;
  readonly material: WallMaterialKind;
  readonly color?: number;
  /** True when the wall is an interior guide rail with rounded end caps. */
  readonly roundedCaps?: boolean;
}

export interface RubberPostDef {
  readonly id: string;
  readonly position: Vec2;
  readonly radius: number;
  readonly height: number;
  readonly restitution: number;
  readonly color: number;
}

export interface OneWayGateDef {
  readonly id: string;
  /** Hinge endpoint (on shooter inner arch). */
  readonly start: Vec2;
  /** Free endpoint (on outer top arch). */
  readonly end: Vec2;
  readonly center: Vec2;
  /** Unit vector pointing in the ALLOWED travel direction (exiting shooter into top arch). */
  readonly allowedDirection: Vec2;
  readonly width: number;
  readonly height: number;
}

export interface FlipperDef {
  readonly id: string;
  readonly side: FlipperSide;
  readonly pivot: Vec2;
  /** Pivot-to-tip center distance. */
  readonly length: number;
  readonly baseRadius: number;
  readonly tipRadius: number;
  readonly height: number;
  /**
   * Local arm direction along X before Y-rotation:
   *   +1 for left flipper (extends toward +X)
   *   -1 for right & upper-right flippers (extend toward -X)
   *
   * Under right-handed Y rotation `angle`:
   *   armDir = (direction * cos(angle), -direction * sin(angle))
   *   - Left  (dir +1): restAngle = -28 deg -> (+cos 28, +sin 28) down-right;
   *                     activeAngle = +26 deg -> (+cos 26, -sin 26) up-right.
   *   - Right (dir -1): restAngle = +28 deg -> (-cos 28, +sin 28) down-left;
   *                     activeAngle = -26 deg -> (-cos 26, -sin 26) up-left.
   */
  readonly direction: 1 | -1;
  readonly restAngle: number; // radians
  readonly activeAngle: number; // radians
  readonly color: number;
  readonly rubberColor: number;
}

export interface PlungerDef {
  readonly laneCenterX: number;
  readonly ballSpawnPosition: Vec3;
  readonly tipRestZ: number;
  readonly maxPullDistance: number;
  readonly tipRadius: number;
  readonly sensorCenter: Vec2;
  readonly sensorHalfExtents: Vec2;
}

export interface PopBumperDef {
  readonly id: string;
  readonly index: number;
  readonly position: Vec2;
  readonly radius: number;
  readonly height: number;
  readonly color: number;
  readonly lampId: LampId;
}

export interface SlingshotDef {
  readonly id: string;
  readonly side: 'left' | 'right';
  /** Triangle vertices [top, bottomOuter, bottomInner] (post centers). */
  readonly vertices: readonly [Vec2, Vec2, Vec2];
  /** Active kicking edge endpoints [top, bottomInner]. */
  readonly activeEdge: readonly [Vec2, Vec2];
  /** Unit outward kick normal pointing into the lower-mid playfield. */
  readonly kickNormal: Vec2;
  readonly postRadius: number;
  readonly height: number;
  readonly color: number;
  readonly lampId: LampId;
}

export interface DropTargetDef {
  readonly id: string;
  readonly index: number;
  readonly label: string;
  readonly position: Vec2;
  readonly width: number;
  readonly depth: number;
  readonly height: number;
  /** Outward facing normal in XZ (pointing into playfield). */
  readonly normal: Vec2;
  /** Y-axis rotation (radians) orienting local +Z along `normal`. */
  readonly angleY: number;
  readonly color: number;
  readonly lampId: LampId;
}

export interface StandupTargetDef {
  readonly id: string;
  readonly index: number;
  readonly label: string;
  readonly position: Vec2;
  readonly width: number;
  readonly depth: number;
  readonly height: number;
  readonly normal: Vec2;
  readonly angleY: number;
  readonly color: number;
  readonly lampId: LampId;
}

export interface RolloverLaneDef {
  readonly id: string;
  readonly index: number;
  readonly label: string;
  readonly position: Vec2;
  readonly sensorHalfWidth: number;
  readonly sensorHalfLength: number;
  readonly lampId: LampId;
}

export interface SpinnerDef {
  readonly id: string;
  readonly position: Vec2;
  readonly width: number;
  readonly bladeHeight: number;
  readonly pivotY: number;
  readonly sensorHalfDepth: number;
  readonly color: number;
}

export interface SaucerDef {
  readonly id: string;
  readonly position: Vec2;
  readonly captureRadius: number;
  readonly backstopRadius: number;
  /** Calibrated unit eject direction in XZ (feeds cleanly onto the right flipper). */
  readonly ejectDirection: Vec2;
  /** Floating Y height of the glowing Hypercore Plasma Reactor orb above the saucer. */
  readonly orbCenterY: number;
}

export interface KickbackDef {
  readonly id: string;
  readonly position: Vec2;
  readonly sensorHalfExtents: Vec2;
  readonly kickDirection: Vec2;
  readonly lampId: LampId;
}

export interface BoxSensorDef {
  readonly id: string;
  readonly position: Vec2;
  readonly halfExtents: Vec2;
}

export interface WarpRampDef {
  readonly id: string;
  /** Clear interior deck width between guardrails. */
  readonly width: number;
  readonly deckThickness: number;
  readonly guardrailThickness: number;
  readonly guardrailHeight: number;
  /**
   * 3D spline control points representing the RAMP DECK SURFACE centerline.
   * Starts with a flat lead-in lip at Y = 0 just before the entrance sensor so
   * balls transitioning onto GROUP_RAMP are immediately supported with zero drop.
   * Ascends smoothly from (-3.1, 0, -2.6) to apex at (-3.80, 1.45, -8.10).
   */
  readonly controlPoints: readonly Vec3[];
  readonly entrySensor: {
    readonly position: Vec3;
    readonly halfExtents: Vec3;
    /** Approximate unit direction into the ramp (used to distinguish climb vs rollback). */
    readonly entryDirection: Vec2;
  };
  readonly apexSensor: {
    readonly position: Vec3;
    readonly radius: number;
  };
}

export interface WireformRailDef {
  readonly id: string;
  /** Lateral center-to-center spacing between the twin chrome steel tubes. */
  readonly railGauge: number;
  readonly tubeRadius: number;
  /** Vertical offset of tube centers below ball center (~0.277 so the 0.27 ball cradles cleanly). */
  readonly tubeVerticalOffset: number;
  /**
   * 3D spline control points representing the BALL CENTER trajectory.
   * Begins at (-3.80, 1.72, -8.10) — exact continuity with a ball of radius 0.27
   * cresting the ramp apex deck at Y = 1.45 — and descends monotonically to
   * (-3.75, 0.35, +5.00) cleanly over the left inlane.
   */
  readonly controlPoints: readonly Vec3[];
}

export type InsertShape = 'circle' | 'arrow' | 'chevron' | 'star' | 'diamond' | 'bar';

export interface LedInsertDef {
  readonly lampId: LampId;
  readonly position: Vec2;
  /** Optional elevation above playfield surface (default 0.004; elevated for ramp chase LEDs). */
  readonly y?: number;
  readonly shape: InsertShape;
  readonly size: number;
  /** Rotation in radians around +Y (0 = pointing toward -Z / up the playfield). */
  readonly rotation: number;
  readonly color: number;
  readonly label?: string;
}

export interface FlasherLampDef {
  readonly lampId: LampId;
  readonly position: Vec3;
  readonly color: number;
}

export interface TableLayout {
  readonly walls: readonly WallPolylineDef[];
  readonly posts: readonly RubberPostDef[];
  readonly oneWayGate: OneWayGateDef;
  readonly flippers: readonly FlipperDef[];
  readonly plunger: PlungerDef;
  readonly popBumpers: readonly PopBumperDef[];
  readonly slingshots: readonly SlingshotDef[];
  readonly dropTargets: readonly DropTargetDef[];
  readonly standupTargets: readonly StandupTargetDef[];
  readonly rolloverLanes: readonly RolloverLaneDef[];
  readonly spinner: SpinnerDef;
  readonly saucer: SaucerDef;
  readonly kickback: KickbackDef;
  readonly sensors: {
    readonly drain: BoxSensorDef;
    readonly inlaneLeft: BoxSensorDef;
    readonly inlaneRight: BoxSensorDef;
    readonly outlaneLeft: BoxSensorDef;
    readonly outlaneRight: BoxSensorDef;
    readonly orbitLeft: BoxSensorDef;
    readonly orbitRight: BoxSensorDef;
  };
  readonly warpRamp: WarpRampDef;
  readonly wireformRail: WireformRailDef;
  readonly ledInserts: readonly LedInsertDef[];
  readonly flasherLamps: readonly FlasherLampDef[];
}

// ---------------------------------------------------------------------------
// Parametric Curve Builders
// ---------------------------------------------------------------------------

const DEG_TO_RAD = Math.PI / 180;

/** Samples an arc in XZ centered at (cx, cz) from startAngle to endAngle (0 = +X, pi/2 = -Z). */
function sampleUpperArc(
  cx: number,
  cz: number,
  radius: number,
  startRad: number,
  endRad: number,
  segments: number,
): Vec2[] {
  const pts: Vec2[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const theta = startRad + (endRad - startRad) * t;
    pts.push({
      x: Number((cx + radius * Math.cos(theta)).toFixed(4)),
      z: Number((cz - radius * Math.sin(theta)).toFixed(4)),
    });
  }
  return pts;
}

// Outer perimeter wall: centerline offset outward by OUTER_WALL_HALF_T = 0.15
// so the inner colliding surface lies EXACTLY on X = -5.20, X = +5.20, R_arch = 5.20, Z = +10.60.
const OUTER_WALL_THICKNESS = 0.3;
const OUTER_WALL_HALF_T = OUTER_WALL_THICKNESS / 2; // 0.15
const ARCH_CENTER_Z = -5.4;
const ARCH_INNER_RADIUS = 5.2; // touches Z = -5.4 - 5.2 = -10.60 exactly
const ARCH_CENTERLINE_RADIUS = ARCH_INNER_RADIUS + OUTER_WALL_HALF_T; // 5.35

const outerPerimeterPoints: Vec2[] = [
  { x: PLAYFIELD_MIN_X - OUTER_WALL_HALF_T, z: PLAYFIELD_MAX_Z + OUTER_WALL_HALF_T },
  ...sampleUpperArc(0, ARCH_CENTER_Z, ARCH_CENTERLINE_RADIUS, Math.PI, 0, 28),
  { x: PLAYFIELD_MAX_X + OUTER_WALL_HALF_T, z: PLAYFIELD_MAX_Z + OUTER_WALL_HALF_T },
];

// Shooter lane divider: straight at X = 4.225 (inner active face 4.15, shooter face 4.30)
// curving smoothly up to theta = 42 deg along concentric inner arch R = 4.225.
const SHOOTER_GATE_THETA_RAD = 42 * DEG_TO_RAD;
const shooterDividerPoints: Vec2[] = [
  { x: SHOOTER_WALL_X, z: PLAYFIELD_MAX_Z },
  ...sampleUpperArc(0, ARCH_CENTER_Z, SHOOTER_WALL_X, 0, SHOOTER_GATE_THETA_RAD, 10),
];

// One-way gate endpoints spanning the 0.90-unit shooter exit channel at theta = 42 deg.
const SHOOTER_INNER_OUTER_FACE_R = SHOOTER_WALL_X + SHOOTER_WALL_HALF_THICKNESS; // 4.30
const gateStart: Vec2 = {
  x: Number((SHOOTER_INNER_OUTER_FACE_R * Math.cos(SHOOTER_GATE_THETA_RAD)).toFixed(4)),
  z: Number((ARCH_CENTER_Z - SHOOTER_INNER_OUTER_FACE_R * Math.sin(SHOOTER_GATE_THETA_RAD)).toFixed(4)),
};
const gateEnd: Vec2 = {
  x: Number((ARCH_INNER_RADIUS * Math.cos(SHOOTER_GATE_THETA_RAD)).toFixed(4)),
  z: Number((ARCH_CENTER_Z - ARCH_INNER_RADIUS * Math.sin(SHOOTER_GATE_THETA_RAD)).toFixed(4)),
};

// Hypercore Saucer horseshoe backstop (wraps around -Z back half from 20 deg to 160 deg).
const HYPERCORE_CENTER: Vec2 = { x: ACTIVE_CENTER_X, z: -4.2 };
const HYPERCORE_BACKSTOP_RADIUS = 0.62;
const hypercoreBackstopPoints: Vec2[] = sampleUpperArc(
  HYPERCORE_CENTER.x,
  HYPERCORE_CENTER.z,
  HYPERCORE_BACKSTOP_RADIUS,
  20 * DEG_TO_RAD,
  160 * DEG_TO_RAD,
  10,
);

// ---------------------------------------------------------------------------
// Playfield Walls & Guides
// ---------------------------------------------------------------------------

export const WALLS: readonly WallPolylineDef[] = [
  {
    id: 'outer_perimeter',
    points: outerPerimeterPoints,
    thickness: OUTER_WALL_THICKNESS,
    height: PLAYFIELD_WALL_HEIGHT + 0.35,
    restitution: 0.45,
    material: 'cabinet',
    color: PALETTE.cabinetTrim,
  },
  {
    id: 'bottom_backstop',
    points: [
      { x: PLAYFIELD_MIN_X - OUTER_WALL_HALF_T, z: PLAYFIELD_MAX_Z + OUTER_WALL_HALF_T },
      { x: PLAYFIELD_MAX_X + OUTER_WALL_HALF_T, z: PLAYFIELD_MAX_Z + OUTER_WALL_HALF_T },
    ],
    thickness: OUTER_WALL_THICKNESS,
    height: PLAYFIELD_WALL_HEIGHT,
    restitution: 0.25,
    material: 'cabinet',
    color: PALETTE.cabinetBlack,
  },
  {
    id: 'shooter_divider',
    points: shooterDividerPoints,
    thickness: SHOOTER_WALL_HALF_THICKNESS * 2, // 0.15
    height: PLAYFIELD_WALL_HEIGHT,
    restitution: 0.42,
    material: 'metal',
    color: PALETTE.brushedSteel,
    roundedCaps: true,
  },
  {
    id: 'apron_left',
    points: [
      { x: -5.2, z: 7.9 },
      { x: -1.25, z: 10.23 },
    ],
    thickness: 0.16,
    height: PLAYFIELD_WALL_HEIGHT,
    restitution: 0.3,
    material: 'apron',
    color: PALETTE.brushedSteel,
  },
  {
    id: 'apron_right',
    points: [
      { x: 4.15, z: 7.9 },
      { x: 0.2, z: 10.23 },
    ],
    thickness: 0.16,
    height: PLAYFIELD_WALL_HEIGHT,
    restitution: 0.3,
    material: 'apron',
    color: PALETTE.brushedSteel,
  },
  // Left inlane/outlane divider sloping cleanly onto resting left flipper (-2.55, 7.95)
  {
    id: 'inlane_guide_left',
    points: [
      { x: -4.24, z: 3.9 },
      { x: -4.24, z: 6.75 },
      { x: -2.72, z: 7.65 },
    ],
    thickness: 0.12,
    height: 0.52,
    restitution: 0.32,
    material: 'metal',
    color: PALETTE.chrome,
    roundedCaps: true,
  },
  // Right inlane/outlane divider sloping cleanly onto resting right flipper (+1.50, 7.95)
  {
    id: 'inlane_guide_right',
    points: [
      { x: 3.19, z: 3.9 },
      { x: 3.19, z: 6.75 },
      { x: 1.67, z: 7.65 },
    ],
    thickness: 0.12,
    height: 0.52,
    restitution: 0.32,
    material: 'metal',
    color: PALETTE.chrome,
    roundedCaps: true,
  },
  // Upper-right mini-flipper feed guide lip
  {
    id: 'upper_flipper_feed',
    points: [
      { x: 4.15, z: -1.35 },
      { x: 3.74, z: -0.35 },
    ],
    thickness: 0.12,
    height: 0.52,
    restitution: 0.32,
    material: 'metal',
    color: PALETTE.chrome,
    roundedCaps: true,
  },
  // Backing plate behind left R-A-Y drop targets (seals cabinet when targets drop)
  {
    id: 'drop_bank_backing',
    points: [
      { x: -5.2, z: -0.15 },
      { x: -4.98, z: 0.4 },
      { x: -4.84, z: 1.8 },
      { x: -5.2, z: 2.35 },
    ],
    thickness: 0.12,
    height: 0.62,
    restitution: 0.4,
    material: 'plastic',
    color: PALETTE.cobaltDark,
  },
  // Backing plate behind right 3-bank standups
  {
    id: 'standup_bank_backing',
    points: [
      { x: 4.15, z: 0.85 },
      { x: 3.9, z: 1.3 },
      { x: 4.1, z: 2.55 },
      { x: 4.15, z: 2.95 },
    ],
    thickness: 0.12,
    height: 0.62,
    restitution: 0.4,
    material: 'plastic',
    color: PALETTE.cobaltDark,
  },
  // Playfield-level entrance guide separating Left Orbit from Warp Ramp mouth
  {
    id: 'ramp_funnel_left',
    points: [
      { x: -3.88, z: -2.1 },
      { x: -3.98, z: -2.85 },
    ],
    thickness: 0.14,
    height: 0.6,
    restitution: 0.48,
    material: 'metal',
    color: PALETTE.chrome,
    roundedCaps: true,
  },
  // Playfield-level right entrance guide of Warp Ramp mouth
  {
    id: 'ramp_funnel_right',
    points: [
      { x: -2.22, z: -2.35 },
      { x: -2.4, z: -3.1 },
    ],
    thickness: 0.14,
    height: 0.6,
    restitution: 0.48,
    material: 'metal',
    color: PALETTE.chrome,
    roundedCaps: true,
  },
  // Hypercore Lock Saucer horseshoe pocket backstop
  {
    id: 'hypercore_backstop',
    points: hypercoreBackstopPoints,
    thickness: 0.14,
    height: 0.68,
    restitution: 0.4,
    material: 'metal',
    color: PALETTE.violet,
    roundedCaps: true,
  },
  // Top I-O-N rollover lane fins (clear lane widths = 0.88 units each)
  {
    id: 'ion_fin_0',
    points: [
      { x: -0.95, z: -8.55 },
      { x: -0.95, z: -7.4 },
    ],
    thickness: 0.12,
    height: 0.56,
    restitution: 0.5,
    material: 'plastic',
    color: PALETTE.cyan,
    roundedCaps: true,
  },
  {
    id: 'ion_fin_1',
    points: [
      { x: 0.05, z: -8.55 },
      { x: 0.05, z: -7.4 },
    ],
    thickness: 0.12,
    height: 0.56,
    restitution: 0.5,
    material: 'plastic',
    color: PALETTE.cyan,
    roundedCaps: true,
  },
  {
    id: 'ion_fin_2',
    points: [
      { x: 1.05, z: -8.55 },
      { x: 1.05, z: -7.4 },
    ],
    thickness: 0.12,
    height: 0.56,
    restitution: 0.5,
    material: 'plastic',
    color: PALETTE.cyan,
    roundedCaps: true,
  },
  {
    id: 'ion_fin_3',
    points: [
      { x: 2.05, z: -8.55 },
      { x: 2.05, z: -7.4 },
    ],
    thickness: 0.12,
    height: 0.56,
    restitution: 0.5,
    material: 'plastic',
    color: PALETTE.cyan,
    roundedCaps: true,
  },
];

// ---------------------------------------------------------------------------
// Rubber-Ringed Chrome Posts
// ---------------------------------------------------------------------------

export const RUBBER_POSTS: readonly RubberPostDef[] = [
  {
    id: 'post_inlane_left_top',
    position: { x: -4.24, z: 3.9 },
    radius: 0.12,
    height: 0.6,
    restitution: 0.72,
    color: PALETTE.cyan,
  },
  {
    id: 'post_inlane_right_top',
    position: { x: 3.19, z: 3.9 },
    radius: 0.12,
    height: 0.6,
    restitution: 0.72,
    color: PALETTE.cyan,
  },
  {
    id: 'post_ramp_mouth_left',
    position: { x: -3.88, z: -2.1 },
    radius: 0.15,
    height: 0.64,
    restitution: 0.74,
    color: PALETTE.magenta,
  },
  {
    id: 'post_ramp_mouth_right',
    position: { x: -2.22, z: -2.35 },
    radius: 0.15,
    height: 0.64,
    restitution: 0.74,
    color: PALETTE.magenta,
  },
];

// ---------------------------------------------------------------------------
// One-Way Shooter Gate
// ---------------------------------------------------------------------------

export const ONE_WAY_GATE: OneWayGateDef = {
  id: 'shooter_one_way_gate',
  start: gateStart,
  end: gateEnd,
  center: {
    x: Number(((gateStart.x + gateEnd.x) / 2).toFixed(4)),
    z: Number(((gateStart.z + gateEnd.z) / 2).toFixed(4)),
  },
  // Counter-clockwise tangent at theta = 42 deg: (-sin 42, -cos 42)
  allowedDirection: {
    x: Number((-Math.sin(SHOOTER_GATE_THETA_RAD)).toFixed(4)),
    z: Number((-Math.cos(SHOOTER_GATE_THETA_RAD)).toFixed(4)),
  },
  width: 0.9,
  height: 0.72,
};

// ---------------------------------------------------------------------------
// Flippers (2 Main + 1 Upper-Right Mini-Flipper)
// ---------------------------------------------------------------------------

export const FLIPPERS: readonly FlipperDef[] = [
  {
    id: 'flipper_left',
    side: 'left',
    pivot: { x: -2.55, z: 7.95 },
    length: 1.54,
    baseRadius: 0.22,
    tipRadius: 0.13,
    height: 0.48,
    direction: 1,
    restAngle: -28 * DEG_TO_RAD,
    activeAngle: 26 * DEG_TO_RAD,
    color: PALETTE.ivoryFlipper,
    rubberColor: PALETTE.cyan,
  },
  {
    id: 'flipper_right',
    side: 'right',
    pivot: { x: 1.5, z: 7.95 },
    length: 1.54,
    baseRadius: 0.22,
    tipRadius: 0.13,
    height: 0.48,
    direction: -1,
    restAngle: 28 * DEG_TO_RAD,
    activeAngle: -26 * DEG_TO_RAD,
    color: PALETTE.ivoryFlipper,
    rubberColor: PALETTE.cyan,
  },
  {
    id: 'flipper_upper_right',
    side: 'upperRight',
    pivot: { x: 3.55, z: -0.25 },
    length: 1.15,
    baseRadius: 0.18,
    tipRadius: 0.11,
    height: 0.46,
    direction: -1,
    restAngle: 32 * DEG_TO_RAD,
    activeAngle: -22 * DEG_TO_RAD,
    color: PALETTE.ivoryFlipper,
    rubberColor: PALETTE.magenta,
  },
];

/**
 * Computes the world-space XZ center of a flipper's tip at a given Y-rotation angle.
 * Shared helper for both physics tests and visual alignment verification.
 */
export function getFlipperTipPosition(flipper: FlipperDef, angle: number): Vec2 {
  const dirX = flipper.direction * Math.cos(angle);
  const dirZ = -flipper.direction * Math.sin(angle);
  return {
    x: flipper.pivot.x + dirX * flipper.length,
    z: flipper.pivot.z + dirZ * flipper.length,
  };
}

// ---------------------------------------------------------------------------
// Spring Plunger
// ---------------------------------------------------------------------------

export const PLUNGER: PlungerDef = {
  laneCenterX: SHOOTER_LANE_CENTER_X, // 4.75
  ballSpawnPosition: { x: SHOOTER_LANE_CENTER_X, y: BALL_RADIUS, z: 8.8 },
  tipRestZ: 8.8 + BALL_RADIUS, // 9.07
  maxPullDistance: 1.2,
  tipRadius: 0.24,
  sensorCenter: { x: SHOOTER_LANE_CENTER_X, z: 8.0 },
  sensorHalfExtents: { x: 0.42, z: 2.1 },
};

// ---------------------------------------------------------------------------
// Pop Bumpers (3 in Upper-Right Pocket; c2c = 1.88, 1.91, 2.49 >= 1.85)
// ---------------------------------------------------------------------------

export const POP_BUMPERS: readonly PopBumperDef[] = [
  {
    id: 'bumper_0',
    index: 0,
    position: { x: 1.1, z: -5.75 },
    radius: 0.45,
    height: 0.78,
    color: PALETTE.magenta,
    lampId: 'bumper_1',
  },
  {
    id: 'bumper_1',
    index: 1,
    position: { x: 2.8, z: -4.95 },
    radius: 0.45,
    height: 0.78,
    color: PALETTE.cyan,
    lampId: 'bumper_2',
  },
  {
    id: 'bumper_2',
    index: 2,
    position: { x: 1.75, z: -3.35 },
    radius: 0.45,
    height: 0.78,
    color: PALETTE.amber,
    lampId: 'bumper_3',
  },
];

// ---------------------------------------------------------------------------
// Twin Triangular Slingshots (Symmetric around ACTIVE_CENTER_X = -0.525)
// ---------------------------------------------------------------------------

export const SLINGSHOTS: readonly SlingshotDef[] = [
  {
    id: 'sling_left',
    side: 'left',
    vertices: [
      { x: -3.08, z: 3.7 },
      { x: -3.08, z: 5.7 },
      { x: -1.95, z: 6.37 },
    ],
    activeEdge: [
      { x: -3.08, z: 3.7 },
      { x: -1.95, z: 6.37 },
    ],
    kickNormal: { x: 0.9209, z: -0.3898 },
    postRadius: 0.14,
    height: 0.58,
    color: PALETTE.cyan,
    lampId: 'sling_left',
  },
  {
    id: 'sling_right',
    side: 'right',
    vertices: [
      { x: 2.03, z: 3.7 },
      { x: 2.03, z: 5.7 },
      { x: 0.9, z: 6.37 },
    ],
    activeEdge: [
      { x: 2.03, z: 3.7 },
      { x: 0.9, z: 6.37 },
    ],
    kickNormal: { x: -0.9209, z: -0.3898 },
    postRadius: 0.14,
    height: 0.58,
    color: PALETTE.magenta,
    lampId: 'sling_right',
  },
];

// ---------------------------------------------------------------------------
// Left 3-Bank Drop Targets (R - A - Y)
// ---------------------------------------------------------------------------

export const DROP_TARGETS: readonly DropTargetDef[] = [
  {
    id: 'drop_r',
    index: 0,
    label: 'R',
    position: { x: -4.81, z: 0.45 },
    width: 0.52,
    depth: 0.14,
    height: 0.5,
    normal: { x: 0.9943, z: -0.1071 },
    angleY: Math.atan2(0.9943, -0.1071),
    color: PALETTE.magenta,
    lampId: 'drop_r',
  },
  {
    id: 'drop_a',
    index: 1,
    label: 'A',
    position: { x: -4.74, z: 1.1 },
    width: 0.52,
    depth: 0.14,
    height: 0.5,
    normal: { x: 0.9943, z: -0.1071 },
    angleY: Math.atan2(0.9943, -0.1071),
    color: PALETTE.magenta,
    lampId: 'drop_a',
  },
  {
    id: 'drop_y',
    index: 2,
    label: 'Y',
    position: { x: -4.67, z: 1.75 },
    width: 0.52,
    depth: 0.14,
    height: 0.5,
    normal: { x: 0.9943, z: -0.1071 },
    angleY: Math.atan2(0.9943, -0.1071),
    color: PALETTE.magenta,
    lampId: 'drop_y',
  },
];

// ---------------------------------------------------------------------------
// Right 3-Bank Standup Targets (Playfield Multiplier)
// ---------------------------------------------------------------------------

export const STANDUP_TARGETS: readonly StandupTargetDef[] = [
  {
    id: 'standup_0',
    index: 0,
    label: '2X',
    position: { x: 3.73, z: 1.34 },
    width: 0.48,
    depth: 0.14,
    height: 0.5,
    normal: { x: -0.985, z: 0.1726 },
    angleY: Math.atan2(-0.985, 0.1726),
    color: PALETTE.emerald,
    lampId: 'standup_1',
  },
  {
    id: 'standup_1',
    index: 1,
    label: '3X',
    position: { x: 3.83, z: 1.94 },
    width: 0.48,
    depth: 0.14,
    height: 0.5,
    normal: { x: -0.985, z: 0.1726 },
    angleY: Math.atan2(-0.985, 0.1726),
    color: PALETTE.emerald,
    lampId: 'standup_2',
  },
  {
    id: 'standup_2',
    index: 2,
    label: '5X',
    position: { x: 3.93, z: 2.54 },
    width: 0.48,
    depth: 0.14,
    height: 0.5,
    normal: { x: -0.985, z: 0.1726 },
    angleY: Math.atan2(-0.985, 0.1726),
    color: PALETTE.emerald,
    lampId: 'standup_3',
  },
];

// ---------------------------------------------------------------------------
// Top I - O - N Rollover Lanes
// ---------------------------------------------------------------------------

export const ROLLOVER_LANES: readonly RolloverLaneDef[] = [
  {
    id: 'rollover_i',
    index: 0,
    label: 'I',
    position: { x: -0.45, z: -7.95 },
    sensorHalfWidth: 0.36,
    sensorHalfLength: 0.38,
    lampId: 'lane_i',
  },
  {
    id: 'rollover_o',
    index: 1,
    label: 'O',
    position: { x: 0.55, z: -7.95 },
    sensorHalfWidth: 0.36,
    sensorHalfLength: 0.38,
    lampId: 'lane_o',
  },
  {
    id: 'rollover_n',
    index: 2,
    label: 'N',
    position: { x: 1.55, z: -7.95 },
    sensorHalfWidth: 0.36,
    sensorHalfLength: 0.38,
    lampId: 'lane_n',
  },
];

// ---------------------------------------------------------------------------
// Left Orbit Metal Spinner
// ---------------------------------------------------------------------------

export const SPINNER: SpinnerDef = {
  id: 'left_orbit_spinner',
  position: { x: -4.675, z: -2.4 },
  width: 0.92,
  bladeHeight: 0.48,
  pivotY: 0.58,
  sensorHalfDepth: 0.18,
  color: PALETTE.chrome,
};

// ---------------------------------------------------------------------------
// Center HYPERCORE Lock Saucer & Plasma Reactor Toy
// ---------------------------------------------------------------------------

export const HYPERCORE_SAUCER: SaucerDef = {
  id: 'hypercore_saucer',
  position: HYPERCORE_CENTER, // (-0.525, -4.2)
  captureRadius: 0.38,
  backstopRadius: HYPERCORE_BACKSTOP_RADIUS,
  ejectDirection: { x: 0.11, z: 0.9939 },
  orbCenterY: 1.55,
};

// ---------------------------------------------------------------------------
// Left Outlane Shield Kickback
// ---------------------------------------------------------------------------

export const KICKBACK: KickbackDef = {
  id: 'shield_kickback',
  position: { x: -4.75, z: 6.55 },
  sensorHalfExtents: { x: 0.38, z: 0.45 },
  kickDirection: { x: 0.045, z: -0.999 },
  lampId: 'shield_kickback',
};

// ---------------------------------------------------------------------------
// Lane, Orbit & Drain Trigger Sensors
// ---------------------------------------------------------------------------

export const SENSORS = {
  drain: {
    id: 'sensor_drain',
    position: { x: ACTIVE_CENTER_X, z: 10.35 },
    halfExtents: { x: 0.95, z: 0.22 },
  },
  inlaneLeft: {
    id: 'sensor_inlane_left',
    position: { x: -3.7, z: 5.6 },
    halfExtents: { x: 0.38, z: 0.35 },
  },
  inlaneRight: {
    id: 'sensor_inlane_right',
    position: { x: 2.65, z: 5.6 },
    halfExtents: { x: 0.38, z: 0.35 },
  },
  outlaneLeft: {
    id: 'sensor_outlane_left',
    position: { x: -4.75, z: 5.05 },
    halfExtents: { x: 0.38, z: 0.35 },
  },
  outlaneRight: {
    id: 'sensor_outlane_right',
    position: { x: 3.7, z: 5.05 },
    halfExtents: { x: 0.38, z: 0.35 },
  },
  orbitLeft: {
    id: 'sensor_orbit_left',
    position: { x: -4.675, z: -3.8 },
    halfExtents: { x: 0.48, z: 0.35 },
  },
  orbitRight: {
    id: 'sensor_orbit_right',
    position: { x: 3.65, z: -3.2 },
    halfExtents: { x: 0.45, z: 0.35 },
  },
} as const;

// ---------------------------------------------------------------------------
// Elevated WARP RAMP & Descending Chrome WIREFORM Habitrail
// ---------------------------------------------------------------------------

export const WARP_RAMP: WarpRampDef = {
  id: 'warp_ramp',
  width: 1.12,
  deckThickness: 0.08,
  guardrailThickness: 0.06,
  guardrailHeight: 0.48,
  controlPoints: [
    // Flat lead-in slightly ahead of entry sensor so GROUP_RAMP supports ball immediately
    { x: -3.02, y: 0.0, z: -2.15 },
    // Ramp mouth (exact spec coordinate)
    { x: -3.1, y: 0.0, z: -2.6 },
    { x: -3.05, y: 0.32, z: -4.15 },
    { x: -2.75, y: 0.72, z: -5.7 },
    { x: -2.55, y: 1.12, z: -7.15 },
    { x: -2.95, y: 1.38, z: -8.15 },
    // Ramp apex deck at Y = 1.45 (ball center = 1.72, exact match with wireform start)
    { x: -3.8, y: 1.45, z: -8.1 },
  ],
  entrySensor: {
    position: { x: -3.1, y: 0.27, z: -2.6 },
    halfExtents: { x: 0.56, y: 0.35, z: 0.32 },
    entryDirection: { x: -0.15, z: -0.9887 },
  },
  apexSensor: {
    position: { x: -3.8, y: 1.45 + BALL_RADIUS, z: -8.1 },
    radius: 0.5,
  },
};

export const WIREFORM_RAIL: WireformRailDef = {
  id: 'wireform_return',
  railGauge: 0.3,
  tubeRadius: 0.045,
  // sqrt((BALL_RADIUS + tubeRadius)^2 - (railGauge / 2)^2) = sqrt(0.315^2 - 0.15^2) = 0.277
  tubeVerticalOffset: 0.277,
  // Monotonically descending ball-center path from ramp apex (Y = 1.45 + 0.27 = 1.72)
  // around outer upper-left edge and cleanly over left inlane at (-3.75, 0.35, +5.0).
  controlPoints: [
    { x: -3.8, y: 1.45 + BALL_RADIUS, z: -8.1 },
    { x: -4.45, y: 1.62, z: -7.25 },
    { x: -4.6, y: 1.44, z: -5.4 },
    { x: -4.6, y: 1.24, z: -3.1 },
    { x: -4.55, y: 1.02, z: -0.6 },
    { x: -4.4, y: 0.86, z: 1.65 },
    { x: -4.0, y: 0.58, z: 3.6 },
    { x: -3.75, y: 0.35, z: 5.0 },
  ],
};

// ---------------------------------------------------------------------------
// 38 Recessed Playfield & Ramp LED Inserts Mapped to LampId
// ---------------------------------------------------------------------------

export const LED_INSERTS: readonly LedInsertDef[] = [
  // Top I-O-N rollover lanes (3)
  { lampId: 'lane_i', position: { x: -0.45, z: -7.95 }, shape: 'circle', size: 0.34, rotation: 0, color: PALETTE.cyan, label: 'I' },
  { lampId: 'lane_o', position: { x: 0.55, z: -7.95 }, shape: 'circle', size: 0.34, rotation: 0, color: PALETTE.cyan, label: 'O' },
  { lampId: 'lane_n', position: { x: 1.55, z: -7.95 }, shape: 'circle', size: 0.34, rotation: 0, color: PALETTE.cyan, label: 'N' },

  // Major shot arrows (6)
  { lampId: 'arrow_left_orbit', position: { x: -4.6, z: -1.15 }, shape: 'arrow', size: 0.44, rotation: 0, color: PALETTE.cyan, label: 'ORBIT' },
  { lampId: 'arrow_warp_ramp', position: { x: -2.9, z: -1.25 }, shape: 'arrow', size: 0.48, rotation: 0.16, color: PALETTE.magenta, label: 'WARP' },
  { lampId: 'arrow_hypercore', position: { x: ACTIVE_CENTER_X, z: -2.55 }, shape: 'arrow', size: 0.5, rotation: 0, color: PALETTE.violet, label: 'LOCK' },
  { lampId: 'arrow_right_orbit', position: { x: 3.4, z: -2.35 }, shape: 'arrow', size: 0.44, rotation: -0.22, color: PALETTE.cyan, label: 'ORBIT' },
  { lampId: 'arrow_upper_ramp', position: { x: 1.5, z: -0.95 }, shape: 'arrow', size: 0.42, rotation: 1.15, color: PALETTE.magenta, label: 'WARP' },
  { lampId: 'arrow_upper_drop', position: { x: 1.45, z: 0.45 }, shape: 'arrow', size: 0.42, rotation: 1.65, color: PALETTE.amber, label: 'RAY' },

  // R-A-Y drop target indicators (3)
  { lampId: 'drop_r', position: { x: -4.15, z: 0.45 }, shape: 'diamond', size: 0.3, rotation: 0, color: PALETTE.magenta, label: 'R' },
  { lampId: 'drop_a', position: { x: -4.08, z: 1.1 }, shape: 'diamond', size: 0.3, rotation: 0, color: PALETTE.magenta, label: 'A' },
  { lampId: 'drop_y', position: { x: -4.01, z: 1.75 }, shape: 'diamond', size: 0.3, rotation: 0, color: PALETTE.magenta, label: 'Y' },

  // Right standup target indicators (3)
  { lampId: 'standup_1', position: { x: 3.1, z: 1.34 }, shape: 'diamond', size: 0.3, rotation: 0, color: PALETTE.emerald, label: '2X' },
  { lampId: 'standup_2', position: { x: 3.2, z: 1.94 }, shape: 'diamond', size: 0.3, rotation: 0, color: PALETTE.emerald, label: '3X' },
  { lampId: 'standup_3', position: { x: 3.3, z: 2.54 }, shape: 'diamond', size: 0.3, rotation: 0, color: PALETTE.emerald, label: '5X' },

  // Hypercore Lock & Multiball Jackpot cluster (5)
  { lampId: 'lock_1', position: { x: -1.25, z: -1.55 }, shape: 'circle', size: 0.3, rotation: 0, color: PALETTE.cyan, label: 'L1' },
  { lampId: 'lock_2', position: { x: ACTIVE_CENTER_X, z: -1.75 }, shape: 'circle', size: 0.3, rotation: 0, color: PALETTE.violet, label: 'L2' },
  { lampId: 'lock_3', position: { x: 0.2, z: -1.55 }, shape: 'circle', size: 0.3, rotation: 0, color: PALETTE.magenta, label: 'L3' },
  { lampId: 'jackpot', position: { x: ACTIVE_CENTER_X, z: -0.7 }, shape: 'star', size: 0.44, rotation: 0, color: PALETTE.gold, label: 'JACKPOT' },
  { lampId: 'super_jackpot', position: { x: ACTIVE_CENTER_X, z: 0.25 }, shape: 'star', size: 0.46, rotation: 0, color: PALETTE.magenta, label: 'SUPER' },

  // Playfield Multiplier cluster (3)
  { lampId: 'pf_2x', position: { x: 1.25, z: 1.75 }, shape: 'circle', size: 0.3, rotation: 0, color: PALETTE.emerald, label: '2X' },
  { lampId: 'pf_3x', position: { x: 1.6, z: 2.4 }, shape: 'circle', size: 0.3, rotation: 0, color: PALETTE.emerald, label: '3X' },
  { lampId: 'pf_5x', position: { x: 1.25, z: 3.05 }, shape: 'circle', size: 0.34, rotation: 0, color: PALETTE.gold, label: '5X' },

  // End-of-ball Bonus Multiplier arc (5)
  { lampId: 'bonus_2x', position: { x: -1.35, z: 3.45 }, shape: 'circle', size: 0.3, rotation: 0, color: PALETTE.amber, label: '2X' },
  { lampId: 'bonus_3x', position: { x: ACTIVE_CENTER_X, z: 3.2 }, shape: 'circle', size: 0.3, rotation: 0, color: PALETTE.amber, label: '3X' },
  { lampId: 'bonus_4x', position: { x: 0.3, z: 3.45 }, shape: 'circle', size: 0.3, rotation: 0, color: PALETTE.amber, label: '4X' },
  { lampId: 'bonus_5x', position: { x: -0.95, z: 4.2 }, shape: 'circle', size: 0.32, rotation: 0, color: PALETTE.amber, label: '5X' },
  { lampId: 'bonus_6x', position: { x: -0.1, z: 4.2 }, shape: 'circle', size: 0.34, rotation: 0, color: PALETTE.gold, label: '6X' },

  // Lower playfield lanes, Shield Kickback, Extra Ball & Hyper Save (6)
  { lampId: 'shield_kickback', position: { x: -4.75, z: 5.4 }, shape: 'chevron', size: 0.38, rotation: 0, color: PALETTE.emerald, label: 'SHIELD' },
  { lampId: 'inlane_left', position: { x: -3.7, z: 5.35 }, shape: 'bar', size: 0.32, rotation: 0, color: PALETTE.cyan },
  { lampId: 'inlane_right', position: { x: 2.65, z: 5.35 }, shape: 'bar', size: 0.32, rotation: 0, color: PALETTE.cyan },
  { lampId: 'outlane_right', position: { x: 3.7, z: 5.4 }, shape: 'circle', size: 0.3, rotation: 0, color: PALETTE.crimson },
  { lampId: 'extra_ball', position: { x: ACTIVE_CENTER_X, z: 5.35 }, shape: 'star', size: 0.42, rotation: 0, color: PALETTE.amber, label: 'EX BALL' },
  { lampId: 'hyper_save', position: { x: ACTIVE_CENTER_X, z: 6.65 }, shape: 'star', size: 0.48, rotation: 0, color: PALETTE.crimson, label: 'SAVE' },

  // Warp Ramp sequential chase chevrons (4 — elevated underneath ramp deck)
  { lampId: 'ramp_chase_1', position: { x: -3.08, z: -3.35 }, y: 0.14, shape: 'chevron', size: 0.36, rotation: 0.04, color: PALETTE.cyan },
  { lampId: 'ramp_chase_2', position: { x: -2.9, z: -4.9 }, y: 0.5, shape: 'chevron', size: 0.36, rotation: -0.18, color: PALETTE.cyan },
  { lampId: 'ramp_chase_3', position: { x: -2.65, z: -6.45 }, y: 0.92, shape: 'chevron', size: 0.36, rotation: -0.12, color: PALETTE.magenta },
  { lampId: 'ramp_chase_4', position: { x: -2.75, z: -7.75 }, y: 1.28, shape: 'chevron', size: 0.36, rotation: 0.42, color: PALETTE.magenta },
];

// ---------------------------------------------------------------------------
// 4 High-Intensity Playfield Flasher Domes
// ---------------------------------------------------------------------------

export const FLASHER_LAMPS: readonly FlasherLampDef[] = [
  { lampId: 'flasher_left', position: { x: -4.35, y: 1.05, z: -7.2 }, color: PALETTE.cyan },
  { lampId: 'flasher_right', position: { x: 3.45, y: 1.05, z: -7.2 }, color: PALETTE.magenta },
  { lampId: 'flasher_hypercore', position: { x: ACTIVE_CENTER_X, y: 1.75, z: -4.2 }, color: PALETTE.violet },
  { lampId: 'flasher_ramp', position: { x: -3.1, y: 1.35, z: -3.5 }, color: PALETTE.gold },
];

// ---------------------------------------------------------------------------
// Aggregate Layout Export
// ---------------------------------------------------------------------------

export const TABLE_LAYOUT: TableLayout = {
  walls: WALLS,
  posts: RUBBER_POSTS,
  oneWayGate: ONE_WAY_GATE,
  flippers: FLIPPERS,
  plunger: PLUNGER,
  popBumpers: POP_BUMPERS,
  slingshots: SLINGSHOTS,
  dropTargets: DROP_TARGETS,
  standupTargets: STANDUP_TARGETS,
  rolloverLanes: ROLLOVER_LANES,
  spinner: SPINNER,
  saucer: HYPERCORE_SAUCER,
  kickback: KICKBACK,
  sensors: SENSORS,
  warpRamp: WARP_RAMP,
  wireformRail: WIREFORM_RAIL,
  ledInserts: LED_INSERTS,
  flasherLamps: FLASHER_LAMPS,
};
