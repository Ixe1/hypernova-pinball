/**
 * HYPERNOVA — Shared Core TypeScript Contracts
 *
 * Consumed across physics, gameplay rules, 3D graphics, audio integration, and UI.
 */

// ---------------------------------------------------------------------------
// Geometry & Transform Primitives
// ---------------------------------------------------------------------------

/** 2D coordinate on the playfield XZ plane (Y = 0). */
export interface Vec2 {
  readonly x: number;
  readonly z: number;
}

/** 3D coordinate in playfield-local space (+X right, +Y up, +Z toward player). */
export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Unit quaternion matching Rapier3D / Three.js `(x, y, z, w)` layout. */
export interface Quat {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
}

// ---------------------------------------------------------------------------
// Physics Colliders & Events
// ---------------------------------------------------------------------------

export type FlipperSide = 'left' | 'right' | 'upperRight';

export type ColliderKind =
  | 'playfield'
  | 'wall'
  | 'post'
  | 'flipper'
  | 'plunger'
  | 'bumper'
  | 'slingshot'
  | 'dropTarget'
  | 'standup'
  | 'rollover'
  | 'spinner'
  | 'saucer'
  | 'ramp'
  | 'rampEntry'
  | 'rampApex'
  | 'orbitLeft'
  | 'orbitRight'
  | 'inlaneLeft'
  | 'inlaneRight'
  | 'outlaneLeft'
  | 'outlaneRight'
  | 'kickback'
  | 'drain'
  | 'shooterLane'
  | 'oneWayGate'
  | 'ball';

export interface ColliderTag {
  readonly kind: ColliderKind;
  readonly id: string;
  /** Zero-based index inside a bank/group (e.g. bumper 0..2, dropTarget 0..2, ballId). */
  readonly index?: number;
  /** Logical side for flippers, slingshots, lanes, or orbits. */
  readonly side?: FlipperSide;
  /** Outward kick normal in XZ for active kickers (slingshots, kickback). */
  readonly normal?: Vec2;
  /** Semantic display label (e.g. 'I', 'O', 'N', 'R', 'A', 'Y'). */
  readonly label?: string;
}

export type PhysicsEvent =
  | {
      readonly type: 'bumper';
      readonly id: string;
      readonly index: number;
      readonly ballId: number;
      readonly position: Vec3;
      readonly impactSpeed: number;
    }
  | {
      readonly type: 'slingshot';
      readonly id: string;
      readonly side: 'left' | 'right';
      readonly ballId: number;
      readonly position: Vec3;
      readonly impactSpeed: number;
    }
  | {
      readonly type: 'dropTarget';
      readonly id: string;
      readonly index: number;
      readonly label: string;
      readonly ballId: number;
      readonly position: Vec3;
    }
  | {
      readonly type: 'standup';
      readonly id: string;
      readonly index: number;
      readonly ballId: number;
      readonly position: Vec3;
    }
  | {
      readonly type: 'rollover';
      readonly id: string;
      readonly index: number;
      readonly label: string;
      readonly ballId: number;
      readonly position: Vec3;
    }
  | {
      readonly type: 'lane';
      readonly id: string;
      readonly lane: 'inlaneLeft' | 'inlaneRight' | 'outlaneLeft' | 'outlaneRight';
      readonly ballId: number;
      readonly position: Vec3;
    }
  | {
      readonly type: 'orbit';
      readonly id: string;
      readonly side: 'left' | 'right';
      readonly ballId: number;
      readonly speed: number;
      readonly position: Vec3;
    }
  | {
      readonly type: 'spinner';
      readonly id: string;
      readonly ballId: number;
      readonly angularVelocity: number;
      readonly halfRevolutions: number;
      readonly position: Vec3;
    }
  | {
      readonly type: 'saucerCapture';
      readonly id: string;
      readonly ballId: number;
      readonly position: Vec3;
    }
  | {
      readonly type: 'saucerEject';
      readonly id: string;
      readonly ballId: number;
      readonly position: Vec3;
    }
  | {
      readonly type: 'rampEntry';
      readonly id: string;
      readonly ballId: number;
      readonly position: Vec3;
    }
  | {
      readonly type: 'rampRollback';
      readonly id: string;
      readonly ballId: number;
      readonly position: Vec3;
    }
  | {
      readonly type: 'rampComplete';
      readonly id: string;
      readonly ballId: number;
      readonly position: Vec3;
    }
  | {
      readonly type: 'wireformExit';
      readonly ballId: number;
      readonly position: Vec3;
    }
  | {
      readonly type: 'kickback';
      readonly id: string;
      readonly ballId: number;
      readonly position: Vec3;
    }
  | {
      readonly type: 'drain';
      readonly ballId: number;
      readonly position: Vec3;
    }
  | {
      readonly type: 'plungerLaunch';
      readonly ballId: number;
      readonly tension: number;
      readonly speed: number;
    }
  | {
      readonly type: 'shooterExit';
      readonly ballId: number;
      readonly speed: number;
    }
  | {
      readonly type: 'wallHit';
      readonly ballId: number;
      readonly impactSpeed: number;
      readonly position: Vec3;
    }
  | {
      readonly type: 'ballCollision';
      readonly ballIdA: number;
      readonly ballIdB: number;
      readonly impactSpeed: number;
      readonly position: Vec3;
    }
  | {
      readonly type: 'flipperHit';
      readonly side: FlipperSide;
      readonly ballId: number;
      readonly impactSpeed: number;
      readonly position: Vec3;
    };

