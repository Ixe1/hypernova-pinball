/**
 * HYPERNOVA — Core Physical, Timing, Collision, and Theme Constants
 *
 * World scale: 1 unit = 5 cm (0.05 m; 20x SI scale) so Rapier3D contact slop
 * remains < 0.7% of the ball radius and shadow maps stay crisp.
 *
 * Coordinate convention (playfield-local frame):
 *   +X : right across the playfield
 *   +Y : upward perpendicular to the playfield surface (surface at Y = 0)
 *   +Z : down the playfield toward the player / flippers / drain
 */

// ---------------------------------------------------------------------------
// World Scale & Playfield Dimensions
// ---------------------------------------------------------------------------
export const WORLD_SCALE = 20; // 20 world units = 1 meter (1 unit = 5 cm)
export const CM_PER_UNIT = 5;
export const METERS_PER_UNIT = 0.05;

export const PLAYFIELD_WIDTH = 10.4; // 52 cm (regulation standard-body width)
export const PLAYFIELD_LENGTH = 21.2; // 106 cm (regulation playfield length)

export const PLAYFIELD_MIN_X = -5.2;
export const PLAYFIELD_MAX_X = 5.2;
export const PLAYFIELD_MIN_Z = -10.6;
export const PLAYFIELD_MAX_Z = 10.6;
export const PLAYFIELD_Y = 0;

/** Center X of the vertical shooter-lane divider wall (thickness 0.15: [4.15, 4.30]). */
export const SHOOTER_WALL_X = 4.225;
export const SHOOTER_WALL_HALF_THICKNESS = 0.075;

/** Active playfield X bounds (left cabinet wall to left face of shooter divider). */
export const ACTIVE_PLAYFIELD_MIN_X = -5.2;
export const ACTIVE_PLAYFIELD_MAX_X = 4.15;
export const ACTIVE_PLAYFIELD_WIDTH = 9.35;
export const ACTIVE_CENTER_X = -0.525;

/** Shooter lane X bounds (right face of shooter divider to right cabinet wall). */
export const SHOOTER_LANE_MIN_X = 4.3;
export const SHOOTER_LANE_MAX_X = 5.2;
export const SHOOTER_LANE_WIDTH = 0.9;
export const SHOOTER_LANE_CENTER_X = 4.75;

/** Standard wall height on the playfield surface (in world units). */
export const PLAYFIELD_WALL_HEIGHT = 0.85;
/** Height of the cabinet playfield glass above the playfield surface. */
export const PLAYFIELD_GLASS_Y = 2.65;

// ---------------------------------------------------------------------------
// Pinball Physical Properties
// ---------------------------------------------------------------------------
export const BALL_RADIUS = 0.27; // diameter = 0.54 units = 27 mm regulation pinball
export const BALL_DIAMETER = BALL_RADIUS * 2;
export const BALL_MASS = 0.08; // 80 g steel pinball
export const BALL_RESTITUTION = 0.45;
export const BALL_FRICTION = 0.12;
export const BALL_LINEAR_DAMPING = 0.08;
export const BALL_ANGULAR_DAMPING = 0.12;
export const MAX_BALLS = 3;

// ---------------------------------------------------------------------------
// Table Pitch & Gravity (6.5 degrees)
// ---------------------------------------------------------------------------
export const TABLE_PITCH_DEG = 6.5;
export const TABLE_PITCH_RAD = (TABLE_PITCH_DEG * Math.PI) / 180;

/** 9.81 m/s^2 * 20 units/m = 196.2 units/s^2. */
export const GRAVITY_MAGNITUDE = 9.81 * WORLD_SCALE; // 196.2
/** Exact Y component: -196.2 * cos(6.5 deg) ≈ -194.9388 units/s^2. */
export const GRAVITY_Y = -GRAVITY_MAGNITUDE * Math.cos(TABLE_PITCH_RAD);
/** Exact Z component: +196.2 * sin(6.5 deg) ≈ +22.2105 units/s^2. */
export const GRAVITY_Z = GRAVITY_MAGNITUDE * Math.sin(TABLE_PITCH_RAD);

export const GRAVITY = {
  x: 0,
  y: GRAVITY_Y,
  z: GRAVITY_Z,
} as const;

// ---------------------------------------------------------------------------
// Simulation Timing
// ---------------------------------------------------------------------------
export const PHYSICS_HZ = 480;
export const FIXED_DT = 1 / PHYSICS_HZ;
export const MAX_FRAME_DT = 1 / 30;

// ---------------------------------------------------------------------------
// Rapier3D 16-bit Collision Groups
// ---------------------------------------------------------------------------
/** Static/kinematic playfield geometry: floor, walls, posts, flippers, bumpers, targets. */
export const GROUP_PLAYFIELD = 0x0001;
/** Elevated Warp Ramp geometry: ascending deck & ramp guardrails. */
export const GROUP_RAMP = 0x0002;
/** Active pinball rigid bodies. */
export const GROUP_BALL = 0x0004;
/** Trigger-only sensor colliders: rollovers, drain, saucer, ramp entry/apex, spinner, lanes. */
export const GROUP_SENSOR = 0x0008;

/**
 * Packs 16-bit Rapier membership (upper 16 bits) and filter (lower 16 bits)
 * into an unsigned 32-bit interaction groups bitmask.
 *
 * Two colliders interact iff:
 *   (A.membership & B.filter) !== 0 && (B.membership & A.filter) !== 0
 */
export function makeInteractionGroups(membership: number, filter: number): number {
  return (((membership & 0xffff) << 16) | (filter & 0xffff)) >>> 0;
}

