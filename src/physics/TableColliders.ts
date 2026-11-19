/**
 * HYPERNOVA — Parametric Rapier3D Table Collider Builder
 *
 * Constructs every static playfield, elevated Warp Ramp, and trigger sensor
 * collider directly from `TABLE_LAYOUT` so physics collision geometry stays in
 * exact 1:1 alignment with 3D visuals.
 */

import RAPIER from '@dimforge/rapier3d-compat';
import {
  BALL_DIAMETER,
  BALL_FRICTION,
  GROUP_BALL,
  GROUP_PLAYFIELD,
  GROUP_RAMP,
  INTERACTION_PLAYFIELD_SOLID,
  INTERACTION_RAMP_SOLID,
  INTERACTION_SENSOR,
  makeInteractionGroups,
  PLAYFIELD_GLASS_Y,
  PLAYFIELD_LENGTH,
  PLAYFIELD_WIDTH,
} from '../config/constants';
import type {
  BoxSensorDef,
  SlingshotDef,
  TableLayout,
  WallPolylineDef,
  WarpRampDef,
} from '../config/tableLayout';
import type { ColliderKind, ColliderTag, Quat, Vec2, Vec3 } from '../config/types';
import { evaluateSplinePolyline } from './WireformRail';

export interface BuiltTableColliders {
  readonly dropTargetColliders: ReadonlyMap<number, RAPIER.Collider>;
  readonly oneWayGateCollider: RAPIER.Collider;
  readonly rampEntrySensorHandle: number;
  readonly rampApexSensorHandle: number;
  readonly saucerSensorHandle: number;
  readonly drainSensorHandle: number;
  readonly kickbackSensorHandle: number;
  readonly spinnerSensorHandle: number;
  readonly shooterLaneSensorHandle: number;
  readonly allColliderHandles: readonly number[];
}

/** Right-handed quaternion representing rotation by `angleRad` around the +Y axis. */
export function quatFromAxisY(angleRad: number): Quat {
  const half = angleRad * 0.5;
  return { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) };
}

/**
 * Converts a right-handed orthonormal 3x3 basis (columns: right = +X, up = +Y, back = +Z)
 * into a unit quaternion matching Rapier3D / Three.js convention.
 */
export function quatFromBasis(right: Vec3, up: Vec3, back: Vec3): Quat {
  const m00 = right.x;
  const m10 = right.y;
  const m20 = right.z;

  const m01 = up.x;
  const m11 = up.y;
  const m21 = up.z;

  const m02 = back.x;
  const m12 = back.y;
  const m22 = back.z;

  const trace = m00 + m11 + m22;
  let x = 0;
  let y = 0;
  let z = 0;
  let w = 1;

  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1.0);
    w = 0.25 / s;
    x = (m21 - m12) * s;
    y = (m02 - m20) * s;
    z = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2.0 * Math.sqrt(1.0 + m00 - m11 - m22);
    w = (m21 - m12) / s;
    x = 0.25 * s;
    y = (m01 + m10) / s;
    z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2.0 * Math.sqrt(1.0 + m11 - m00 - m22);
    w = (m02 - m20) / s;
    x = (m01 + m10) / s;
    y = 0.25 * s;
    z = (m12 + m21) / s;
  } else {
    const s = 2.0 * Math.sqrt(1.0 + m22 - m00 - m11);
    w = (m10 - m01) / s;
    x = (m02 + m20) / s;
    y = (m12 + m21) / s;
    z = 0.25 * s;
  }

  const len = Math.hypot(x, y, z, w);
  if (len <= 1e-8) {
    return { x: 0, y: 0, z: 0, w: 1 };
  }
  return { x: x / len, y: y / len, z: z / len, w: w / len };
}