// ---------------------------------------------------------------------------
// Ball State
// ---------------------------------------------------------------------------

export type BallZone = 'shooter' | 'playfield' | 'ramp' | 'wireform' | 'saucer' | 'drained';

export interface BallState {
  readonly id: number;
  readonly position: Vec3;
  readonly rotation: Quat;
  readonly velocity: Vec3;
  readonly speed: number;
  readonly zone: BallZone;
  readonly active: boolean;
}

// ---------------------------------------------------------------------------
// Lamp Matrix & Lightshows
// ---------------------------------------------------------------------------

export type LampId =
  // Top I-O-N rollover lanes (3)
  | 'lane_i'
  | 'lane_o'
  | 'lane_n'
  // Major shot arrows (6)
  | 'arrow_left_orbit'
  | 'arrow_warp_ramp'
  | 'arrow_hypercore'
  | 'arrow_right_orbit'
  | 'arrow_upper_ramp'
  | 'arrow_upper_drop'
  // R-A-Y drop target indicators (3)
  | 'drop_r'
  | 'drop_a'
  | 'drop_y'
  // Right standup target indicators (3)
  | 'standup_1'
  | 'standup_2'
  | 'standup_3'
  // Hypercore lock & multiball jackpot inserts (5)
  | 'lock_1'
  | 'lock_2'
  | 'lock_3'
  | 'jackpot'
  | 'super_jackpot'
  // Playfield multiplier inserts (3)
  | 'pf_2x'
  | 'pf_3x'
  | 'pf_5x'
  // End-of-ball bonus multiplier inserts (5)
  | 'bonus_2x'
  | 'bonus_3x'
  | 'bonus_4x'
  | 'bonus_5x'
  | 'bonus_6x'
  // Lower playfield utility & lane inserts (6)
  | 'shield_kickback'
  | 'inlane_left'
  | 'inlane_right'
  | 'outlane_right'
  | 'extra_ball'
  | 'hyper_save'
  // Warp Ramp sequential chase LEDs (4)
  | 'ramp_chase_1'
  | 'ramp_chase_2'
  | 'ramp_chase_3'
  | 'ramp_chase_4'
  // Feature mechanism lamps (5)
  | 'bumper_1'
  | 'bumper_2'
  | 'bumper_3'
  | 'sling_left'
  | 'sling_right'
  // High-intensity flasher domes (4)
  | 'flasher_left'
  | 'flasher_right'
  | 'flasher_hypercore'
  | 'flasher_ramp';

export type LampMode = 'off' | 'on' | 'blinkSlow' | 'blinkFast' | 'pulse' | 'flash';

