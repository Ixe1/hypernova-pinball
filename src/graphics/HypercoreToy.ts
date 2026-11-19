/**
 * HYPERNOVA — Hypercore Plasma Reactor Centerpiece Toy
 *
 * Mounted directly above HYPERCORE_SAUCER (-0.525, -4.2) in playfield-local space:
 *   - Sculpted dark-chrome/gunmetal horseshoe reactor base & 3 rear arched pylons
 *     (leaving the +Z front saucer mouth completely clear for ball entry/eject)
 *   - Custom GLSL ShaderMaterial swirling 3D Plasma Reactor Orb with Fresnel rim glow
 *   - Two counter-rotating brushed-chrome gimbal rings with emitter nodes
 *   - Dynamic PointLight & state-driven color/speed escalation
 */

import * as THREE from 'three';
import { PALETTE } from '../config/constants';
import { HYPERCORE_SAUCER } from '../config/tableLayout';

export interface HypercoreToyState {
  lockCount: number;
  isMultiball: boolean;
  isCapturing: boolean;
  isTilted: boolean;
  flashIntensity: number;
}

const PLASMA_VERTEX_SHADER = /* glsl */ `
  uniform float uTime;
  uniform float uEnergy;
  uniform float uPulse;

  varying vec3 vLocalPos;
  varying vec3 vViewNormal;
  varying vec3 vViewDir;

  void main() {
    vLocalPos = position;

    // Subtle harmonic surface breathing at high energy or pulse
    float ripple = sin(position.x * 9.0 + uTime * 3.4)
                 * cos(position.y * 9.0 - uTime * 2.8)
                 * sin(position.z * 9.0 + uTime * 3.1);
    float disp = ripple * (0.008 + 0.014 * uEnergy + 0.022 * uPulse);
    vec3 displaced = position + normal * disp;

    vec4 mvPos = modelViewMatrix * vec4(displaced, 1.0);
    vViewNormal = normalize(normalMatrix * normal);
    vViewDir = normalize(-mvPos.xyz);

    gl_Position = projectionMatrix * mvPos;
  }
`;

const PLASMA_FRAGMENT_SHADER = /* glsl */ `
  uniform float uTime;
  uniform float uEnergy;
  uniform float uPulse;
  uniform vec3 uColorA;
  uniform vec3 uColorB;

  varying vec3 vLocalPos;
  varying vec3 vViewNormal;
  varying vec3 vViewDir;

  // Smooth 3D trigonometric lattice noise (seam-free on spheres, fast on WebGL2)
  float triNoise(vec3 p) {
    return (
      sin(p.x) * cos(p.y) +
      sin(p.y * 1.17 + 1.3) * cos(p.z * 1.13 - 0.7) +
      sin(p.z * 1.23 - 0.5) * cos(p.x * 1.09 + 0.9)
    ) * 0.33333;
  }

  float plasmaFbm(vec3 p, float t) {
    float val = 0.0;
    float amp = 0.55;
    vec3 q = p;
    for (int i = 0; i < 4; i++) {
      q += vec3(
        sin(q.y * 1.4 + t * 0.9),
        cos(q.z * 1.4 - t * 1.1),
        sin(q.x * 1.4 + t * 0.8)
      ) * 0.42;
      val += triNoise(q) * amp;
      q = q * 1.92 + vec3(1.7, -2.3, 1.1);
      amp *= 0.52;
    }
    return val;
  }

  void main() {
    vec3 N = normalize(vViewNormal);
    vec3 V = normalize(vViewDir);
    float ndotv = clamp(dot(N, V), 0.0, 1.0);

    float flowSpeed = 1.0 + uEnergy * 1.45;
    float t = uTime * flowSpeed;

    // Swirling 3D domain-warped plasma coordinates
    vec3 p = normalize(vLocalPos) * 4.4;
    float n1 = plasmaFbm(p + vec3(0.0, t * 0.65, -t * 0.45), t);
    float n2 = plasmaFbm(p * 1.45 - vec3(t * 0.55, -t * 0.35, t * 0.5) + n1 * 1.6, t * 1.2);

    // Sharp electric plasma filaments along zero-crossings
    float veins = pow(clamp(1.0 - abs(n2) * 2.15, 0.0, 1.0), 3.8);
    float swirl = clamp(n1 * 0.5 + 0.5, 0.0, 1.0);

    // Deep cosmic reactor core with strong dark-vs-filament contrast so hues stay vivid
    vec3 deepCore = mix(uColorA, uColorB, swirl) * 0.14;
    vec3 plasmaCol = mix(uColorA, uColorB, smoothstep(0.22, 0.82, swirl));
    vec3 hotCore = mix(plasmaCol, vec3(1.0, 0.96, 1.0), 0.72);

    // Crisp colored Fresnel containment rim glow
    float fresnel = pow(1.0 - ndotv, 2.65);

    // Combine deep interior, vivid plasma veins, pinpoint filament center, and colored Fresnel rim
    float energy = clamp(uEnergy, 0.0, 1.5);
    float pulse = clamp(uPulse, 0.0, 1.2);
    float veinStrength = 0.65 + energy * 0.62 + pulse * 0.48;

    vec3 col = deepCore;
    col += plasmaCol * (0.24 + veins * 1.15) * veinStrength;
    col += hotCore * pow(veins, 3.6) * (0.28 + energy * 0.28 + pulse * 0.35);
    col += mix(uColorA, uColorB, 0.65) * fresnel * (0.68 + energy * 0.45 + pulse * 0.35);

    // Soft HDR ceiling (~1.3-1.8) preserves vivid saturation & prevents white washout under ACES + Bloom
    float hdrCeiling = 1.32 + clamp(energy * 0.28 + pulse * 0.24, 0.0, 0.48);
    col = (col / (vec3(1.0) + col * 0.42)) * hdrCeiling;

    gl_FragColor = vec4(col, 1.0);
  }
`;