function normalizeVec3(v: Vec3): Vec3 {
  const len = Math.hypot(v.x, v.y, v.z);
  if (len <= 1e-8) {
    return { x: 0, y: 0, z: -1 };
  }
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function crossVec3(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function buildBasisFromTangent(tangent: Vec3): { right: Vec3; up: Vec3; back: Vec3 } {
  const t = normalizeVec3(tangent);
  const worldUp: Vec3 = { x: 0, y: 1, z: 0 };
  const rightRaw = crossVec3(t, worldUp);
  const right =
    Math.hypot(rightRaw.x, rightRaw.y, rightRaw.z) > 1e-5
      ? normalizeVec3(rightRaw)
      : { x: 1, y: 0, z: 0 };
  const up = normalizeVec3(crossVec3(right, t));
  const back: Vec3 = { x: -t.x, y: -t.y, z: -t.z };
  return { right, up, back };
}

function registerCollider(
  world: RAPIER.World,
  desc: RAPIER.ColliderDesc,
  tag: ColliderTag,
  colliderTags: Map<number, ColliderTag>,
  handles: number[],
): RAPIER.Collider {
  const collider = world.createCollider(desc);
  colliderTags.set(collider.handle, tag);
  handles.push(collider.handle);
  return collider;
}

function buildWallPolyline(
  world: RAPIER.World,
  wall: WallPolylineDef,
  colliderTags: Map<number, ColliderTag>,
  handles: number[],
): void {
  const pts = wall.points;
  if (pts.length < 2) {
    return;
  }

  // Seal outer cabinet walls all the way up to the playfield glass so high bounces never escape.
  const wallHeight =
    wall.id === 'outer_perimeter' || wall.id === 'bottom_backstop'
      ? PLAYFIELD_GLASS_Y
      : wall.height;
  const halfH = wallHeight * 0.5;
  const halfT = wall.thickness * 0.5;
  const tag: ColliderTag = { kind: 'wall', id: wall.id };

  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const segLen = Math.hypot(dx, dz);
    if (segLen < 1e-5) {
      continue;
    }

    const midX = (a.x + b.x) * 0.5;
    const midZ = (a.z + b.z) * 0.5;
    const angleY = Math.atan2(-dz, dx);

    const desc = RAPIER.ColliderDesc.cuboid(segLen * 0.5, halfH, halfT)
      .setTranslation(midX, halfH, midZ)
      .setRotation(quatFromAxisY(angleY))
      .setCollisionGroups(INTERACTION_PLAYFIELD_SOLID)
      .setRestitution(wall.restitution)
      .setRestitutionCombineRule(
        wall.id.startsWith('inlane_guide_')
          ? RAPIER.CoefficientCombineRule.Min
          : RAPIER.CoefficientCombineRule.Average,
      )
      .setFriction(0.08)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);

    registerCollider(world, desc, tag, colliderTags, handles);
  }

  // Place vertical cylinders at interior vertices (smoothly seals convex bends)
  // and at polyline endpoints when `roundedCaps` is enabled.
  for (let i = 0; i < pts.length; i++) {
    const isEndpoint = i === 0 || i === pts.length - 1;
    if (isEndpoint && !wall.roundedCaps) {
      continue;
    }
    const p = pts[i];
    const capDesc = RAPIER.ColliderDesc.cylinder(halfH, halfT)
      .setTranslation(p.x, halfH, p.z)
      .setCollisionGroups(INTERACTION_PLAYFIELD_SOLID)
      .setRestitution(wall.restitution)
      .setFriction(0.08)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);

    registerCollider(world, capDesc, tag, colliderTags, handles);
  }
}

function buildSlingshot(
  world: RAPIER.World,
  sling: SlingshotDef,
  colliderTags: Map<number, ColliderTag>,
  handles: number[],
): void {
  const halfH = sling.height * 0.5;
  const r = sling.postRadius;
  const ringSteps = 10;

  // Build smooth rounded triangular hull by taking the convex hull of circles around all 3 posts.
  const hullVerts: number[] = [];
  for (const v of sling.vertices) {
    for (let i = 0; i < ringSteps; i++) {
      const theta = (i / ringSteps) * Math.PI * 2;
      const px = v.x + Math.cos(theta) * r;
      const pz = v.z + Math.sin(theta) * r;
      hullVerts.push(px, 0, pz);
      hullVerts.push(px, sling.height, pz);
    }
  }

  const hullDesc = RAPIER.ColliderDesc.convexHull(new Float32Array(hullVerts));
  if (hullDesc) {
    hullDesc
      .setCollisionGroups(INTERACTION_PLAYFIELD_SOLID)
      .setRestitution(0.62)
      .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Max)
      .setFriction(0.2)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);

    registerCollider(
      world,
      hullDesc,
      { kind: 'wall', id: `${sling.id}_body` },
      colliderTags,
      handles,
    );
  }

  // Active hypotenuse kicker sensor strip shifted slightly outward along kickNormal
  // and trimmed away from the top/bottom posts so passive edges never misfire.
  const [a, b] = sling.activeEdge;
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const edgeLen = Math.hypot(dx, dz);
  const stripLen = Math.max(0.25, edgeLen - r * 2 - 0.14);
  const midX = (a.x + b.x) * 0.5 + sling.kickNormal.x * (r + 0.035);
  const midZ = (a.z + b.z) * 0.5 + sling.kickNormal.z * (r + 0.035);
  const angleY = Math.atan2(-dz, dx);

  const kickerDesc = RAPIER.ColliderDesc.cuboid(stripLen * 0.5, halfH, 0.055)
    .setTranslation(midX, halfH, midZ)
    .setRotation(quatFromAxisY(angleY))
    .setSensor(true)
    .setCollisionGroups(INTERACTION_SENSOR)
    .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);

  registerCollider(
    world,
    kickerDesc,
    {
      kind: 'slingshot',
      id: sling.id,
      side: sling.side,
      normal: sling.kickNormal,
    },
    colliderTags,
    handles,
  );
}