export interface LampState {
  readonly id: LampId;
  /** Emissive intensity (0 = off, 1 = steady full, up to ~2.5 during flasher bursts). */
  readonly intensity: number;
  /** Current 24-bit RGB hex color. */
  readonly color: number;
  readonly mode: LampMode;
}

// ---------------------------------------------------------------------------
// DMD & Gameplay State Snapshot
// ---------------------------------------------------------------------------

export type GamePhase =
  | 'ATTRACT'
  | 'LAUNCH_READY'
  | 'PLAYING'
  | 'BALL_BONUS'
  | 'GAME_OVER'
  | 'HIGH_SCORE_ENTRY';

export type DmdBannerPriority = 'low' | 'normal' | 'high' | 'critical';
export type DmdBannerEffect = 'scroll' | 'flash' | 'zoom' | 'wipe' | 'static';

export interface DmdBanner {
  readonly id: number;
  readonly title: string;
  readonly subtitle?: string;
  readonly duration: number; // seconds
  readonly priority: DmdBannerPriority;
  readonly effect?: DmdBannerEffect;
}

export interface BonusBreakdown {
  readonly baseBonus: number;
  readonly multiplier: number;
  readonly totalBonus: number;
  readonly step: number;
  readonly totalSteps: number;
}

export interface GameSnapshot {
  readonly phase: GamePhase;
  readonly score: number;
  readonly highScore: number;
  readonly ballNumber: number;
  readonly totalBalls: number;
  readonly extraBalls: number;
  readonly bonusPoints: number;
  readonly bonusMultiplier: number; // 1..6
  readonly playfieldMultiplier: number; // 1, 2, 3, 5
  readonly playfieldMultiplierTimer: number; // seconds remaining
  readonly rampComboCount: number;
  readonly rampComboTimer: number; // seconds remaining
  readonly skillShotActive: boolean;
  readonly skillShotLaneIndex: number; // 0=I, 1=O, 2=N
  readonly ionLanes: readonly [boolean, boolean, boolean];
  readonly dropTargets: readonly [boolean, boolean, boolean]; // true = knocked down
  readonly standupTargets: readonly [boolean, boolean, boolean]; // true = hit/lit
  readonly kickbackLit: boolean;
  readonly lockLit: boolean;
  readonly lockedBalls: number; // 0..3
  readonly multiballActive: boolean;
  readonly jackpotLit: boolean;
  readonly superJackpotLit: boolean;
  readonly ballSaveActive: boolean;
  readonly ballSaveTimer: number;
  readonly extraBallLit: boolean;
  readonly activeBallCount: number;
  readonly tiltWarnings: number; // 0..3
  readonly isTilted: boolean;
  readonly activeBanner: DmdBanner | null;
  readonly bonusBreakdown: BonusBreakdown | null;
  readonly qualifiesForHighScore: boolean;
  readonly paused: boolean;
}

// ---------------------------------------------------------------------------
// Camera, Settings, Input & High Scores
// ---------------------------------------------------------------------------

export type CameraMode = 'classic' | 'dynamic' | 'lowAction' | 'overhead';
export type QualityLevel = 'high' | 'medium';
export type GlassMode = 'off' | 'subtle' | 'realistic';

export interface SettingsState {
  readonly quality: QualityLevel;
  readonly glassMode: GlassMode;
  readonly cameraMode: CameraMode;
  readonly muted: boolean;
  readonly masterVolume: number; // 0..1
  readonly sfxVolume: number; // 0..1
  readonly musicVolume: number; // 0..1
  readonly musicEnabled: boolean;
  readonly showDmdMirror: boolean;
}

export interface InputState {
  leftFlipper: boolean;
  rightFlipper: boolean;
  plungerHeld: boolean;
  /** Pointer-drag plunger tension override in [0, 1], or null for keyboard hold mode. */
  plungerDragTension: number | null;
  nudgeLeft: boolean;
  nudgeRight: boolean;
  nudgeUp: boolean;
}

export interface HighScoreEntry {
  readonly initials: string; // 3 uppercase letters
  readonly score: number;
  readonly date?: string;
}
