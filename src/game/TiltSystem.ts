/**
 * HYPERNOVA — Physical Damped Plumb-Bob Tilt System
 *
 * Simulates a classic arcade cabinet tilt plumb-bob pendulum in 2D (x, z):
 *   theta'' + 2 * zeta * w0 * theta' + w0^2 * theta = impulse
 *
 * - Light occasional nudges stay inside the brass contact ring and decay cleanly.
 * - Rapid or overly forceful nudging drives the bob into the ring, issuing
 *   DANGER warnings (strikes 1 and 2) and full TILT on strike 3.
 * - Enforces a mechanical nudge cooldown (~0.28 s) to prevent spam exploits.
 */

export type NudgeDirection = 'left' | 'right' | 'up';

export interface NudgeResult {
  readonly accepted: boolean;
  readonly impulseX: number;
  readonly impulseZ: number;
  readonly dangerTriggered: boolean;
  readonly tilted: boolean;
  readonly warnings: number;
}

export interface TiltUpdateResult {
  readonly dangerTriggered: boolean;
  readonly tilted: boolean;
  readonly warnings: number;
}

export interface TiltState {
  readonly bobX: number;
  readonly bobZ: number;
  readonly velX: number;
  readonly velZ: number;
  readonly displacement: number;
  readonly ringRadius: number;
  readonly cooldownRemaining: number;
  readonly warnings: number;
  readonly maxWarnings: number;
  readonly tilted: boolean;
}

export interface TiltSystemConfig {
  /** Pendulum natural angular frequency w0 (rad/s). Default: 6.5 */
  readonly naturalFrequency?: number;
  /** Damping ratio zeta (0 < zeta < 1 for underdamped swing). Default: 0.22 */
  readonly dampingRatio?: number;
  /** Normalized brass contact ring radius. Default: 1.0 */
  readonly ringRadius?: number;
  /** Minimum seconds between accepted nudges. Default: 0.28 */
  readonly nudgeCooldown?: number;
  /** Strikes required to enter full TILT. Default: 3 */
  readonly maxWarnings?: number;
  /** Pendulum velocity kick for a strength=1.0 nudge. Default: 7.8 */
  readonly bobImpulse?: number;
  /** Ball velocity delta X for lateral nudge (world units/s). Default: 5.5 */
  readonly ballImpulseX?: number;
  /** Ball upward velocity delta Z accompanying lateral nudge (world units/s). Default: -1.4 */
  readonly ballLateralLiftZ?: number;
  /** Ball upward velocity delta Z for upward nudge (world units/s). Default: -5.8 */
  readonly ballUpImpulseZ?: number;
}

const DEFAULT_CONFIG: Required<TiltSystemConfig> = {
  naturalFrequency: 6.5,
  dampingRatio: 0.22,
  ringRadius: 1.0,
  nudgeCooldown: 0.28,
  maxWarnings: 3,
  bobImpulse: 7.8,
  ballImpulseX: 5.5,
  ballLateralLiftZ: -1.4,
  ballUpImpulseZ: -5.8,
};

/** Maximum internal integration substep for unconditional ODE stability. */
const MAX_ODE_SUBSTEP = 0.005;
/** Brass contact ring restitution when the bob collides with the ring perimeter. */
const RING_BOUNCE_RESTITUTION = 0.55;
/** Forward horizon (seconds) used to check whether an energized swing reaches the ring. */
const SWING_PREDICT_HORIZON = 0.6;
const SWING_PREDICT_STEP = 0.005;
/** Minimum seconds between ring-contact warnings to avoid double-counting one impact. */
const RING_DEBOUNCE_SEC = 0.24;

export class TiltSystem {
  private readonly cfg: Required<TiltSystemConfig>;

  // 2D plumb-bob angular displacement & angular velocity
  private bobX = 0;
  private bobZ = 0;
  private velX = 0;
  private velZ = 0;

  private cooldownRemaining = 0;
  private ringDebounceRemaining = 0;
  private warnings = 0;
  private tilted = false;
  /**
   * True when `nudge()` already accounted for the upcoming ring impact on this
   * swing so the physical ring collision in `update()` does not double-count it.
   */
  private pendingPredictedStrike = false;

  constructor(config?: TiltSystemConfig) {
    this.cfg = {
      ...DEFAULT_CONFIG,
      ...config,
    };
  }