function buildBoxSensor(
  world: RAPIER.World,
  sensor: BoxSensorDef,
  kind: ColliderKind,
  colliderTags: Map<number, ColliderTag>,
  handles: number[],
): RAPIER.Collider {
  const desc = RAPIER.ColliderDesc.cuboid(sensor.halfExtents.x, 0.35, sensor.halfExtents.z)
    .setTranslation(sensor.position.x, 0.3, sensor.position.z)
    .setSensor(true)
    .setCollisionGroups(INTERACTION_SENSOR)
    .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);

  return registerCollider(world, desc, { kind, id: sensor.id }, colliderTags, handles);
}

function buildWarpRamp(
  world: RAPIER.World,
  ramp: WarpRampDef,
  colliderTags: Map<number, ColliderTag>,
  handles: number[],
): { entrySensorHandle: number; apexSensorHandle: number } {
  const rampTag: ColliderTag = { kind: 'ramp', id: ramp.id };
  const splineSegments = 48;
  const railHeight = Math.max(ramp.guardrailHeight, 0.7);
  const halfInnerW = ramp.width * 0.5;

  // Sample smooth centerline spline points with non-negative Y clamp so the flat lead-in stays at Y = 0.
  const flatEndU = 1 / Math.max(1, ramp.controlPoints.length - 1);
  const splinePts: Vec3[] = [];
  for (let i = 0; i <= splineSegments; i++) {
    const u = i / splineSegments;
    const raw = evaluateSplinePolyline(ramp.controlPoints, u);
    const y = u <= flatEndU * 0.85 ? 0 : Math.max(0, raw.y);
    splinePts.push({ x: raw.x, y, z: raw.z });
  }

  // Prepend flat lead-in cross-sections ahead of controlPoints[0] on GROUP_RAMP
  // so balls transitioning at the front of entrySensor are seamlessly supported at Y = 0.
  const p0 = splinePts[0];
  const p1 = splinePts[1];
  const leadDirXZ = normalizeVec3({ x: p1.x - p0.x, y: 0, z: p1.z - p0.z });
  const centerPts: Vec3[] = [
    { x: p0.x - leadDirXZ.x * 0.85, y: 0, z: p0.z - leadDirXZ.z * 0.85 },
    { x: p0.x - leadDirXZ.x * 0.42, y: 0, z: p0.z - leadDirXZ.z * 0.42 },
    ...splinePts,
  ];

  // Append one short extension past the apex so fast balls hit apexSensor before the safety end-cap.
  const lastA = centerPts[centerPts.length - 2];
  const lastB = centerPts[centerPts.length - 1];
  const endDir = normalizeVec3({
    x: lastB.x - lastA.x,
    y: Math.max(0, lastB.y - lastA.y),
    z: lastB.z - lastA.z,
  });
  centerPts.push({
    x: lastB.x + endDir.x * 0.45,
    y: lastB.y + endDir.y * 0.45,
    z: lastB.z + endDir.z * 0.45,
  });

  // Build one continuous, seam-free lofted U-channel triangle mesh (deck + left/right guardrails + end cap)
  // with FIX_INTERNAL_EDGES_TWO_SIDED so curved wall/deck transitions have zero saw-tooth bumps.
  const vertices: number[] = [];
  const indices: number[] = [];
  const count = centerPts.length;

  for (let i = 0; i < count; i++) {
    const prev = centerPts[Math.max(0, i - 1)];
    const next = centerPts[Math.min(count - 1, i + 1)];
    const frame = buildBasisFromTangent({
      x: next.x - prev.x,
      y: next.y - prev.y,
      z: next.z - prev.z,
    });
    const p = centerPts[i];
    const r = frame.right;
    const up = frame.up;

    // 0: Left-top, 1: Left-bottom, 2: Right-bottom, 3: Right-top
    const lx = p.x - r.x * halfInnerW;
    const ly = p.y - r.y * halfInnerW;
    const lz = p.z - r.z * halfInnerW;

    const rx = p.x + r.x * halfInnerW;
    const ry = p.y + r.y * halfInnerW;
    const rz = p.z + r.z * halfInnerW;

    vertices.push(
      lx + up.x * railHeight,
      ly + up.y * railHeight,
      lz + up.z * railHeight,
      lx,
      ly,
      lz,
      rx,
      ry,
      rz,
      rx + up.x * railHeight,
      ry + up.y * railHeight,
      rz + up.z * railHeight,
    );
  }

  for (let i = 0; i < count - 1; i++) {
    const a = i * 4;
    const b = (i + 1) * 4;

    // Left guardrail (inward normal = +R)
    indices.push(a + 0, a + 1, b + 1, a + 0, b + 1, b + 0);
    // Deck surface (upward normal = +N)
    indices.push(a + 1, a + 2, b + 2, a + 1, b + 2, b + 1);
    // Right guardrail (inward normal = -R)
    indices.push(a + 2, a + 3, b + 3, a + 2, b + 3, b + 2);
  }

  // Safety end-cap closing the apex exit (inward normal = -T)
  const endBase = (count - 1) * 4;
  indices.push(
    endBase + 1,
    endBase + 2,
    endBase + 3,
    endBase + 1,
    endBase + 3,
    endBase + 0,
  );

  const rampMeshDesc = RAPIER.ColliderDesc.trimesh(
    new Float32Array(vertices),
    new Uint32Array(indices),
    RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES_TWO_SIDED,
  )
    .setCollisionGroups(INTERACTION_RAMP_SOLID)
    .setRestitution(0.05)
    .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Min)
    .setFriction(0.05);

  registerCollider(world, rampMeshDesc, rampTag, colliderTags, handles);

  // Smooth GROUP_PLAYFIELD outer sidewall & low-clearance baffle along the ascending section
  // where deck underside < BALL_DIAMETER + 0.12, preventing playfield balls from clipping
  // horizontally through the low portion of the Warp Ramp while leaving the high upper arch open.
  const entryBackZ = ramp.entrySensor.position.z - ramp.entrySensor.halfExtents.z - 0.05;
  const maxBlockedDeckY = BALL_DIAMETER + ramp.deckThickness + 0.12;
  const blockerOffset = halfInnerW + ramp.guardrailThickness * 0.5;
  const lowLeftPts: Vec2[] = [];
  const lowRightPts: Vec2[] = [];

  for (let i = 0; i < splinePts.length; i += 2) {
    const p = splinePts[i];
    if (p.z > entryBackZ || p.y > maxBlockedDeckY) {
      continue;
    }
    const prev = splinePts[Math.max(0, i - 1)];
    const next = splinePts[Math.min(splinePts.length - 1, i + 1)];
    const frame = buildBasisFromTangent({
      x: next.x - prev.x,
      y: next.y - prev.y,
      z: next.z - prev.z,
    });
    lowLeftPts.push({
      x: p.x - frame.right.x * blockerOffset,
      z: p.z - frame.right.z * blockerOffset,
    });
    lowRightPts.push({
      x: p.x + frame.right.x * blockerOffset,
      z: p.z + frame.right.z * blockerOffset,
    });
  }

  if (lowLeftPts.length >= 2) {
    const lowBlockerPoints: Vec2[] = [...lowLeftPts, ...[...lowRightPts].reverse()];
    buildWallPolyline(
      world,
      {
        id: `${ramp.id}_playfield_sidewalls`,
        points: lowBlockerPoints,
        thickness: ramp.guardrailThickness + 0.04,
        height: 0.65,
        restitution: 0.45,
        material: 'plastic',
        roundedCaps: true,
      },
      colliderTags,
      handles,
    );
  }

  // Ramp entry sensor (detects upward climb vs rollback)
  const entryDesc = RAPIER.ColliderDesc.cuboid(
    ramp.entrySensor.halfExtents.x,
    ramp.entrySensor.halfExtents.y,
    ramp.entrySensor.halfExtents.z,
  )
    .setTranslation(
      ramp.entrySensor.position.x,
      ramp.entrySensor.position.y,
      ramp.entrySensor.position.z,
    )
    .setSensor(true)
    .setCollisionGroups(INTERACTION_SENSOR)
    .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);

  const entrySensor = registerCollider(
    world,
    entryDesc,
    {
      kind: 'rampEntry',
      id: `${ramp.id}_entry`,
      normal: ramp.entrySensor.entryDirection,
    },
    colliderTags,
    handles,
  );

  // Ramp apex sensor (triggers handoff into Chrome Wireform Habitrail)
  const apexDesc = RAPIER.ColliderDesc.ball(ramp.apexSensor.radius)
    .setTranslation(
      ramp.apexSensor.position.x,
      ramp.apexSensor.position.y,
      ramp.apexSensor.position.z,
    )
    .setSensor(true)
    .setCollisionGroups(INTERACTION_SENSOR)
    .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);

  const apexSensor = registerCollider(
    world,
    apexDesc,
    { kind: 'rampApex', id: `${ramp.id}_apex` },
    colliderTags,
    handles,
  );

  return {
    entrySensorHandle: entrySensor.handle,
    apexSensorHandle: apexSensor.handle,
  };
}