/** Pre-packed standard interaction groups for consistent usage across physics modules. */
export const INTERACTION_PLAYFIELD_SOLID = makeInteractionGroups(GROUP_PLAYFIELD, GROUP_BALL);
export const INTERACTION_RAMP_SOLID = makeInteractionGroups(GROUP_RAMP, GROUP_BALL);
export const INTERACTION_SENSOR = makeInteractionGroups(GROUP_SENSOR, GROUP_BALL);
export const INTERACTION_BALL_PLAYFIELD = makeInteractionGroups(
  GROUP_BALL,
  GROUP_PLAYFIELD | GROUP_BALL | GROUP_SENSOR,
);
export const INTERACTION_BALL_RAMP = makeInteractionGroups(
  GROUP_BALL,
  GROUP_RAMP | GROUP_BALL | GROUP_SENSOR,
);
export const INTERACTION_DISABLED = makeInteractionGroups(0, 0);

// ---------------------------------------------------------------------------
// Physics Mechanism Tuning Defaults
// ---------------------------------------------------------------------------
export const FLIPPER_UP_SPEED = 21.0; // rad/s (~54 deg in ~45 ms, <2.5 deg/substep at 480 Hz)
export const FLIPPER_DOWN_SPEED = 14.0; // rad/s (spring return)
export const FLIPPER_RESTITUTION = 0.18; // low bounce for cradling & live catches
export const FLIPPER_FRICTION = 0.35;

export const BUMPER_IMPULSE_SPEED = 26.5; // outward kick velocity (units/s)
export const SLINGSHOT_IMPULSE_SPEED = 28.0; // active face rebound velocity (units/s)
export const KICKBACK_IMPULSE_SPEED = 44.0; // left outlane shield kickback velocity (units/s)
export const SAUCER_HOLD_DURATION = 1.1; // seconds held in Hypercore before eject
export const SAUCER_EJECT_SPEED = 24.0; // calibrated to feed the right flipper cleanly

export const PLUNGER_MAX_SPEED = 66.0; // full-pull launch velocity (units/s)
export const PLUNGER_MIN_SPEED = 16.0; // tap-launch velocity (units/s)
export const PLUNGER_JITTER = 0.015; // +/- 1.5% realistic spring variance

export const WIREFORM_DRAG = 0.14; // mild chrome rail rolling drag (1/s)
export const MIN_WIREFORM_SPEED = 7.5; // guarantees smooth travel down to left inlane

export const ANTI_STUCK_TIMEOUT = 4.0; // seconds stationary before gentle nudge recovery
export const ANTI_STUCK_SPEED_THRESHOLD = 0.45; // units/s

// ---------------------------------------------------------------------------
// Gameplay Rule Constants
// ---------------------------------------------------------------------------
export const TOTAL_BALLS_PER_GAME = 3;
export const SKILL_SHOT_WINDOW_SEC = 5.0;
export const BALL_SAVE_DURATION_SEC = 12.0;
export const MULTIBALL_BALL_SAVE_SEC = 15.0;
export const RAMP_COMBO_WINDOW_SEC = 6.5;
export const PLAYFIELD_MULT_DURATION_SEC = 20.0;
export const EXTRA_BALL_SCORE_THRESHOLD = 500_000;
export const MAX_BONUS_MULTIPLIER = 6;

// ---------------------------------------------------------------------------
// HYPERNOVA 1990s Cosmic Sci-Fi Theme Palette
// ---------------------------------------------------------------------------
export const PALETTE = {
  // Space & Cabinet darks
  bgDeep: 0x050712,
  arcadeFloor: 0x090b18,
  playfieldBase: 0x0a1026,
  cobaltDark: 0x101c42,
  indigoMid: 0x1e2b6b,
  cabinetBlack: 0x0d1018,
  cabinetTrim: 0x181f30,

  // Neon Cyan
  cyan: 0x00f0ff,
  cyanGlow: 0x66f7ff,
  cyanDim: 0x004c59,

  // Laser Magenta
  magenta: 0xff2bd6,
  magentaGlow: 0xff7ae8,
  magentaDim: 0x5c0e4d,

  // Plasma Violet
  violet: 0x8b3dff,
  violetGlow: 0xbc8cff,
  violetDim: 0x2f125c,

  // Amber DMD & Gold
  amber: 0xff9b1a,
  amberBright: 0xffd04d,
  amberDim: 0x422000,
  gold: 0xffd740,

  // Shield Emerald & Warning Crimson
  emerald: 0x00ff9d,
  emeraldDim: 0x004d30,
  crimson: 0xff2644,
  redPlunger: 0xe61c38,

  // Hardware / Chrome / Rubber
  chrome: 0xe4ebf5,
  brushedSteel: 0xb8c4d4,
  ballSteel: 0xf2f6ff,
  ivoryFlipper: 0xf4f0e6,
  rubberWhite: 0xe8edf2,
  rubberBlack: 0x1c2028,
} as const;

export const PALETTE_CSS = {
  bgDeep: '#050712',
  playfieldBase: '#0a1026',
  cobaltDark: '#101c42',
  indigoMid: '#1e2b6b',
  cyan: '#00f0ff',
  cyanGlow: '#66f7ff',
  magenta: '#ff2bd6',
  magentaGlow: '#ff7ae8',
  violet: '#8b3dff',
  amber: '#ff9b1a',
  amberBright: '#ffd04d',
  amberDim: '#422000',
  gold: '#ffd740',
  emerald: '#00ff9d',
  crimson: '#ff2644',
  chrome: '#e4ebf5',
} as const;
