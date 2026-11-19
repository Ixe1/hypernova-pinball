/**
 * HYPERNOVA — Tapered Kinematic Flipper Physics (480 Hz Substepped)
 *
 * Manages the left main, right main, and upper-right mini flippers using
 * tapered convex-hull kinematic bodies stepped cleanly at 480 Hz with
 * contact-aware lever-arm strike transfer for crisp aimed shots and
 * low-restitution cradling when stationary or held raised.
 */

import RAPIER from '@dimforge/rapier3d-compat';
import {
  BALL_RADIUS,
  FLIPPER_DOWN_SPEED,
  FLIPPER_FRICTION,
  FLIPPER_RESTITUTION,
  FLIPPER_UP_SPEED,
  INTERACTION_PLAYFIELD_SOLID,
} from '../config/constants';
import type { FlipperDef } from '../config/tableLayout';
import type { ColliderTag, FlipperSide, Vec3 } from '../config/types';
import { quatFromAxisY } from './TableColliders';

export interface FlipperRuntime {
  readonly def: FlipperDef;
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  /** +1 when activeAngle > restAngle (left), -1 when activeAngle < restAngle (right/upperRight). */
  readonly upSign: 1 | -1;
  angle: number;
  prevAngle: number;
  angularVelocity: number;
  isSwingingUp: boolean;
  isPressed: boolean;
}

export interface FlipperStrikeResult {
  readonly applied: boolean;
  readonly vx: number;
  readonly vz: number;
  readonly leverFraction: number;
  readonly impactSpeed: number;
}

function buildTaperedFlipperHull(def: FlipperDef, colliderHeight: number): Float32Array {
  const halfH = colliderHeight * 0.5;
  const ringSteps = 12;
  const verts: number[] = [];

  // Base circle around local origin (pivot)
  for (let i = 0; i < ringSteps; i++) {
    const theta = (i / ringSteps) * Math.PI * 2;
    const x = Math.cos(theta) * def.baseRadius;
    const z = Math.sin(theta) * def.baseRadius;
    verts.push(x, -halfH, z);
    verts.push(x, halfH, z);
  }

  // Tip circle around local (direction * length, 0)
  const tipX = def.direction * def.length;
  for (let i = 0; i < ringSteps; i++) {
    const theta = (i / ringSteps) * Math.PI * 2;
    const x = tipX + Math.cos(theta) * def.tipRadius;
    const z = Math.sin(theta) * def.tipRadius;
    verts.push(x, -halfH, z);
    verts.push(x, halfH, z);
  }

  return new Float32Array(verts);
}

export class FlipperPhysics {
  private readonly flippers = new Map<FlipperSide, FlipperRuntime>();
  private readonly orderedRuntimes: FlipperRuntime[] = [];
  private enabled = true;

