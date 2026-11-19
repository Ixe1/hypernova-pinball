/**
 * HYPERNOVA — Physical Spring Plunger Controller
 *
 * Manages the spring-loaded shooter lane plunger collider: compressing tension
 * cleanly on keyboard hold or pointer drag, and delivering calibrated launch
 * velocities (with subtle optional spring jitter) on release so full pulls blast
 * around the top arch while partial pulls nail I-O-N Skill Shots.
 */

import RAPIER from '@dimforge/rapier3d-compat';
import {
  BALL_RADIUS,
  INTERACTION_PLAYFIELD_SOLID,
  PLUNGER_JITTER,
  PLUNGER_MAX_SPEED,
  PLUNGER_MIN_SPEED,
} from '../config/constants';
import type { PlungerDef } from '../config/tableLayout';
import type { ColliderTag } from '../config/types';

export interface PlungerStepResult {
  readonly launched: boolean;
  readonly tension: number;
  readonly launchSpeed: number;
}

const PLUNGER_TIP_HALF_WIDTH = 0.4;
const PLUNGER_TIP_HALF_HEIGHT = 0.35;
const PLUNGER_TIP_HALF_DEPTH = 0.12;
const KEYBOARD_PULL_RATE = 1.15; // full compression in ~0.87s
const MIN_LAUNCH_TENSION = 0.02;

function evalCubicHermite(
  t: number,
  t0: number,
  t1: number,
  y0: number,
  y1: number,
  m0: number,
  m1: number,
): number {
  const h = t1 - t0;
  const s = (t - t0) / h;
  const s2 = s * s;
  const s3 = s2 * s;
  return (
    (2 * s3 - 3 * s2 + 1) * y0 +
    (s3 - 2 * s2 + s) * h * m0 +
    (-2 * s3 + 3 * s2) * y1 +
    (s3 - s2) * h * m1
  );
}

/**
 * Calibrated Skill Shot sweet-spot tensions (0..1) indexed by `skillShotLaneIndex`:
 *   - 0 ('I', Ball 1 default): 62%
 *   - 1 ('O', Ball 2 default): 58%
 *   - 2 ('N', Ball 3 default): 53%
 */
export const PLUNGER_SKILL_SHOT_TENSIONS = [0.62, 0.58, 0.53] as const;

/** Center Skill Shot tension ('O' lane = 58%). */
export const PLUNGER_SKILL_SHOT_TENSION = PLUNGER_SKILL_SHOT_TENSIONS[1];

/**
 * Calibrated spring variance (±0.4%, bounded by PLUNGER_JITTER) keeping subtle
 * mechanical feel while ensuring dead-on target pulls hit their exact I-O-N lane
 * across 100% of jitter extremes.
 */
const EFFECTIVE_PLUNGER_JITTER = Math.min(PLUNGER_JITTER, 0.004);

export class PlungerPhysics {
  public readonly def: PlungerDef;
  private readonly body: RAPIER.RigidBody;
  private readonly rng: () => number;

  private tension = 0;
  private offset = 0; // current physical pull-back distance in world units (0..maxPullDistance)
  private wasPulling = false;
  private returnSpeed = 30;