  /**
   * Attempts a cabinet nudge in the given direction (`'left' | 'right' | 'up'`).
   * Applies a physical impulse to the damped plumb-bob pendulum and returns
   * ball impulse deltas plus any immediate DANGER / TILT trigger.
   */
  nudge(direction: NudgeDirection, strength = 1.0): NudgeResult {
    if (this.tilted) {
      return {
        accepted: false,
        impulseX: 0,
        impulseZ: 0,
        dangerTriggered: false,
        tilted: true,
        warnings: this.warnings,
      };
    }

    if (this.cooldownRemaining > 0) {
      return {
        accepted: false,
        impulseX: 0,
        impulseZ: 0,
        dangerTriggered: false,
        tilted: false,
        warnings: this.warnings,
      };
    }

    const safeStrength = Number.isFinite(strength)
      ? Math.min(2.5, Math.max(0.1, strength))
      : 1.0;

    let impulseX = 0;
    let impulseZ = 0;
    let dirX = 0;
    let dirZ = 0;

    switch (direction) {
      case 'left': {
        impulseX = -this.cfg.ballImpulseX * safeStrength;
        impulseZ = this.cfg.ballLateralLiftZ * safeStrength;
        const inv = 1 / Math.hypot(-1, -0.25);
        dirX = -inv;
        dirZ = -0.25 * inv;
        break;
      }
      case 'right': {
        impulseX = this.cfg.ballImpulseX * safeStrength;
        impulseZ = this.cfg.ballLateralLiftZ * safeStrength;
        const inv = 1 / Math.hypot(1, -0.25);
        dirX = inv;
        dirZ = -0.25 * inv;
        break;
      }
      case 'up': {
        impulseX = 0;
        impulseZ = this.cfg.ballUpImpulseZ * safeStrength;
        dirX = 0;
        dirZ = -1;
        break;
      }
    }

    // Apply cabinet-recoil velocity kick to the 2D plumb-bob pendulum.
    // A real cabinet shove accelerates and abruptly arrests on its legs, so if the
    // bob is already moving opposite to the shove direction, the arrest recoil
    // reinforces the existing oscillation rather than letting spam nudges cancel it.
    let kickX = dirX * this.cfg.bobImpulse * safeStrength;
    let kickZ = dirZ * this.cfg.bobImpulse * safeStrength;

    const currentSpeed = Math.hypot(this.velX, this.velZ);
    if (currentSpeed > 0.5) {
      const dot = this.velX * kickX + this.velZ * kickZ;
      if (dot < 0) {
        kickX = -kickX;
        kickZ = -kickZ;
      }
    }

    this.velX += kickX;
    this.velZ += kickZ;
    this.cooldownRemaining = this.cfg.nudgeCooldown;
    this.pendingPredictedStrike = false;

    let dangerTriggered = false;
    if (this.willReachContactRing()) {
      dangerTriggered = this.registerStrike();
      if (dangerTriggered) {
        this.pendingPredictedStrike = true;
      }
    }

    return {
      accepted: true,
      impulseX,
      impulseZ,
      dangerTriggered,
      tilted: this.tilted,
      warnings: this.warnings,
    };
  }