  constructor(
    world: RAPIER.World,
    defs: readonly FlipperDef[],
    colliderTags: Map<number, ColliderTag>,
  ) {
    for (const def of defs) {
      // Slightly taller physics hull than visual bat so slight ball hops never clear the bat.
      const colliderHeight = def.height + 0.14;
      const centerY = colliderHeight * 0.5;

      const bodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(def.pivot.x, centerY, def.pivot.z)
        .setRotation(quatFromAxisY(def.restAngle));
      const body = world.createRigidBody(bodyDesc);

      const hullVerts = buildTaperedFlipperHull(def, colliderHeight);
      const hullDesc = RAPIER.ColliderDesc.convexHull(hullVerts);
      if (!hullDesc) {
        throw new Error(`Failed to construct convex hull for flipper ${def.id}`);
      }

      hullDesc
        .setCollisionGroups(INTERACTION_PLAYFIELD_SOLID)
        .setRestitution(FLIPPER_RESTITUTION)
        .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Min)
        .setFriction(FLIPPER_FRICTION)
        .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Average)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);

      const collider = world.createCollider(hullDesc, body);
      colliderTags.set(collider.handle, {
        kind: 'flipper',
        id: def.id,
        side: def.side,
      });

      const upSign: 1 | -1 = def.activeAngle > def.restAngle ? 1 : -1;
      const runtime: FlipperRuntime = {
        def,
        body,
        collider,
        upSign,
        angle: def.restAngle,
        prevAngle: def.restAngle,
        angularVelocity: 0,
        isSwingingUp: false,
        isPressed: false,
      };

      this.flippers.set(def.side, runtime);
      this.orderedRuntimes.push(runtime);
    }
  }

  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public stepSubstep(dt: number, leftPressed: boolean, rightPressed: boolean): void {
    for (const fl of this.orderedRuntimes) {
      const pressed =
        this.enabled && (fl.def.side === 'left' ? leftPressed : rightPressed);
      fl.isPressed = pressed;

      const targetAngle = pressed ? fl.def.activeAngle : fl.def.restAngle;
      const delta = targetAngle - fl.angle;
      const movingUp = delta * fl.upSign > 0;
      const speed = movingUp ? FLIPPER_UP_SPEED : FLIPPER_DOWN_SPEED;
      const maxStep = speed * dt;

      fl.prevAngle = fl.angle;
      if (Math.abs(delta) <= maxStep) {
        fl.angle = targetAngle;
      } else {
        fl.angle += Math.sign(delta) * maxStep;
      }

      const actualDelta = fl.angle - fl.prevAngle;
      fl.angularVelocity = dt > 0 ? actualDelta / dt : 0;
      fl.isSwingingUp = actualDelta * fl.upSign > 1e-5;

      fl.body.setNextKinematicRotation(quatFromAxisY(fl.angle));
    }
  }

  /**
   * Computes lever-arm-calibrated strike velocity when a ball contacts the upper
   * striking face of an actively swinging flipper. Returns `{ applied: false }`
   * whenever the flipper is stationary, held raised, or returning so cradling
   * remains completely gentle and controlled.
   */
  public computeStrikeVelocity(
    side: FlipperSide,
    ballPos: Vec3,
    ballVel: Vec3,
  ): FlipperStrikeResult {
    const fl = this.flippers.get(side);
    if (!fl || !fl.isSwingingUp) {
      return {
        applied: false,
        vx: ballVel.x,
        vz: ballVel.z,
        leverFraction: 0,
        impactSpeed: 0,
      };
    }

    const angle = fl.angle;
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);

    // Arm unit vector from pivot toward tip
    const armX = fl.def.direction * cosA;
    const armZ = -fl.def.direction * sinA;
    // Upward perpendicular normal (identical for both left & right flippers under Y-rotation)
    const upX = -sinA;
    const upZ = -cosA;

    const rx = ballPos.x - fl.def.pivot.x;
    const rz = ballPos.z - fl.def.pivot.z;

    const along = rx * armX + rz * armZ;
    const above = rx * upX + rz * upZ;

    // Only impart upward solenoid strike to balls on the striking (top) face within the bat span
    if (
      above <= -0.02 ||
      along < -fl.def.baseRadius * 0.6 ||
      along > fl.def.length + fl.def.tipRadius + BALL_RADIUS
    ) {
      return {
        applied: false,
        vx: ballVel.x,
        vz: ballVel.z,
        leverFraction: 0,
        impactSpeed: 0,
      };
    }

    const leverFraction = Math.max(0, Math.min(1, along / fl.def.length));
    const omegaMag = Math.max(FLIPPER_UP_SPEED * 0.7, Math.abs(fl.angularVelocity));
    // Calibrated lever curve:
    //   Main flipper (L = 1.54, omega = 21): base ~15 u/s, mid ~29 u/s, tip ~45..49 u/s
    //   Upper-right mini-flipper (L = 1.15): tip ~34 u/s
    const targetNormalSpeed = omegaMag * fl.def.length * (0.28 + 1.24 * leverFraction);

    const currentNormal = ballVel.x * upX + ballVel.z * upZ;
    const currentTangent = ballVel.x * armX + ballVel.z * armZ;

    if (currentNormal >= targetNormalSpeed) {
      return {
        applied: false,
        vx: ballVel.x,
        vz: ballVel.z,
        leverFraction,
        impactSpeed: currentNormal,
      };
    }

    // Preserve damped tangential motion for authentic aimed early/late shots
    const keptTangent = currentTangent * 0.8;
    const vx = upX * targetNormalSpeed + armX * keptTangent;
    const vz = upZ * targetNormalSpeed + armZ * keptTangent;

    return {
      applied: true,
      vx,
      vz,
      leverFraction,
      impactSpeed: targetNormalSpeed,
    };
  }

  public getAngle(side: FlipperSide): number {
    return this.flippers.get(side)?.angle ?? 0;
  }

  public getAngles(): Record<FlipperSide, number> {
    return {
      left: this.getAngle('left'),
      right: this.getAngle('right'),
      upperRight: this.getAngle('upperRight'),
    };
  }

  public getFlipperRuntime(side: FlipperSide): FlipperRuntime | undefined {
    return this.flippers.get(side);
  }

  public getAllRuntimes(): readonly FlipperRuntime[] {
    return this.orderedRuntimes;
  }

  public isSideHeldRaised(side: FlipperSide): boolean {
    const fl = this.flippers.get(side);
    if (!fl || !this.enabled || !fl.isPressed) {
      return false;
    }
    return Math.abs(fl.angle - fl.def.activeAngle) < 0.08;
  }

  public isAnyBallCradled(ballPos: Vec3): boolean {
    for (const fl of this.orderedRuntimes) {
      if (!this.isSideHeldRaised(fl.def.side)) {
        continue;
      }
      const dist = Math.hypot(ballPos.x - fl.def.pivot.x, ballPos.z - fl.def.pivot.z);
      if (dist <= fl.def.length + 0.65) {
        return true;
      }
    }
    return false;
  }

  public reset(): void {
    this.enabled = true;
    for (const fl of this.orderedRuntimes) {
      fl.angle = fl.def.restAngle;
      fl.prevAngle = fl.def.restAngle;
      fl.angularVelocity = 0;
      fl.isSwingingUp = false;
      fl.isPressed = false;
      const rot = quatFromAxisY(fl.def.restAngle);
      fl.body.setRotation(rot, false);
      fl.body.setNextKinematicRotation(rot);
    }
  }
}