  constructor(
    world: RAPIER.World,
    def: PlungerDef,
    colliderTags: Map<number, ColliderTag>,
    rng: () => number = Math.random,
  ) {
    this.def = def;
    this.rng = rng;

    const restCenterZ = def.tipRestZ + PLUNGER_TIP_HALF_DEPTH;
    const bodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(
      def.laneCenterX,
      BALL_RADIUS,
      restCenterZ,
    );
    this.body = world.createRigidBody(bodyDesc);

    const colliderDesc = RAPIER.ColliderDesc.cuboid(
      PLUNGER_TIP_HALF_WIDTH,
      PLUNGER_TIP_HALF_HEIGHT,
      PLUNGER_TIP_HALF_DEPTH,
    )
      .setCollisionGroups(INTERACTION_PLAYFIELD_SOLID)
      .setRestitution(0.15)
      .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Min)
      .setFriction(0.2)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);

    const collider = world.createCollider(colliderDesc, this.body);
    colliderTags.set(collider.handle, {
      kind: 'plunger',
      id: 'plunger_tip',
    });
  }

  public computeLaunchSpeed(tension: number): number {
    const t = Math.max(0, Math.min(1, tension));
    // Smooth C1 strictly-monotonic Hermite spring curve:
    //   - Weak pulls (< 45%) remain below gate-clearing speed (~33.9 u/s) and roll back cleanly.
    //   - Skill Shot targets span distinct, jitter-proof I-O-N windows:
    //       N (53%, ~34.9 u/s), O (58%, ~35.65 u/s), I (62%, ~36.34 u/s).
    //   - Strong/full pulls (65%..100%) ramp smoothly up to PLUNGER_MAX_SPEED (66 u/s).
    const tc = PLUNGER_SKILL_SHOT_TENSION;
    const uc = 0.393;
    const sc = 0.22;
    const curved =
      t <= tc
        ? evalCubicHermite(t, 0, tc, 0, uc, 0.66, sc)
        : evalCubicHermite(t, tc, 1, uc, 1, sc, 2.55);
    const base = PLUNGER_MIN_SPEED + (PLUNGER_MAX_SPEED - PLUNGER_MIN_SPEED) * curved;
    const jitter = 1 + (this.rng() * 2 - 1) * EFFECTIVE_PLUNGER_JITTER;
    return base * jitter;
  }

  public stepSubstep(
    dt: number,
    held: boolean,
    dragTension: number | null,
    ballInLaneZ: number | null,
  ): PlungerStepResult {
    let launched = false;
    let launchTension = 0;
    let launchSpeed = 0;

    const isDragging = dragTension !== null;

    if (isDragging) {
      this.tension = Math.max(0, Math.min(1, dragTension));
      this.offset = this.tension * this.def.maxPullDistance;
      this.wasPulling = true;
    } else if (held) {
      this.tension = Math.min(1, this.tension + KEYBOARD_PULL_RATE * dt);
      this.offset = this.tension * this.def.maxPullDistance;
      this.wasPulling = true;
    } else {
      if (this.wasPulling && this.tension >= MIN_LAUNCH_TENSION) {
        launched = true;
        launchTension = this.tension;
        launchSpeed = this.computeLaunchSpeed(launchTension);
        // Keep kinematic return slightly slower than launchSpeed so soft plunges never get double-hit.
        this.returnSpeed = Math.min(42, Math.max(8, launchSpeed * 0.65));
      }
      this.tension = 0;
      this.wasPulling = false;

      if (this.offset > 0) {
        let nextOffset = Math.max(0, this.offset - this.returnSpeed * dt);
        // Never advance the tip past a ball currently sitting in front of it during spring return.
        if (ballInLaneZ !== null) {
          const minFrontZ = ballInLaneZ + BALL_RADIUS + 0.015;
          const minOffset = Math.max(0, minFrontZ - this.def.tipRestZ);
          if (minOffset <= this.def.maxPullDistance && nextOffset < minOffset) {
            nextOffset = minOffset;
          }
        }
        this.offset = nextOffset;
      }
    }

    const tipFrontZ = this.def.tipRestZ + this.offset;
    this.body.setNextKinematicTranslation({
      x: this.def.laneCenterX,
      y: BALL_RADIUS,
      z: tipFrontZ + PLUNGER_TIP_HALF_DEPTH,
    });

    return {
      launched,
      tension: launchTension,
      launchSpeed,
    };
  }

  /**
   * Programmatically fires a calibrated plunge (used for Ball Save auto-launch and tests).
   */
  public triggerLaunch(tension = 0.96): PlungerStepResult {
    const clamped = Math.max(MIN_LAUNCH_TENSION, Math.min(1, tension));
    const launchSpeed = this.computeLaunchSpeed(clamped);
    this.tension = 0;
    this.wasPulling = false;
    this.offset = 0;
    this.returnSpeed = Math.min(42, Math.max(8, launchSpeed * 0.65));

    this.body.setNextKinematicTranslation({
      x: this.def.laneCenterX,
      y: BALL_RADIUS,
      z: this.def.tipRestZ + PLUNGER_TIP_HALF_DEPTH,
    });

    return {
      launched: true,
      tension: clamped,
      launchSpeed,
    };
  }

  public getTension(): number {
    return this.tension;
  }

  public getOffset(): number {
    return this.offset;
  }

  public getTipFrontZ(): number {
    return this.def.tipRestZ + this.offset;
  }

  public reset(): void {
    this.tension = 0;
    this.offset = 0;
    this.wasPulling = false;
    const restPos = {
      x: this.def.laneCenterX,
      y: BALL_RADIUS,
      z: this.def.tipRestZ + PLUNGER_TIP_HALF_DEPTH,
    };
    this.body.setTranslation(restPos, false);
    this.body.setNextKinematicTranslation(restPos);
  }
}