  /**
   * Advances the damped plumb-bob pendulum ODE and cooldown timers by `dt` seconds.
   * Uses sub-stepped semi-implicit Euler integration so large frame or test steps
   * remain accurate and unconditionally stable.
   */
  update(dt: number): TiltUpdateResult {
    if (!Number.isFinite(dt) || dt <= 0) {
      return {
        dangerTriggered: false,
        tilted: this.tilted,
        warnings: this.warnings,
      };
    }

    const w0 = this.cfg.naturalFrequency;
    const twoZetaW0 = 2 * this.cfg.dampingRatio * w0;
    const w0Sq = w0 * w0;
    const ringR = this.cfg.ringRadius;

    let dangerTriggered = false;
    let remaining = dt;

    while (remaining > 0) {
      const h = Math.min(remaining, MAX_ODE_SUBSTEP);
      remaining -= h;

      this.cooldownRemaining = Math.max(0, this.cooldownRemaining - h);
      this.ringDebounceRemaining = Math.max(0, this.ringDebounceRemaining - h);

      // Damped harmonic oscillator: theta'' = -2*zeta*w0*theta' - w0^2*theta
      const ax = -twoZetaW0 * this.velX - w0Sq * this.bobX;
      const az = -twoZetaW0 * this.velZ - w0Sq * this.bobZ;

      this.velX += ax * h;
      this.velZ += az * h;
      this.bobX += this.velX * h;
      this.bobZ += this.velZ * h;

      const dist = Math.hypot(this.bobX, this.bobZ);
      if (dist >= ringR) {
        // Clamp to the physical brass contact ring and bounce radially inward
        const nx = this.bobX / dist;
        const nz = this.bobZ / dist;
        this.bobX = nx * ringR;
        this.bobZ = nz * ringR;

        const radialVel = this.velX * nx + this.velZ * nz;
        if (radialVel > 0) {
          this.velX -= (1 + RING_BOUNCE_RESTITUTION) * radialVel * nx;
          this.velZ -= (1 + RING_BOUNCE_RESTITUTION) * radialVel * nz;
        }

        if (this.pendingPredictedStrike) {
          // Consume the already-emitted strike from `nudge()` without double-counting
          this.pendingPredictedStrike = false;
          this.ringDebounceRemaining = RING_DEBOUNCE_SEC;
        } else if (!this.tilted && this.ringDebounceRemaining <= 0) {
          if (this.registerStrike()) {
            dangerTriggered = true;
          }
        }
      }
    }

    // Clamp negligible floating-point residual noise to zero at rest
    if (
      Math.hypot(this.bobX, this.bobZ) < 1e-4 &&
      Math.hypot(this.velX, this.velZ) < 1e-4
    ) {
      this.bobX = 0;
      this.bobZ = 0;
      this.velX = 0;
      this.velZ = 0;
      this.pendingPredictedStrike = false;
    }

    return {
      dangerTriggered,
      tilted: this.tilted,
      warnings: this.warnings,
    };
  }

  /** Resets pendulum state, cooldown, warnings, and tilt lock for a fresh ball. */
  resetForNewBall(): void {
    this.bobX = 0;
    this.bobZ = 0;
    this.velX = 0;
    this.velZ = 0;
    this.cooldownRemaining = 0;
    this.ringDebounceRemaining = 0;
    this.warnings = 0;
    this.tilted = false;
    this.pendingPredictedStrike = false;
  }

  getWarnings(): number {
    return this.warnings;
  }

  isTilted(): boolean {
    return this.tilted;
  }

  getBobDisplacement(): number {
    return Math.hypot(this.bobX, this.bobZ);
  }

  getState(): TiltState {
    return {
      bobX: this.bobX,
      bobZ: this.bobZ,
      velX: this.velX,
      velZ: this.velZ,
      displacement: this.getBobDisplacement(),
      ringRadius: this.cfg.ringRadius,
      cooldownRemaining: this.cooldownRemaining,
      warnings: this.warnings,
      maxWarnings: this.cfg.maxWarnings,
      tilted: this.tilted,
    };
  }

  /**
   * Projects the current damped pendulum state forward over the upcoming half-cycle
   * to determine whether this nudge will drive the plumb-bob into the contact ring.
   */
  private willReachContactRing(): boolean {
    const ringR = this.cfg.ringRadius;
    if (Math.hypot(this.bobX, this.bobZ) >= ringR) {
      return true;
    }

    const w0 = this.cfg.naturalFrequency;
    const twoZetaW0 = 2 * this.cfg.dampingRatio * w0;
    const w0Sq = w0 * w0;

    let x = this.bobX;
    let z = this.bobZ;
    let vx = this.velX;
    let vz = this.velZ;

    const steps = Math.ceil(SWING_PREDICT_HORIZON / SWING_PREDICT_STEP);
    for (let i = 0; i < steps; i++) {
      const ax = -twoZetaW0 * vx - w0Sq * x;
      const az = -twoZetaW0 * vz - w0Sq * z;
      vx += ax * SWING_PREDICT_STEP;
      vz += az * SWING_PREDICT_STEP;
      x += vx * SWING_PREDICT_STEP;
      z += vz * SWING_PREDICT_STEP;
      if (Math.hypot(x, z) >= ringR) {
        return true;
      }
    }

    return false;
  }

  private registerStrike(): boolean {
    if (this.tilted) {
      return false;
    }
    this.warnings = Math.min(this.cfg.maxWarnings, this.warnings + 1);
    this.ringDebounceRemaining = RING_DEBOUNCE_SEC;
    if (this.warnings >= this.cfg.maxWarnings) {
      this.tilted = true;
    }
    return true;
  }
}
