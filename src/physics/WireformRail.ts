/**
 * HYPERNOVA — Chrome Wireform Habitrail Spline Controller
 *
 * Pure 3D centripetal Catmull-Rom spline with uniform arc-length parameterization,
 * real tangential rolling gravity `(5/7) * g·tangent - drag * v`, and accurate
 * rolling spin quaternion computation for seamless handoff back to Rapier3D
 * directly above the left inlane.
 */

import {
  BALL_RADIUS,
  GRAVITY,
  MIN_WIREFORM_SPEED,
  WIREFORM_DRAG,
} from '../config/constants';
import { WIREFORM_RAIL, type WireformRailDef } from '../config/tableLayout';
import type { Quat, Vec3 } from '../config/types';

export const MAX_WIREFORM_SPEED = 16.5;

export interface WireformBallState {
  /** Arc-length traveled along the spline (world units, 0..totalLength). */
  distance: number;
  /** Scalar speed along the tangent (world units/s). */
  speed: number;
  /** Current 3D ball center position on the wireform rail. */
  position: Vec3;
  /** Current unit tangent along the wireform rail. */
  tangent: Vec3;
  /** Instantaneous 3D linear velocity (`tangent * speed`). */
  velocity: Vec3;
  /** Instantaneous 3D rolling angular velocity (`normalize(up x tangent) * speed / R`). */
  angularVelocity: Vec3;
  /** Accumulated rolling orientation quaternion. */
  rotation: Quat;
  /** Normalized progress in [0, 1]. */
  progress: number;
  /** True once the ball reaches the end of the wireform rail. */
  finished: boolean;
}

interface ArcSample {
  readonly u: number;
  readonly length: number;
  readonly point: Vec3;
}

