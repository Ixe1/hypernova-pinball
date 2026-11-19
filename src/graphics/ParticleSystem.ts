/**
 * HYPERNOVA — Pooled InstancedMesh Spark & Plasma Energy Burst System
 *
 * Renders up to 240 zero-GC, additive-blended, velocity-aligned energy spark
 * shards in playfield-local space for pop bumper kicks, slingshots, drop
 * targets, ramp entries, kickbacks, and multiball jackpots.
 */

import * as THREE from 'three';
import { PLAYFIELD_GLASS_Y } from '../config/constants';

const DEFAULT_POOL_SIZE = 240;
const SPARK_GRAVITY_Y = -22.0;
const SPARK_GRAVITY_Z = 2.6;
const SPARK_DRAG = 1.9;

interface ParticleSlot {
  active: boolean;
  px: number;
  py: number;
  pz: number;
  vx: number;
  vy: number;
  vz: number;
  age: number;
  life: number;
  baseScale: number;
  baseR: number;
  baseG: number;
  baseB: number;
}

export class ParticleSystem {
  public readonly mesh: THREE.InstancedMesh;

  private readonly poolSize: number;
  private readonly slots: ParticleSlot[];
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.MeshBasicMaterial;

  private writeCursor = 0;
  private activeCount = 0;
  private dirty = false;

  // Preallocated scratch objects for zero-GC updates
  private readonly scratchMatrix = new THREE.Matrix4();
  private readonly scratchPos = new THREE.Vector3();
  private readonly scratchScale = new THREE.Vector3();
  private readonly scratchQuat = new THREE.Quaternion();
  private readonly scratchDir = new THREE.Vector3();
  private readonly scratchColor = new THREE.Color();
  private readonly upAxis = new THREE.Vector3(0, 1, 0);