const AURA_VERTEX_SHADER = /* glsl */ `
  varying vec3 vViewNormal;
  varying vec3 vViewDir;

  void main() {
    vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
    vViewNormal = normalize(normalMatrix * normal);
    vViewDir = normalize(-mvPos.xyz);
    gl_Position = projectionMatrix * mvPos;
  }
`;

const AURA_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;

  varying vec3 vViewNormal;
  varying vec3 vViewDir;

  void main() {
    float ndotv = clamp(abs(dot(normalize(vViewNormal), normalize(vViewDir))), 0.0, 1.0);
    float rim = pow(1.0 - ndotv, 3.1);
    gl_FragColor = vec4(uColor * (0.85 + rim * 0.8), rim * uOpacity);
  }
`;

export class HypercoreToy {
  public readonly group: THREE.Group;

  private readonly orbMesh: THREE.Mesh;
  private readonly orbMaterial: THREE.ShaderMaterial;
  private readonly auraMesh: THREE.Mesh;
  private readonly auraMaterial: THREE.ShaderMaterial;

  private readonly outerGimbal: THREE.Group;
  private readonly innerGimbal: THREE.Group;
  private readonly baseGlowMaterial: THREE.MeshStandardMaterial;
  private readonly nodeGlowMaterial: THREE.MeshStandardMaterial;
  private readonly coreLight: THREE.PointLight;

  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];

  private time = 0;
  private pulse = 0;
  private currentEnergy = 0.45;
  private currentSpeed = 1.0;

  private readonly colorA = new THREE.Color(PALETTE.cyan);
  private readonly colorB = new THREE.Color(PALETTE.violet);
  private readonly targetColorA = new THREE.Color(PALETTE.cyan);
  private readonly targetColorB = new THREE.Color(PALETTE.violet);
  private readonly lightColor = new THREE.Color(PALETTE.cyan);
  private readonly scratchGold = new THREE.Color(PALETTE.gold);
  private readonly scratchCyan = new THREE.Color(PALETTE.cyan);

  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'HypercoreToy';
    this.group.position.set(HYPERCORE_SAUCER.position.x, 0, HYPERCORE_SAUCER.position.z);

    const orbY = HYPERCORE_SAUCER.orbCenterY; // 1.55 (well below glass at 2.65 and above ball at 0.54)

    // Shared PBR metallic materials
    const gunmetalMat = this.trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x1d2336,
        metalness: 0.88,
        roughness: 0.28,
      }),
    );

    const brushedChromeMat = this.trackMat(
      new THREE.MeshStandardMaterial({
        color: PALETTE.chrome,
        metalness: 0.96,
        roughness: 0.16,
      }),
    );

    this.baseGlowMaterial = this.trackMat(
      new THREE.MeshStandardMaterial({
        color: PALETTE.cyan,
        emissive: new THREE.Color(PALETTE.cyan),
        emissiveIntensity: 1.35,
        metalness: 0.2,
        roughness: 0.25,
      }),
    );

    this.nodeGlowMaterial = this.trackMat(
      new THREE.MeshStandardMaterial({
        color: PALETTE.magenta,
        emissive: new THREE.Color(PALETTE.magenta),
        emissiveIntensity: 1.5,
        metalness: 0.2,
        roughness: 0.22,
      }),
    );

    // =========================================================================
    // 1. SCULPTED REACTOR BASE COLLAR & REAR HORSESHOE PYLON STRUTS
    //    (Mounted strictly behind the saucer mouth: angles 28..152 deg, -Z rear)
    // =========================================================================
    // Recessed dark saucer floor cup
    const pitGeo = this.trackGeo(new THREE.CircleGeometry(HYPERCORE_SAUCER.captureRadius * 1.08, 32));
    const pitMat = this.trackMat(
      new THREE.MeshStandardMaterial({
        color: 0x070914,
        metalness: 0.6,
        roughness: 0.45,
      }),
    );
    const pitMesh = new THREE.Mesh(pitGeo, pitMat);
    pitMesh.rotation.x = -Math.PI / 2;
    pitMesh.position.y = 0.008;
    this.group.add(pitMesh);

    // Glowing containment halo embedded around the saucer lip (flush, never snags ball)
    const haloGeo = this.trackGeo(
      new THREE.RingGeometry(
        HYPERCORE_SAUCER.captureRadius * 1.06,
        HYPERCORE_SAUCER.captureRadius * 1.28,
        36,
      ),
    );
    const haloMesh = new THREE.Mesh(haloGeo, this.baseGlowMaterial);
    haloMesh.rotation.x = -Math.PI / 2;
    haloMesh.position.y = 0.012;
    this.group.add(haloMesh);

    // Rear horseshoe reactor armor collar sitting outside backstopRadius (0.62 -> 0.78)
    // Arc from 20 deg to 160 deg around -Z back half
    const arcStart = (20 * Math.PI) / 180;
    const arcLen = (140 * Math.PI) / 180;
    const baseArcPoints: THREE.Vector3[] = [];
    const arcSegs = 20;
    const collarR = 0.76;
    for (let i = 0; i <= arcSegs; i++) {
      const theta = arcStart + (arcLen * i) / arcSegs;
      baseArcPoints.push(
        new THREE.Vector3(Math.cos(theta) * collarR, 0.08, -Math.sin(theta) * collarR),
      );
    }
    const collarCurve = new THREE.CatmullRomCurve3(baseArcPoints);
    const collarGeo = this.trackGeo(new THREE.TubeGeometry(collarCurve, 24, 0.085, 10, false));
    const collarMesh = new THREE.Mesh(collarGeo, gunmetalMat);
    collarMesh.castShadow = true;
    collarMesh.receiveShadow = true;
    this.group.add(collarMesh);

    // Thin chrome accent rib on top of the horseshoe collar
    const ribArcPoints = baseArcPoints.map((p) => new THREE.Vector3(p.x, 0.16, p.z));
    const ribCurve = new THREE.CatmullRomCurve3(ribArcPoints);
    const ribGeo = this.trackGeo(new THREE.TubeGeometry(ribCurve, 24, 0.028, 8, false));
    const ribMesh = new THREE.Mesh(ribGeo, brushedChromeMat);
    this.group.add(ribMesh);

    // 3 swept arched reactor pylons curving up from rear base collar to support the orb cradle
    // Angles 34 deg (back-right), 90 deg (dead back), 146 deg (back-left) — zero ball interference!
    const pylonAnglesDeg = [34, 90, 146];
    const footGeo = this.trackGeo(new THREE.CylinderGeometry(0.095, 0.12, 0.14, 12));
    const capGeo = this.trackGeo(new THREE.SphereGeometry(0.055, 12, 12));

    for (const deg of pylonAnglesDeg) {
      const rad = (deg * Math.PI) / 180;
      const cosA = Math.cos(rad);
      const sinA = Math.sin(rad);

      // Anchor foot on rear base collar
      const foot = new THREE.Mesh(footGeo, gunmetalMat);
      foot.position.set(cosA * collarR, 0.07, -sinA * collarR);
      foot.castShadow = true;
      this.group.add(foot);

      // Sweeping S-curve strut rising safely outside the 0.62 gimbal envelope to top cradle ring
      const strutCurve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(cosA * collarR, 0.1, -sinA * collarR),
        new THREE.Vector3(cosA * 0.92, 0.72, -sinA * 0.92),
        new THREE.Vector3(cosA * 0.84, 1.48, -sinA * 0.84),
        new THREE.Vector3(cosA * 0.56, 2.08, -sinA * 0.56),
      ]);
      const strutGeo = this.trackGeo(new THREE.TubeGeometry(strutCurve, 20, 0.042, 8, false));
      const strutMesh = new THREE.Mesh(strutGeo, gunmetalMat);
      strutMesh.castShadow = true;
      this.group.add(strutMesh);

      // Chrome glowing emitter tip at top of each pylon
      const emitterCap = new THREE.Mesh(capGeo, this.baseGlowMaterial);
      emitterCap.position.set(cosA * 0.56, 2.08, -sinA * 0.56);
      this.group.add(emitterCap);
    }

    // Upper magnetic crown ring connecting the 3 pylon tips at y = 2.08 (clear below glass 2.65)
    const crownGeo = this.trackGeo(new THREE.TorusGeometry(0.56, 0.032, 10, 32));
    const crownMesh = new THREE.Mesh(crownGeo, brushedChromeMat);
    crownMesh.rotation.x = Math.PI / 2;
    crownMesh.position.y = 2.08;
    this.group.add(crownMesh);

    // =========================================================================
    // 2. CUSTOM GLSL PLASMA REACTOR ORB + CONTAINMENT AURA SHELL
    // =========================================================================
    const orbRadius = 0.35;
    const orbGeo = this.trackGeo(new THREE.SphereGeometry(orbRadius, 40, 40));
    this.orbMaterial = this.trackMat(
      new THREE.ShaderMaterial({
        vertexShader: PLASMA_VERTEX_SHADER,
        fragmentShader: PLASMA_FRAGMENT_SHADER,
        uniforms: {
          uTime: { value: 0 },
          uEnergy: { value: 0.45 },
          uPulse: { value: 0 },
          uColorA: { value: this.colorA.clone() },
          uColorB: { value: this.colorB.clone() },
        },
        toneMapped: true,
      }),
    );

    this.orbMesh = new THREE.Mesh(orbGeo, this.orbMaterial);
    this.orbMesh.position.y = orbY;
    this.group.add(this.orbMesh);

    // Additive translucent containment aura shell just outside the orb
    const auraGeo = this.trackGeo(new THREE.SphereGeometry(orbRadius * 1.24, 28, 28));
    this.auraMaterial = this.trackMat(
      new THREE.ShaderMaterial({
        vertexShader: AURA_VERTEX_SHADER,
        fragmentShader: AURA_FRAGMENT_SHADER,
        uniforms: {
          uColor: { value: new THREE.Color(PALETTE.cyan) },
          uOpacity: { value: 0.28 },
        },
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.FrontSide,
      }),
    );

    this.auraMesh = new THREE.Mesh(auraGeo, this.auraMaterial);
    this.auraMesh.position.y = orbY;
    this.group.add(this.auraMesh);

    // =========================================================================
    // 3. COUNTER-ROTATING BRUSHED-CHROME GIMBAL RINGS
    // =========================================================================
    this.outerGimbal = this.buildGimbalRing(0.58, 0.032, brushedChromeMat, gunmetalMat);
    this.outerGimbal.position.y = orbY;
    this.outerGimbal.rotation.set(0.42, 0, 0.25);
    this.group.add(this.outerGimbal);

    this.innerGimbal = this.buildGimbalRing(0.47, 0.026, brushedChromeMat, gunmetalMat);
    this.innerGimbal.position.y = orbY;
    this.innerGimbal.rotation.set(-0.65, 0.5, -0.35);
    this.group.add(this.innerGimbal);

    // =========================================================================
    // 4. PULSING REACTOR POINT LIGHT
    // =========================================================================
    this.coreLight = new THREE.PointLight(PALETTE.cyan, 4.5, 9.5, 1.8);
    this.coreLight.position.set(0, orbY, 0);
    this.group.add(this.coreLight);
  }

  private buildGimbalRing(
    radius: number,
    tubeRadius: number,
    ringMat: THREE.Material,
    clampMat: THREE.Material,
  ): THREE.Group {
    const g = new THREE.Group();

    const torusGeo = this.trackGeo(new THREE.TorusGeometry(radius, tubeRadius, 12, 48));
    const torus = new THREE.Mesh(torusGeo, ringMat);
    torus.castShadow = true;
    g.add(torus);

    // 4 sculpted clamp brackets + glowing emitter dots at 90-deg intervals
    const clampGeo = this.trackGeo(
      new THREE.BoxGeometry(tubeRadius * 2.8, tubeRadius * 3.1, tubeRadius * 3.1),
    );
    const dotGeo = this.trackGeo(new THREE.SphereGeometry(tubeRadius * 1.05, 10, 10));

    for (let i = 0; i < 4; i++) {
      const angle = (i * Math.PI) / 2;
      const cx = Math.cos(angle) * radius;
      const cy = Math.sin(angle) * radius;

      const clamp = new THREE.Mesh(clampGeo, clampMat);
      clamp.position.set(cx, cy, 0);
      clamp.rotation.z = angle;
      g.add(clamp);

      const dot = new THREE.Mesh(dotGeo, i % 2 === 0 ? this.baseGlowMaterial : this.nodeGlowMaterial);
      dot.position.set(Math.cos(angle) * (radius + tubeRadius * 1.15), Math.sin(angle) * (radius + tubeRadius * 1.15), 0);
      g.add(dot);
    }

    return g;
  }

  public triggerPulse(): void {
    this.pulse = 1.0;
  }

  public update(dt: number, state: HypercoreToyState): void {
    const safeDt = Math.min(Math.max(dt, 0), 0.1);
    this.time += safeDt;
    this.pulse = Math.max(0, this.pulse - safeDt * 2.4);

    // Determine target palette, spin rate, and reactor energy from game state
    let targetEnergy = 0.42;
    let targetSpeed = 1.0;

    if (state.isTilted) {
      this.targetColorA.setHex(0x281038);
      this.targetColorB.setHex(0x521226);
      targetEnergy = 0.08;
      targetSpeed = 0.12;
    } else if (state.isMultiball || state.lockCount >= 3) {
      // Blazing Hypernova Overdrive: magenta <-> gold cycling
      const hueShift = 0.5 + 0.5 * Math.sin(this.time * 4.2);
      this.targetColorA.setHex(PALETTE.magenta).lerp(this.scratchGold, hueShift * 0.45);
      this.targetColorB.setHex(PALETTE.gold).lerp(this.scratchCyan, (1 - hueShift) * 0.35);
      targetEnergy = 1.35;
      targetSpeed = 3.6;
    } else if (state.lockCount === 2) {
      this.targetColorA.setHex(PALETTE.violet);
      this.targetColorB.setHex(PALETTE.magenta);
      targetEnergy = 0.92;
      targetSpeed = 2.25;
    } else if (state.lockCount === 1) {
      this.targetColorA.setHex(PALETTE.cyan);
      this.targetColorB.setHex(PALETTE.violet);
      targetEnergy = 0.65;
      targetSpeed = 1.5;
    } else {
      this.targetColorA.setHex(PALETTE.cyan);
      this.targetColorB.setHex(0x4b38ff);
      targetEnergy = 0.42;
      targetSpeed = 0.95;
    }

    if (!state.isTilted && state.isCapturing) {
      targetEnergy += 0.65;
      targetSpeed += 2.2;
    }

    const flashBoost = state.isTilted ? 0 : Math.max(0, state.flashIntensity) * 0.55;

    // Smoothly interpolate color, energy, and gimbal angular speed
    const lerpRate = 1 - Math.exp(-safeDt * 6.5);
    this.colorA.lerp(this.targetColorA, lerpRate);
    this.colorB.lerp(this.targetColorB, lerpRate);
    this.currentEnergy += (targetEnergy - this.currentEnergy) * lerpRate;
    this.currentSpeed += (targetSpeed - this.currentSpeed) * lerpRate;

    const effectiveEnergy = this.currentEnergy + flashBoost;
    const effectivePulse = this.pulse + (state.isCapturing ? 0.35 * (0.5 + 0.5 * Math.sin(this.time * 18)) : 0);

    // Update plasma shader uniforms
    this.orbMaterial.uniforms.uTime.value = this.time;
    this.orbMaterial.uniforms.uEnergy.value = effectiveEnergy;
    this.orbMaterial.uniforms.uPulse.value = effectivePulse;
    (this.orbMaterial.uniforms.uColorA.value as THREE.Color).copy(this.colorA);
    (this.orbMaterial.uniforms.uColorB.value as THREE.Color).copy(this.colorB);

    // Subtle orb scale throb + slow core spin
    const orbScale = 1.0 + 0.028 * Math.sin(this.time * 3.8) + effectivePulse * 0.085;
    this.orbMesh.scale.setScalar(orbScale);
    this.orbMesh.rotation.y += safeDt * 0.6 * this.currentSpeed;

    // Containment aura shell pulse (subtle translucent rim ~0.24..0.45 so core filaments stay crisp)
    (this.auraMaterial.uniforms.uColor.value as THREE.Color).copy(this.colorB);
    this.auraMaterial.uniforms.uOpacity.value = state.isTilted
      ? 0.06
      : Math.min(0.45, 0.22 + effectiveEnergy * 0.12 + effectivePulse * 0.14);
    this.auraMesh.scale.setScalar(orbScale * (1.0 + effectivePulse * 0.12));

    // Counter-rotating gimbal rings
    this.outerGimbal.rotation.y += safeDt * 1.15 * this.currentSpeed;
    this.outerGimbal.rotation.x += safeDt * 0.48 * this.currentSpeed;

    this.innerGimbal.rotation.y -= safeDt * 1.75 * this.currentSpeed;
    this.innerGimbal.rotation.z += safeDt * 0.92 * this.currentSpeed;

    // Emissive trim & emitter nodes match live core state (vibrant without clipping white)
    this.baseGlowMaterial.color.copy(this.colorA);
    this.baseGlowMaterial.emissive.copy(this.colorA);
    this.baseGlowMaterial.emissiveIntensity = state.isTilted
      ? 0.12
      : Math.min(1.6, 0.72 + effectiveEnergy * 0.5 + effectivePulse * 0.45);

    this.nodeGlowMaterial.color.copy(this.colorB);
    this.nodeGlowMaterial.emissive.copy(this.colorB);
    this.nodeGlowMaterial.emissiveIntensity = state.isTilted
      ? 0.12
      : Math.min(1.65, 0.78 + effectiveEnergy * 0.55 + effectivePulse * 0.48);

    // Pulsing reactor point light
    const lightWave = 0.88 + 0.12 * Math.sin(this.time * (3.5 + this.currentSpeed * 1.8));
    this.lightColor.copy(this.colorA).lerp(this.colorB, 0.5);
    this.coreLight.color.copy(this.lightColor);
    this.coreLight.intensity = state.isTilted
      ? 0.3
      : (2.2 + effectiveEnergy * 2.5 + effectivePulse * 2.6) * lightWave;
  }

  public dispose(): void {
    for (const g of this.geometries) {
      g.dispose();
    }
    for (const m of this.materials) {
      m.dispose();
    }
    this.geometries.length = 0;
    this.materials.length = 0;
  }

  private trackGeo<T extends THREE.BufferGeometry>(geo: T): T {
    this.geometries.push(geo);
    return geo;
  }

  private trackMat<T extends THREE.Material>(mat: T): T {
    this.materials.push(mat);
    return mat;
  }
}