function addVec3(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function subVec3(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function scaleVec3(v: Vec3, s: number): Vec3 {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

function lengthVec3(v: Vec3): number {
  return Math.hypot(v.x, v.y, v.z);
}

function normalizeVec3(v: Vec3): Vec3 {
  const len = lengthVec3(v);
  if (len <= 1e-8) {
    return { x: 0, y: 0, z: 1 };
  }
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function dotVec3(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function crossVec3(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function quatFromAxisAngle(axis: Vec3, angle: number): Quat {
  const half = angle * 0.5;
  const s = Math.sin(half);
  return {
    x: axis.x * s,
    y: axis.y * s,
    z: axis.z * s,
    w: Math.cos(half),
  };
}

function multiplyQuat(a: Quat, b: Quat): Quat {
  const x = a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y;
  const y = a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x;
  const z = a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w;
  const w = a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z;
  const len = Math.hypot(x, y, z, w);
  if (len <= 1e-8) {
    return { x: 0, y: 0, z: 0, w: 1 };
  }
  return { x: x / len, y: y / len, z: z / len, w: w / len };
}

/**
 * Evaluates a centripetal Catmull-Rom segment (alpha = 0.5) between p1 and p2
 * using neighbors p0 and p3 at local parameter t in [0, 1].
 */
export function evaluateCentripetalCatmullRom(
  p0: Vec3,
  p1: Vec3,
  p2: Vec3,
  p3: Vec3,
  t: number,
): Vec3 {
  const alpha = 0.5;
  const d01 = Math.max(1e-5, lengthVec3(subVec3(p1, p0)));
  const d12 = Math.max(1e-5, lengthVec3(subVec3(p2, p1)));
  const d23 = Math.max(1e-5, lengthVec3(subVec3(p3, p2)));

  const t0 = 0;
  const t1 = t0 + Math.pow(d01, alpha);
  const t2 = t1 + Math.pow(d12, alpha);
  const t3 = t2 + Math.pow(d23, alpha);

  const u = t1 + (t2 - t1) * t;

  const lerpPt = (a: Vec3, b: Vec3, ta: number, tb: number, s: number): Vec3 => {
    const denom = tb - ta;
    if (Math.abs(denom) < 1e-8) {
      return a;
    }
    const w1 = (tb - s) / denom;
    const w2 = (s - ta) / denom;
    return {
      x: a.x * w1 + b.x * w2,
      y: a.y * w1 + b.y * w2,
      z: a.z * w1 + b.z * w2,
    };
  };

  const a1 = lerpPt(p0, p1, t0, t1, u);
  const a2 = lerpPt(p1, p2, t1, t2, u);
  const a3 = lerpPt(p2, p3, t2, t3, u);

  const b1 = lerpPt(a1, a2, t0, t2, u);
  const b2 = lerpPt(a2, a3, t1, t3, u);

  return lerpPt(b1, b2, t1, t2, u);
}

/**
 * Evaluates an open centripetal Catmull-Rom spline with phantom reflected endpoints
 * so tangent continuity holds smoothly at both ends.
 */
export function evaluateSplinePolyline(controlPoints: readonly Vec3[], uGlobal: number): Vec3 {
  const n = controlPoints.length;
  if (n === 0) {
    return { x: 0, y: 0, z: 0 };
  }
  if (n === 1) {
    return { ...controlPoints[0] };
  }

  const clamped = Math.max(0, Math.min(1, uGlobal));
  const segCount = n - 1;
  const scaled = clamped * segCount;
  const segIdx = Math.min(segCount - 1, Math.floor(scaled));
  const localT = scaled - segIdx;

  const p1 = controlPoints[segIdx];
  const p2 = controlPoints[segIdx + 1];
  const p0 =
    segIdx > 0
      ? controlPoints[segIdx - 1]
      : addVec3(p1, subVec3(p1, p2));
  const p3 =
    segIdx + 2 < n
      ? controlPoints[segIdx + 2]
      : addVec3(p2, subVec3(p2, p1));

  return evaluateCentripetalCatmullRom(p0, p1, p2, p3, localT);
}

const WORLD_UP: Vec3 = { x: 0, y: 1, z: 0 };

export class WireformRail {
  public readonly def: WireformRailDef;
  public readonly totalLength: number;
  private readonly samples: readonly ArcSample[];

  constructor(def: WireformRailDef = WIREFORM_RAIL, sampleCount = 256) {
    if (def.controlPoints.length < 2) {
      throw new Error('WireformRail requires at least 2 control points');
    }
    this.def = def;

    const count = Math.max(16, sampleCount);
    const built: ArcSample[] = [];
    let accum = 0;
    let prev = evaluateSplinePolyline(def.controlPoints, 0);
    built.push({ u: 0, length: 0, point: prev });

    for (let i = 1; i <= count; i++) {
      const u = i / count;
      const pt = evaluateSplinePolyline(def.controlPoints, u);
      accum += lengthVec3(subVec3(pt, prev));
      built.push({ u, length: accum, point: pt });
      prev = pt;
    }

    this.samples = built;
    this.totalLength = accum;
  }

  /** Converts an arc-length distance in [0, totalLength] to raw spline parameter u in [0, 1]. */
  private distanceToRawU(distance: number): number {
    if (distance <= 0 || this.totalLength <= 0) {
      return 0;
    }
    if (distance >= this.totalLength) {
      return 1;
    }

    let low = 0;
    let high = this.samples.length - 1;
    while (low + 1 < high) {
      const mid = (low + high) >> 1;
      if (this.samples[mid].length <= distance) {
        low = mid;
      } else {
        high = mid;
      }
    }

    const s0 = this.samples[low];
    const s1 = this.samples[high];
    const span = s1.length - s0.length;
    const frac = span > 1e-8 ? (distance - s0.length) / span : 0;
    return s0.u + (s1.u - s0.u) * frac;
  }

  public getPointAtDistance(distance: number): Vec3 {
    const u = this.distanceToRawU(distance);
    return evaluateSplinePolyline(this.def.controlPoints, u);
  }

  public getTangentAtDistance(distance: number): Vec3 {
    const eps = Math.min(0.02, this.totalLength * 0.002);
    const s0 = Math.max(0, distance - eps);
    const s1 = Math.min(this.totalLength, distance + eps);
    if (s1 - s0 <= 1e-6) {
      return { x: 0, y: 0, z: 1 };
    }
    const p0 = this.getPointAtDistance(s0);
    const p1 = this.getPointAtDistance(s1);
    return normalizeVec3(subVec3(p1, p0));
  }

  /** Evaluates position at uniform arc-length fraction t in [0, 1]. */
  public getPointAt(t: number): Vec3 {
    const clamped = Math.max(0, Math.min(1, t));
    return this.getPointAtDistance(clamped * this.totalLength);
  }

  /** Evaluates unit tangent at uniform arc-length fraction t in [0, 1]. */
  public getTangentAt(t: number): Vec3 {
    const clamped = Math.max(0, Math.min(1, t));
    return this.getTangentAtDistance(clamped * this.totalLength);
  }

  public getStartPoint(): Vec3 {
    return { ...this.def.controlPoints[0] };
  }

  public getExitPoint(): Vec3 {
    return { ...this.def.controlPoints[this.def.controlPoints.length - 1] };
  }

  public getExitTangent(): Vec3 {
    return this.getTangentAtDistance(this.totalLength);
  }

  public samplePolyline(segments: number): Vec3[] {
    const n = Math.max(2, segments);
    const pts: Vec3[] = [];
    for (let i = 0; i <= n; i++) {
      pts.push(this.getPointAt(i / n));
    }
    return pts;
  }

  /** Computes the right-hand rolling axis perpendicular to travel and world up. */
  private computeRollAxis(tangent: Vec3): Vec3 {
    const axis = crossVec3(WORLD_UP, tangent);
    if (lengthVec3(axis) <= 1e-6) {
      return { x: 1, y: 0, z: 0 };
    }
    return normalizeVec3(axis);
  }

  public createBallState(
    initialSpeed: number,
    initialRotation: Quat = { x: 0, y: 0, z: 0, w: 1 },
  ): WireformBallState {
    const speed = Math.max(MIN_WIREFORM_SPEED, Math.min(MAX_WIREFORM_SPEED, initialSpeed));
    const position = this.getPointAtDistance(0);
    const tangent = this.getTangentAtDistance(0);
    const rollAxis = this.computeRollAxis(tangent);
    const omegaMag = speed / BALL_RADIUS;

    return {
      distance: 0,
      speed,
      position,
      tangent,
      velocity: scaleVec3(tangent, speed),
      angularVelocity: scaleVec3(rollAxis, omegaMag),
      rotation: { ...initialRotation },
      progress: 0,
      finished: false,
    };
  }

  /**
   * Advances a ball along the wireform spline by `dt` seconds using real tangential
   * rolling gravity `(5/7) * (g · tangent) - drag * v` and updates its rolling quaternion.
   */
  public stepBall(state: WireformBallState, dt: number): WireformBallState {
    if (state.finished || dt <= 0) {
      return state;
    }

    const tangentNow = this.getTangentAtDistance(state.distance);
    const gDotT = dotVec3(GRAVITY, tangentNow);
    const aTangent = (5 / 7) * gDotT - WIREFORM_DRAG * state.speed;

    const nextSpeed = Math.max(
      MIN_WIREFORM_SPEED,
      Math.min(MAX_WIREFORM_SPEED, state.speed + aTangent * dt),
    );
    const ds = 0.5 * (state.speed + nextSpeed) * dt;
    const rawNextDistance = state.distance + ds;
    const finished = rawNextDistance >= this.totalLength;
    const clampedDistance = finished ? this.totalLength : rawNextDistance;
    const actualDs = clampedDistance - state.distance;

    const nextPosition = this.getPointAtDistance(clampedDistance);
    const nextTangent = this.getTangentAtDistance(clampedDistance);
    const rollAxis = this.computeRollAxis(nextTangent);
    const dAngle = actualDs / BALL_RADIUS;
    const dq = quatFromAxisAngle(rollAxis, dAngle);
    const nextRotation = multiplyQuat(dq, state.rotation);

    const omegaMag = nextSpeed / BALL_RADIUS;

    state.distance = clampedDistance;
    state.speed = nextSpeed;
    state.position = nextPosition;
    state.tangent = nextTangent;
    state.velocity = scaleVec3(nextTangent, nextSpeed);
    state.angularVelocity = scaleVec3(rollAxis, omegaMag);
    state.rotation = nextRotation;
    state.progress = this.totalLength > 0 ? clampedDistance / this.totalLength : 1;
    state.finished = finished;

    return state;
  }
}