  constructor(poolSize = DEFAULT_POOL_SIZE) {
    this.poolSize = poolSize;

    // Sleek elongated diamond/crystal spark shard aligned along +Y
    const geo = new THREE.OctahedronGeometry(0.055, 0);
    geo.scale(0.46, 2.25, 0.46);
    this.geometry = geo;

    // Additive glowing shard material; instanceColor carries HDR bloom boost & fade
    this.material = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });

    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, this.poolSize);
    this.mesh.name = 'PlayfieldParticleSystem';
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    this.slots = new Array<ParticleSlot>(this.poolSize);
    const zeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
    const black = new THREE.Color(0x000000);

    for (let i = 0; i < this.poolSize; i++) {
      this.slots[i] = {
        active: false,
        px: 0,
        py: -10,
        pz: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        age: 0,
        life: 0.3,
        baseScale: 1,
        baseR: 1,
        baseG: 1,
        baseB: 1,
      };
      this.mesh.setMatrixAt(i, zeroMatrix);
      this.mesh.setColorAt(i, black);
    }

    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) {
      this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      this.mesh.instanceColor.needsUpdate = true;
    }
  }

  /**
   * Emits a radial burst of glowing spark/energy shards from a playfield-local position.
   */
  public emitBurst(
    pos: { x: number; y: number; z: number },
    colorHex: number,
    count = 16,
    speed = 7.5,
  ): void {
    const safeCount = Math.max(1, Math.min(count, this.poolSize));
    this.scratchColor.setHex(colorHex);
    const cr = this.scratchColor.r;
    const cg = this.scratchColor.g;
    const cb = this.scratchColor.b;

    for (let i = 0; i < safeCount; i++) {
      const idx = this.writeCursor;
      this.writeCursor = (this.writeCursor + 1) % this.poolSize;

      const slot = this.slots[idx];
      if (!slot.active) {
        slot.active = true;
        this.activeCount++;
      }

      // Distributed radial azimuth + crisp upward fountain elevation
      const azimuth = ((i + Math.random() * 0.85) / safeCount) * Math.PI * 2;
      const elev = 0.25 + Math.random() * 0.95;
      const spd = speed * (0.45 + Math.random() * 0.85);
      const horiz = Math.cos(elev) * spd;

      slot.px = pos.x + (Math.random() - 0.5) * 0.08;
      slot.py = Math.max(0.06, pos.y + Math.random() * 0.08);
      slot.pz = pos.z + (Math.random() - 0.5) * 0.08;

      slot.vx = Math.cos(azimuth) * horiz;
      slot.vy = Math.sin(elev) * spd + 1.4;
      slot.vz = Math.sin(azimuth) * horiz;

      slot.age = 0;
      slot.life = 0.26 + Math.random() * 0.34;
      slot.baseScale = 0.65 + Math.random() * 0.95;

      // Slight white-hot core variance per shard for sparkling variety
      const hotMix = Math.random() * 0.35;
      slot.baseR = cr + (1 - cr) * hotMix;
      slot.baseG = cg + (1 - cg) * hotMix;
      slot.baseB = cb + (1 - cb) * hotMix;
    }

    this.dirty = true;
  }

  public update(dt: number): void {
    if (this.activeCount === 0 && !this.dirty) {
      return;
    }

    const safeDt = Math.min(Math.max(dt, 0), 0.1);
    const dragFactor = Math.exp(-SPARK_DRAG * safeDt);
    const maxY = PLAYFIELD_GLASS_Y - 0.12;

    for (let i = 0; i < this.poolSize; i++) {
      const slot = this.slots[i];
      if (!slot.active) continue;

      slot.age += safeDt;
      if (slot.age >= slot.life) {
        slot.active = false;
        this.activeCount--;
        this.scratchMatrix.makeScale(0, 0, 0);
        this.mesh.setMatrixAt(i, this.scratchMatrix);
        this.scratchColor.setRGB(0, 0, 0);
        this.mesh.setColorAt(i, this.scratchColor);
        continue;
      }

      // Integrate velocity & position in playfield-local space
      slot.vx *= dragFactor;
      slot.vy = slot.vy * dragFactor + SPARK_GRAVITY_Y * safeDt;
      slot.vz = slot.vz * dragFactor + SPARK_GRAVITY_Z * safeDt;

      slot.px += slot.vx * safeDt;
      slot.py += slot.vy * safeDt;
      slot.pz += slot.vz * safeDt;

      // Snappy playfield deck micro-ricochet & glass ceiling clamp
      if (slot.py < 0.025) {
        slot.py = 0.025;
        slot.vy = Math.abs(slot.vy) * 0.36;
        slot.vx *= 0.72;
        slot.vz *= 0.72;
      } else if (slot.py > maxY) {
        slot.py = maxY;
        slot.vy = -Math.abs(slot.vy) * 0.25;
      }

      const lifeT = slot.age / slot.life;
      const fade = 1 - lifeT;
      const smoothFade = fade * fade;

      // Align shard +Y axis along instantaneous velocity direction
      const speedSq = slot.vx * slot.vx + slot.vy * slot.vy + slot.vz * slot.vz;
      if (speedSq > 0.0004) {
        const invSpd = 1 / Math.sqrt(speedSq);
        this.scratchDir.set(slot.vx * invSpd, slot.vy * invSpd, slot.vz * invSpd);
        this.scratchQuat.setFromUnitVectors(this.upAxis, this.scratchDir);
      } else {
        this.scratchQuat.identity();
      }

      // Stretch slightly along velocity while shrinking gracefully near death
      const speedStretch = Math.min(2.6, 0.75 + Math.sqrt(speedSq) * 0.16);
      const radialScale = slot.baseScale * (0.35 + 0.65 * fade);
      this.scratchPos.set(slot.px, slot.py, slot.pz);
      this.scratchScale.set(radialScale, radialScale * speedStretch, radialScale);
      this.scratchMatrix.compose(this.scratchPos, this.scratchQuat, this.scratchScale);
      this.mesh.setMatrixAt(i, this.scratchMatrix);

      // HDR brightness peak right on impact -> smooth fade to black (invisible additive)
      const hdr = (0.55 + 1.55 * smoothFade) * smoothFade;
      this.scratchColor.setRGB(slot.baseR * hdr, slot.baseG * hdr, slot.baseB * hdr);
      this.mesh.setColorAt(i, this.scratchColor);
    }

    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) {
      this.mesh.instanceColor.needsUpdate = true;
    }
    this.dirty = this.activeCount > 0;
  }

  public dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