export function buildTableColliders(
  world: RAPIER.World,
  layout: TableLayout,
  colliderTags: Map<number, ColliderTag>,
): BuiltTableColliders {
  const handles: number[] = [];

  // 1. Playfield floor (top surface at Y = 0)
  const floorDesc = RAPIER.ColliderDesc.cuboid(
    PLAYFIELD_WIDTH * 0.5 + 1.0,
    0.25,
    PLAYFIELD_LENGTH * 0.5 + 1.0,
  )
    .setTranslation(0, -0.25, 0)
    .setCollisionGroups(INTERACTION_PLAYFIELD_SOLID)
    .setRestitution(0.08)
    .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Min)
    .setFriction(BALL_FRICTION);

  registerCollider(
    world,
    floorDesc,
    { kind: 'playfield', id: 'playfield_floor' },
    colliderTags,
    handles,
  );

  // 2. Invisible playfield glass ceiling (bottom surface at Y = PLAYFIELD_GLASS_Y = 2.65)
  // Interacts with BOTH GROUP_PLAYFIELD and GROUP_RAMP balls so balls can never escape upward.
  const glassGroups = makeInteractionGroups(GROUP_PLAYFIELD | GROUP_RAMP, GROUP_BALL);
  const glassDesc = RAPIER.ColliderDesc.cuboid(
    PLAYFIELD_WIDTH * 0.5 + 1.0,
    0.25,
    PLAYFIELD_LENGTH * 0.5 + 1.0,
  )
    .setTranslation(0, PLAYFIELD_GLASS_Y + 0.25, 0)
    .setCollisionGroups(glassGroups)
    .setRestitution(0.08)
    .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Min)
    .setFriction(0.02);

  registerCollider(
    world,
    glassDesc,
    { kind: 'playfield', id: 'playfield_glass' },
    colliderTags,
    handles,
  );

  // 3. Outer walls, top arch, shooter divider, apron, inlane guides, backing plates, lane fins
  for (const wall of layout.walls) {
    buildWallPolyline(world, wall, colliderTags, handles);
  }

  // 4. Rubber-ringed posts
  for (const post of layout.posts) {
    const postDesc = RAPIER.ColliderDesc.cylinder(post.height * 0.5, post.radius)
      .setTranslation(post.position.x, post.height * 0.5, post.position.z)
      .setCollisionGroups(INTERACTION_PLAYFIELD_SOLID)
      .setRestitution(post.restitution)
      .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Max)
      .setFriction(0.25)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);

    registerCollider(world, postDesc, { kind: 'post', id: post.id }, colliderTags, handles);
  }

  // 5. One-way shooter gate blocker (toggled dynamically by PhysicsWorld for exiting balls)
  const gate = layout.oneWayGate;
  const gdx = gate.end.x - gate.start.x;
  const gdz = gate.end.z - gate.start.z;
  const gateLen = Math.hypot(gdx, gdz);
  const gateAngleY = Math.atan2(-gdz, gdx);
  const gateDesc = RAPIER.ColliderDesc.cuboid(gateLen * 0.5 + 0.06, gate.height * 0.5, 0.045)
    .setTranslation(gate.center.x, gate.height * 0.5, gate.center.z)
    .setRotation(quatFromAxisY(gateAngleY))
    .setCollisionGroups(INTERACTION_PLAYFIELD_SOLID)
    .setRestitution(0.35)
    .setFriction(0.08)
    .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);

  const oneWayGateCollider = registerCollider(
    world,
    gateDesc,
    { kind: 'oneWayGate', id: gate.id, normal: gate.allowedDirection },
    colliderTags,
    handles,
  );

  // 6. Pop bumpers
  for (const bumper of layout.popBumpers) {
    const desc = RAPIER.ColliderDesc.cylinder(bumper.height * 0.5, bumper.radius)
      .setTranslation(bumper.position.x, bumper.height * 0.5, bumper.position.z)
      .setCollisionGroups(INTERACTION_PLAYFIELD_SOLID)
      .setRestitution(0.65)
      .setFriction(0.05)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);

    registerCollider(
      world,
      desc,
      { kind: 'bumper', id: bumper.id, index: bumper.index },
      colliderTags,
      handles,
    );
  }

  // 7. Twin triangular slingshots (passive hull + active hypotenuse kicker sensor)
  for (const sling of layout.slingshots) {
    buildSlingshot(world, sling, colliderTags, handles);
  }

  // 8. Drop targets (R-A-Y)
  const dropTargetColliders = new Map<number, RAPIER.Collider>();
  for (const target of layout.dropTargets) {
    const desc = RAPIER.ColliderDesc.cuboid(
      target.width * 0.5,
      target.height * 0.5,
      target.depth * 0.5,
    )
      .setTranslation(target.position.x, target.height * 0.5, target.position.z)
      .setRotation(quatFromAxisY(target.angleY))
      .setCollisionGroups(INTERACTION_PLAYFIELD_SOLID)
      .setRestitution(0.5)
      .setFriction(0.12)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);

    const collider = registerCollider(
      world,
      desc,
      {
        kind: 'dropTarget',
        id: target.id,
        index: target.index,
        label: target.label,
        normal: target.normal,
      },
      colliderTags,
      handles,
    );
    dropTargetColliders.set(target.index, collider);
  }

  // 9. Right 3-bank standup targets
  for (const target of layout.standupTargets) {
    const desc = RAPIER.ColliderDesc.cuboid(
      target.width * 0.5,
      target.height * 0.5,
      target.depth * 0.5,
    )
      .setTranslation(target.position.x, target.height * 0.5, target.position.z)
      .setRotation(quatFromAxisY(target.angleY))
      .setCollisionGroups(INTERACTION_PLAYFIELD_SOLID)
      .setRestitution(0.62)
      .setFriction(0.12)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);

    registerCollider(
      world,
      desc,
      {
        kind: 'standup',
        id: target.id,
        index: target.index,
        label: target.label,
        normal: target.normal,
      },
      colliderTags,
      handles,
    );
  }

  // 10. Top I-O-N rollover lane sensors
  for (const lane of layout.rolloverLanes) {
    const desc = RAPIER.ColliderDesc.cuboid(lane.sensorHalfWidth, 0.35, lane.sensorHalfLength)
      .setTranslation(lane.position.x, 0.3, lane.position.z)
      .setSensor(true)
      .setCollisionGroups(INTERACTION_SENSOR)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);

    registerCollider(
      world,
      desc,
      {
        kind: 'rollover',
        id: lane.id,
        index: lane.index,
        label: lane.label,
      },
      colliderTags,
      handles,
    );
  }

  // 11. Left orbit metal spinner sensor
  const sp = layout.spinner;
  const spinnerDesc = RAPIER.ColliderDesc.cuboid(sp.width * 0.5, 0.4, sp.sensorHalfDepth)
    .setTranslation(sp.position.x, 0.35, sp.position.z)
    .setSensor(true)
    .setCollisionGroups(INTERACTION_SENSOR)
    .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);

  const spinnerSensor = registerCollider(
    world,
    spinnerDesc,
    { kind: 'spinner', id: sp.id },
    colliderTags,
    handles,
  );

  // 12. Hypercore Lock Saucer capture sensor
  const saucer = layout.saucer;
  const saucerDesc = RAPIER.ColliderDesc.cylinder(0.35, saucer.captureRadius)
    .setTranslation(saucer.position.x, 0.3, saucer.position.z)
    .setSensor(true)
    .setCollisionGroups(INTERACTION_SENSOR)
    .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);

  const saucerSensor = registerCollider(
    world,
    saucerDesc,
    { kind: 'saucer', id: saucer.id, normal: saucer.ejectDirection },
    colliderTags,
    handles,
  );

  // 13. Left outlane Shield Kickback sensor
  const kb = layout.kickback;
  const kickbackDesc = RAPIER.ColliderDesc.cuboid(
    kb.sensorHalfExtents.x,
    0.35,
    kb.sensorHalfExtents.z,
  )
    .setTranslation(kb.position.x, 0.3, kb.position.z)
    .setSensor(true)
    .setCollisionGroups(INTERACTION_SENSOR)
    .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);

  const kickbackSensor = registerCollider(
    world,
    kickbackDesc,
    { kind: 'kickback', id: kb.id, normal: kb.kickDirection },
    colliderTags,
    handles,
  );

  // 14. Shooter lane sensor
  const shooterDesc = RAPIER.ColliderDesc.cuboid(
    layout.plunger.sensorHalfExtents.x,
    0.35,
    layout.plunger.sensorHalfExtents.z,
  )
    .setTranslation(layout.plunger.sensorCenter.x, 0.3, layout.plunger.sensorCenter.z)
    .setSensor(true)
    .setCollisionGroups(INTERACTION_SENSOR)
    .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);

  const shooterLaneSensor = registerCollider(
    world,
    shooterDesc,
    { kind: 'shooterLane', id: 'sensor_shooter_lane' },
    colliderTags,
    handles,
  );

  // 15. Drain, inlane, outlane, and orbit sensors
  const drainSensor = buildBoxSensor(world, layout.sensors.drain, 'drain', colliderTags, handles);
  buildBoxSensor(world, layout.sensors.inlaneLeft, 'inlaneLeft', colliderTags, handles);
  buildBoxSensor(world, layout.sensors.inlaneRight, 'inlaneRight', colliderTags, handles);
  buildBoxSensor(world, layout.sensors.outlaneLeft, 'outlaneLeft', colliderTags, handles);
  buildBoxSensor(world, layout.sensors.outlaneRight, 'outlaneRight', colliderTags, handles);
  buildBoxSensor(world, layout.sensors.orbitLeft, 'orbitLeft', colliderTags, handles);
  buildBoxSensor(world, layout.sensors.orbitRight, 'orbitRight', colliderTags, handles);

  // 16. Elevated Warp Ramp deck, guardrails & entry/apex sensors
  const { entrySensorHandle, apexSensorHandle } = buildWarpRamp(
    world,
    layout.warpRamp,
    colliderTags,
    handles,
  );

  return {
    dropTargetColliders,
    oneWayGateCollider,
    rampEntrySensorHandle: entrySensorHandle,
    rampApexSensorHandle: apexSensorHandle,
    saucerSensorHandle: saucerSensor.handle,
    drainSensorHandle: drainSensor.handle,
    kickbackSensorHandle: kickbackSensor.handle,
    spinnerSensorHandle: spinnerSensor.handle,
    shooterLaneSensorHandle: shooterLaneSensor.handle,
    allColliderHandles: handles,
  };
}

/**
 * Helper to compute signed distance along a 2D unit direction from a reference point.
 */
export function signedDistanceAlong(point: Vec2, origin: Vec2, unitDir: Vec2): number {
  return (point.x - origin.x) * unitDir.x + (point.z - origin.z) * unitDir.z;
}
