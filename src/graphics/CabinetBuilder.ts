/**
 * HYPERNOVA — 3D Arcade Cabinet, Legs, Coin Door, Plunger, Backbox & Playfield Glass
 *
 * Constructs the full-scale 1990s cosmic sci-fi pinball cabinet resting cleanly on
 * the arcade room floor (Y = 0), with the playfield pitched at +TABLE_PITCH_DEG (6.5°)
 * centered at world (0, 17.5, 0) for exact 1:1 local alignment with physics & meshes.
 */

import * as THREE from 'three';
import {
  BALL_RADIUS,
  PALETTE,
  PLAYFIELD_GLASS_Y,
  PLAYFIELD_LENGTH,
  PLAYFIELD_WIDTH,
  TABLE_PITCH_RAD,
} from '../config/constants';
import { PLUNGER } from '../config/tableLayout';
import type { GlassMode } from '../config/types';

export const CABINET_FLOOR_Y = 0;
export const CABINET_PLAYFIELD_CENTER_Y = 17.5;
export const CABINET_PLAYFIELD_PIVOT = {
  x: 0,
  y: CABINET_PLAYFIELD_CENTER_Y,
  z: 0,
} as const;

export interface CabinetOptions {
  readonly transliteTexture: THREE.Texture;
  readonly dmdTexture: THREE.Texture;
  readonly playfieldGroup: THREE.Group;
  readonly initialGlassMode?: GlassMode;
}

export interface CabinetRig {
  /** Top-level cabinet root in world space (apply nudge shake offset here). */
  readonly rootGroup: THREE.Group;
  /** Caller-provided playfield group mounted inside the tilted playfield frame (1:1 with physics). */
  readonly playfieldGroup: THREE.Group;
  /** Tilted body pivot at (0, 17.5, 0) rotated +TABLE_PITCH_RAD around X. */
  readonly playfieldMount: THREE.Group;
  /** Upright backbox assembly standing vertically behind the playfield. */
  readonly backboxGroup: THREE.Group;
  /** Updates plunger rod, spring compression, and red knob position for tension t in [0, 1]. */
  setPlungerCompression(t: number): void;
  /** Switches playfield glass reflection visibility & specular intensity. */
  setGlassMode(mode: GlassMode): void;
  /** Scales cabinet general illumination (side neon stripes, translite, coin door lights) e.g. on TILT. */
  setGiDimFactor(factor: number): void;
  /** Disposes all geometries, materials, and internal textures owned by the cabinet rig. */
  dispose(): void;
}

/** Creates a crisp backlit red "25¢" coin-return button CanvasTexture. */
function createCoinReturnTexture(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  // Deep glowing amber-crimson backlit lens gradient
  const grad = ctx.createRadialGradient(64, 58, 8, 64, 64, 72);
  grad.addColorStop(0, '#ff8e5a');
  grad.addColorStop(0.38, '#ff2a38');
  grad.addColorStop(0.8, '#b50c1e');
  grad.addColorStop(1, '#4a050d');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);

  // Subtle molded plastic inner border
  ctx.strokeStyle = 'rgba(255, 220, 180, 0.45)';
  ctx.lineWidth = 4;
  ctx.strokeRect(8, 8, 112, 112);

  // Classic arcade "25¢" legend
  ctx.fillStyle = '#fff5e0';
  ctx.font = 'bold 48px "Arial Black", "Impact", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.7)';
  ctx.shadowBlur = 4;
  ctx.fillText('25¢', 64, 56);

  ctx.shadowBlur = 0;
  ctx.fillStyle = 'rgba(255, 235, 210, 0.85)';
  ctx.font = 'bold 12px sans-serif';
  ctx.fillText('PUSH TO REJECT', 64, 98);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Creates a helical 3D spring curve along +Z from z=0 to z=length. */
function createSpringGeometry(
  radius: number,
  wireRadius: number,
  length: number,
  turns: number,
): THREE.TubeGeometry {
  const points: THREE.Vector3[] = [];
  const totalSamples = turns * 14;
  for (let i = 0; i <= totalSamples; i++) {
    const u = i / totalSamples;
    const angle = u * turns * Math.PI * 2;
    points.push(
      new THREE.Vector3(
        Math.cos(angle) * radius,
        Math.sin(angle) * radius,
        u * length,
      ),
    );
  }
  const curve = new THREE.CatmullRomCurve3(points);
  return new THREE.TubeGeometry(curve, totalSamples, wireRadius, 8, false);
}

/** Creates a classic tapered barrel pinball shooter knob via LatheGeometry oriented along +Z. */
function createPlungerKnobGeometry(): THREE.LatheGeometry {
  const profile = [
    new THREE.Vector2(0.0, 0.0),
    new THREE.Vector2(0.24, 0.0),
    new THREE.Vector2(0.32, 0.14),
    new THREE.Vector2(0.46, 0.42),
    new THREE.Vector2(0.5, 0.72),
    new THREE.Vector2(0.45, 0.94),
    new THREE.Vector2(0.3, 1.08),
    new THREE.Vector2(0.0, 1.12),
  ];
  const geo = new THREE.LatheGeometry(profile, 24);
  geo.rotateX(Math.PI / 2); // Orient axis along +Z outward toward player
  return geo;
}

export function buildCabinet(options: CabinetOptions): CabinetRig {
  const { transliteTexture, dmdTexture, playfieldGroup } = options;

  const ownedGeometries: THREE.BufferGeometry[] = [];
  const ownedMaterials: THREE.Material[] = [];
  const ownedTextures: THREE.Texture[] = [];

  const trackGeo = <T extends THREE.BufferGeometry>(geo: T): T => {
    ownedGeometries.push(geo);
    return geo;
  };
  const trackMat = <T extends THREE.Material>(mat: T): T => {
    ownedMaterials.push(mat);
    return mat;
  };

  const rootGroup = new THREE.Group();
  rootGroup.name = 'HypernovaCabinetRoot';

  // -------------------------------------------------------------------------
  // Shared Cabinet PBR Materials
  // -------------------------------------------------------------------------
  const cabinetWoodMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: PALETTE.cabinetBlack,
      roughness: 0.42,
      metalness: 0.12,
    }),
  );

  const cabinetInnerMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x0e1424,
      roughness: 0.48,
      metalness: 0.25,
    }),
  );

  const brushedSteelMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x8490a4,
      metalness: 0.82,
      roughness: 0.36,
      envMapIntensity: 0.62,
    }),
  );

  const polishedChromeMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xb8c6d8,
      metalness: 0.9,
      roughness: 0.2,
      envMapIntensity: 0.78,
    }),
  );

  const darkGunmetalMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x1a1f2b,
      metalness: 0.72,
      roughness: 0.48,
    }),
  );

  const rubberBlackMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: PALETTE.rubberBlack,
      roughness: 0.85,
      metalness: 0.04,
    }),
  );

  // GI-modulated emissive accent materials
  const cyanStripeMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: PALETTE.cyan,
      emissive: PALETTE.cyan,
      emissiveIntensity: 0.85,
      roughness: 0.28,
      metalness: 0.2,
    }),
  );

  const magentaStripeMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: PALETTE.magenta,
      emissive: PALETTE.magenta,
      emissiveIntensity: 0.8,
      roughness: 0.28,
      metalness: 0.2,
    }),
  );

  const startButtonMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: PALETTE.emerald,
      emissive: PALETTE.emerald,
      emissiveIntensity: 0.75,
      roughness: 0.28,
      metalness: 0.1,
    }),
  );

  const coinTex = createCoinReturnTexture();
  if (coinTex) ownedTextures.push(coinTex);

  const coinButtonMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: coinTex ? 0xffffff : PALETTE.crimson,
      map: coinTex ?? null,
      emissive: coinTex ? 0xff9a8a : PALETTE.crimson,
      emissiveMap: coinTex ?? null,
      emissiveIntensity: 1.0,
      roughness: 0.28,
      metalness: 0.08,
    }),
  );

  const plungerKnobMat = trackMat(
    new THREE.MeshPhysicalMaterial({
      color: PALETTE.redPlunger,
      emissive: 0x990b1f,
      emissiveIntensity: 0.65,
      roughness: 0.14,
      metalness: 0.05,
      clearcoat: 1.0,
      clearcoatRoughness: 0.08,
    }),
  );

  // -------------------------------------------------------------------------
  // 1. Tilted Playfield & Cabinet Body Assembly (6.5° pitch around X)
  // -------------------------------------------------------------------------
  const playfieldMount = new THREE.Group();
  playfieldMount.name = 'CabinetTiltedBody';
  playfieldMount.position.set(0, CABINET_PLAYFIELD_CENTER_Y, 0);
  playfieldMount.rotation.x = TABLE_PITCH_RAD;
  rootGroup.add(playfieldMount);

  // Mount caller's playfield group directly at local (0, 0, 0) — 1:1 with physics!
  playfieldGroup.position.set(0, 0, 0);
  playfieldGroup.rotation.set(0, 0, 0);
  playfieldMount.add(playfieldGroup);

  const bodyWallThickness = 0.52;
  const bodyBottomY = -5.35;
  const bodyTopY = 2.76;
  const bodyHeight = bodyTopY - bodyBottomY; // 8.11
  const bodyCenterY = (bodyTopY + bodyBottomY) * 0.5;
  const bodyLength = PLAYFIELD_LENGTH + 2.0; // 23.2 (Z: -11.6 .. +11.6)
  const sideWallCenterX = PLAYFIELD_WIDTH * 0.5 + bodyWallThickness * 0.5; // 5.46
  const outerHalfWidth = PLAYFIELD_WIDTH * 0.5 + bodyWallThickness; // 5.72

  // Left & Right Satin-Black Cabinet Side Walls
  const sideWallGeo = trackGeo(new THREE.BoxGeometry(bodyWallThickness, bodyHeight, bodyLength));
  for (const sign of [-1, 1] as const) {
    const sideWall = new THREE.Mesh(sideWallGeo, cabinetWoodMat);
    sideWall.position.set(sign * sideWallCenterX, bodyCenterY, 0);
    sideWall.castShadow = true;
    sideWall.receiveShadow = true;
    playfieldMount.add(sideWall);

    // Subtle dark brushed inner sidewall liner above the playfield
    const innerLiner = new THREE.Mesh(
      trackGeo(new THREE.PlaneGeometry(PLAYFIELD_LENGTH + 0.6, PLAYFIELD_GLASS_Y + 0.15)),
      cabinetInnerMat,
    );
    innerLiner.position.set(sign * (PLAYFIELD_WIDTH * 0.5 + 0.01), PLAYFIELD_GLASS_Y * 0.5, 0);
    innerLiner.rotation.y = sign === -1 ? Math.PI / 2 : -Math.PI / 2;
    playfieldMount.add(innerLiner);

    // Recessed Glowing Sci-Fi Side Stripes on exterior wall
    const outerX = sign * (outerHalfWidth + 0.015);
    const channelFrame = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(0.06, 2.25, 19.6)),
      darkGunmetalMat,
    );
    channelFrame.position.set(outerX - sign * 0.015, -1.1, -0.2);
    playfieldMount.add(channelFrame);

    // Upper cyan speed stripe + diagonal flare
    const cyanBar = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(0.06, 0.36, 18.6)),
      cyanStripeMat,
    );
    cyanBar.position.set(outerX + sign * 0.01, -0.42, -0.2);
    playfieldMount.add(cyanBar);

    // Lower magenta accent stripe
    const magentaBar = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(0.06, 0.24, 16.4)),
      magentaStripeMat,
    );
    magentaBar.position.set(outerX + sign * 0.01, -1.35, -0.5);
    playfieldMount.add(magentaBar);

    // Diagonal futuristic side slashes near front flipper zone
    for (let s = 0; s < 3; s++) {
      const slash = new THREE.Mesh(
        trackGeo(new THREE.BoxGeometry(0.06, 0.16, 1.3)),
        s % 2 === 0 ? cyanStripeMat : magentaStripeMat,
      );
      slash.position.set(outerX + sign * 0.012, -1.15 - s * 0.28, 7.6 + s * 0.55);
      slash.rotation.x = 0.55;
      playfieldMount.add(slash);
    }

    // Brushed Stainless Steel Side Rail capping top edge
    const sideRailTop = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(bodyWallThickness + 0.14, 0.14, bodyLength - 0.5)),
      brushedSteelMat,
    );
    sideRailTop.position.set(sign * (sideWallCenterX + 0.02), bodyTopY + 0.06, -0.15);
    sideRailTop.castShadow = true;
    sideRailTop.receiveShadow = true;
    playfieldMount.add(sideRailTop);

    const sideRailLip = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(0.1, 0.56, bodyLength - 0.5)),
      brushedSteelMat,
    );
    sideRailLip.position.set(sign * (outerHalfWidth + 0.04), bodyTopY - 0.18, -0.15);
    playfieldMount.add(sideRailLip);

    // Exterior Side Arcade Flipper Button + Chrome Bezel
    const btnBezel = new THREE.Mesh(
      trackGeo(new THREE.CylinderGeometry(0.42, 0.48, 0.14, 20)),
      polishedChromeMat,
    );
    btnBezel.rotation.z = sign * (Math.PI / 2);
    btnBezel.position.set(sign * (outerHalfWidth + 0.06), 0.72, 8.65);
    playfieldMount.add(btnBezel);

    const btnCap = new THREE.Mesh(
      trackGeo(new THREE.CylinderGeometry(0.32, 0.34, 0.18, 20)),
      sign === -1 ? cyanStripeMat : magentaStripeMat,
    );
    btnCap.rotation.z = sign * (Math.PI / 2);
    btnCap.position.set(sign * (outerHalfWidth + 0.15), 0.72, 8.65);
    playfieldMount.add(btnCap);
  }

  // Belly Pan (Cabinet Bottom), Front Panel, and Rear Panel
  const bellyPan = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(PLAYFIELD_WIDTH + 0.3, 0.44, bodyLength - 0.4)),
    cabinetWoodMat,
  );
  bellyPan.position.set(0, bodyBottomY + 0.22, 0);
  bellyPan.receiveShadow = true;
  playfieldMount.add(bellyPan);

  const frontPanel = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(outerHalfWidth * 2, bodyHeight, 0.62)),
    cabinetWoodMat,
  );
  frontPanel.position.set(0, bodyCenterY, PLAYFIELD_LENGTH * 0.5 + 0.69); // Z = +11.29, outer face Z = +11.60
  frontPanel.castShadow = true;
  frontPanel.receiveShadow = true;
  playfieldMount.add(frontPanel);

  // Flush with bodyTopY so the rear cabinet wall NEVER clips the upright backbox speaker/DMD panel
  const rearPanel = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(outerHalfWidth * 2, bodyHeight, 0.65)),
    cabinetWoodMat,
  );
  rearPanel.position.set(0, bodyCenterY, -(PLAYFIELD_LENGTH * 0.5 + 0.68)); // Z = -11.28
  rearPanel.castShadow = true;
  rearPanel.receiveShadow = true;
  playfieldMount.add(rearPanel);

  // Sculpted Brushed Stainless Front Lockdown Bar
  const lockdownGroup = new THREE.Group();
  lockdownGroup.position.set(0, bodyTopY + 0.08, PLAYFIELD_LENGTH * 0.5 + 0.78);
  const lockdownTop = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(outerHalfWidth * 2 + 0.28, 0.32, 1.15)),
    brushedSteelMat,
  );
  lockdownTop.castShadow = true;
  lockdownTop.receiveShadow = true;
  lockdownGroup.add(lockdownTop);

  const lockdownFrontLip = new THREE.Mesh(
    trackGeo(new THREE.CylinderGeometry(0.18, 0.18, outerHalfWidth * 2 + 0.28, 16)),
    polishedChromeMat,
  );
  lockdownFrontLip.rotation.z = Math.PI / 2;
  lockdownFrontLip.position.set(0, -0.02, 0.56);
  lockdownGroup.add(lockdownFrontLip);
  playfieldMount.add(lockdownGroup);

  // -------------------------------------------------------------------------
  // 2. Authentic Front Metal Coin Door & Glowing "25¢" Buttons
  // -------------------------------------------------------------------------
  const frontFaceZ = PLAYFIELD_LENGTH * 0.5 + 1.0; // Z = +11.60
  const coinDoorGroup = new THREE.Group();
  coinDoorGroup.name = 'CoinDoor';
  coinDoorGroup.position.set(-0.4, -1.6, frontFaceZ + 0.06);

  // Outer hammered steel frame
  const coinOuter = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(4.65, 5.5, 0.22)),
    darkGunmetalMat,
  );
  coinOuter.castShadow = true;
  coinDoorGroup.add(coinOuter);

  // Brushed chrome trim border strips
  const hTrimGeo = trackGeo(new THREE.BoxGeometry(4.78, 0.12, 0.25));
  const vTrimGeo = trackGeo(new THREE.BoxGeometry(0.12, 5.62, 0.25));
  for (const s of [-1, 1] as const) {
    const hTrim = new THREE.Mesh(hTrimGeo, brushedSteelMat);
    hTrim.position.set(0, s * 2.74, 0.02);
    coinDoorGroup.add(hTrim);
    const vTrim = new THREE.Mesh(vTrimGeo, brushedSteelMat);
    vTrim.position.set(s * 2.34, 0, 0.02);
    coinDoorGroup.add(vTrim);
  }

  // Upper recessed coin-entry section + lower vault return door
  const upperDoorRecess = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(4.05, 2.35, 0.1)),
    cabinetWoodMat,
  );
  upperDoorRecess.position.set(0, 1.15, 0.1);
  coinDoorGroup.add(upperDoorRecess);

  const lowerVaultDoor = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(4.05, 2.2, 0.16)),
    darkGunmetalMat,
  );
  lowerVaultDoor.position.set(0, -1.35, 0.1);
  coinDoorGroup.add(lowerVaultDoor);

  // Keyhole lock cylinder on upper-right of coin door
  const lockCylinder = new THREE.Mesh(
    trackGeo(new THREE.CylinderGeometry(0.16, 0.16, 0.18, 16)),
    polishedChromeMat,
  );
  lockCylinder.rotation.x = Math.PI / 2;
  lockCylinder.position.set(1.62, 1.85, 0.18);
  coinDoorGroup.add(lockCylinder);

  // Twin Backlit Red "25¢" Coin-Return Buttons & Lower Return Cups
  const coinFrameGeo = trackGeo(new THREE.BoxGeometry(1.16, 1.16, 0.16));
  const coinButtonGeo = trackGeo(new THREE.BoxGeometry(0.92, 0.92, 0.12));
  const coinSlotGeo = trackGeo(new THREE.BoxGeometry(0.08, 0.56, 0.14));
  const returnCupGeo = trackGeo(new THREE.BoxGeometry(0.95, 0.65, 0.14));

  for (const slotX of [-0.95, 0.45]) {
    // Black outer bezel
    const bezel = new THREE.Mesh(coinFrameGeo, rubberBlackMat);
    bezel.position.set(slotX, 1.12, 0.16);
    coinDoorGroup.add(bezel);

    // Glowing red 25¢ translucent push button
    const button = new THREE.Mesh(coinButtonGeo, coinButtonMat);
    button.position.set(slotX, 1.12, 0.22);
    coinDoorGroup.add(button);

    // Metallic coin insertion slot beside button
    const slotPlate = new THREE.Mesh(coinSlotGeo, polishedChromeMat);
    slotPlate.position.set(slotX + 0.72, 1.15, 0.18);
    coinDoorGroup.add(slotPlate);

    // Lower coin return flap
    const returnCup = new THREE.Mesh(returnCupGeo, cabinetWoodMat);
    returnCup.position.set(slotX, -1.45, 0.16);
    coinDoorGroup.add(returnCup);
  }

  playfieldMount.add(coinDoorGroup);

  // Glowing START arcade push button on front-left panel beside coin door
  const startBezel = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(0.76, 0.76, 0.16)),
    rubberBlackMat,
  );
  startBezel.position.set(-4.05, 0.65, frontFaceZ + 0.08);
  playfieldMount.add(startBezel);

  const startButton = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(0.56, 0.56, 0.18)),
    startButtonMat,
  );
  startButton.position.set(-4.05, 0.65, frontFaceZ + 0.14);
  playfieldMount.add(startButton);

  // -------------------------------------------------------------------------
  // 3. Shooter Plunger Housing, Animated Spring Rod & Glowing Red Knob
  // -------------------------------------------------------------------------
  const plungerX = PLUNGER.laneCenterX; // 4.75
  const plungerY = BALL_RADIUS; // 0.27 (aligned straight into ball center!)

  // Mounting flange plate & chrome barrel housing bolted to front face
  const plungerFlange = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(1.18, 1.38, 0.14)),
    brushedSteelMat,
  );
  plungerFlange.position.set(plungerX, plungerY, frontFaceZ + 0.06);
  playfieldMount.add(plungerFlange);

  const plungerBarrel = new THREE.Mesh(
    trackGeo(new THREE.CylinderGeometry(0.32, 0.36, 0.62, 20)),
    polishedChromeMat,
  );
  plungerBarrel.rotation.x = Math.PI / 2;
  plungerBarrel.position.set(plungerX, plungerY, frontFaceZ + 0.36);
  playfieldMount.add(plungerBarrel);

  // Animated sliding plunger rod + internal rubber tip + external red knob
  const plungerAssembly = new THREE.Group();
  plungerAssembly.name = 'ShooterPlungerAssembly';
  plungerAssembly.position.set(plungerX, plungerY, 0);
  playfieldMount.add(plungerAssembly);

  const rodStartZ = PLUNGER.tipRestZ + 0.16;
  const rodEndZ = frontFaceZ + 1.45;
  const rodLen = rodEndZ - rodStartZ;

  const plungerRod = new THREE.Mesh(
    trackGeo(new THREE.CylinderGeometry(0.085, 0.085, rodLen, 14)),
    polishedChromeMat,
  );
  plungerRod.rotation.x = Math.PI / 2;
  plungerRod.position.set(0, 0, (rodStartZ + rodEndZ) * 0.5);
  plungerAssembly.add(plungerRod);

  // Internal white/black rubber plunger tip inside the shooter lane (touches ball at tipRestZ)
  const plungerTip = new THREE.Mesh(
    trackGeo(new THREE.CylinderGeometry(PLUNGER.tipRadius * 0.85, PLUNGER.tipRadius, 0.34, 16)),
    rubberBlackMat,
  );
  plungerTip.rotation.x = Math.PI / 2;
  plungerTip.position.set(0, 0, PLUNGER.tipRestZ + 0.17);
  plungerAssembly.add(plungerTip);

  // External glowing translucent red barrel knob
  const plungerKnob = new THREE.Mesh(trackGeo(createPlungerKnobGeometry()), plungerKnobMat);
  plungerKnob.position.set(0, 0, rodEndZ - 0.1);
  plungerKnob.castShadow = true;
  plungerAssembly.add(plungerKnob);

  // Internal chrome compression spring inside shooter lane (between plunger tip & front wall)
  const internalSpringAnchorZ = PLAYFIELD_LENGTH * 0.5 - 0.05; // inner front cabinet face
  const internalSpringRestLen = Math.max(0.4, internalSpringAnchorZ - (PLUNGER.tipRestZ + 0.35));
  const internalSpringMesh = new THREE.Mesh(
    trackGeo(createSpringGeometry(0.18, 0.032, internalSpringRestLen, 8)),
    polishedChromeMat,
  );
  // Anchored at the inner front cabinet face, stretching back toward -Z (tip)
  internalSpringMesh.position.set(plungerX, plungerY, internalSpringAnchorZ);
  internalSpringMesh.scale.z = -1;
  playfieldMount.add(internalSpringMesh);

  // External chrome return spring between barrel housing and red knob
  const extSpringStartZ = frontFaceZ + 0.65;
  const extSpringRestLen = Math.max(0.35, rodEndZ - 0.08 - extSpringStartZ);
  const extSpringMesh = new THREE.Mesh(
    trackGeo(createSpringGeometry(0.17, 0.028, extSpringRestLen, 5)),
    polishedChromeMat,
  );
  extSpringMesh.position.set(plungerX, plungerY, extSpringStartZ);
  playfieldMount.add(extSpringMesh);

  // -------------------------------------------------------------------------
  // 4. Playfield Glass Pane (y = PLAYFIELD_GLASS_Y in playfieldMount local space)
  // -------------------------------------------------------------------------
  const glassMaterial = trackMat(
    new THREE.MeshPhysicalMaterial({
      color: 0xdff6ff,
      transparent: true,
      opacity: 0.035,
      roughness: 0.08,
      metalness: 0.02,
      clearcoat: 0.35,
      clearcoatRoughness: 0.12,
      reflectivity: 0.45,
      envMapIntensity: 0.25,
      depthWrite: false,
    }),
  );

  const glassMesh = new THREE.Mesh(
    trackGeo(new THREE.PlaneGeometry(PLAYFIELD_WIDTH + 0.24, PLAYFIELD_LENGTH + 0.5)),
    glassMaterial,
  );
  glassMesh.name = 'PlayfieldGlass';
  glassMesh.rotation.x = -Math.PI / 2;
  glassMesh.position.set(0, PLAYFIELD_GLASS_Y, 0);
  glassMesh.renderOrder = 20;
  playfieldMount.add(glassMesh);

  // Subtle etched front edge highlight on the glass pane under the lockdown bar
  const glassEdgeMat = trackMat(
    new THREE.MeshBasicMaterial({
      color: 0x99e8ff,
      transparent: true,
      opacity: 0.14,
      depthWrite: false,
    }),
  );
  const glassFrontTrim = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(PLAYFIELD_WIDTH + 0.2, 0.05, 0.06)),
    glassEdgeMat,
  );
  glassFrontTrim.position.set(0, PLAYFIELD_GLASS_Y, PLAYFIELD_LENGTH * 0.5 + 0.22);
  playfieldMount.add(glassFrontTrim);

  // -------------------------------------------------------------------------
  // 5. Four Brushed-Chrome Angled Cabinet Legs Resting Cleanly on Y = 0
  // -------------------------------------------------------------------------
  const cosPitch = Math.cos(TABLE_PITCH_RAD);
  const sinPitch = Math.sin(TABLE_PITCH_RAD);

  const localToWorldCabinet = (lx: number, ly: number, lz: number): THREE.Vector3 =>
    new THREE.Vector3(
      lx,
      CABINET_PLAYFIELD_CENTER_Y + ly * cosPitch - lz * sinPitch,
      ly * sinPitch + lz * cosPitch,
    );

  const legConfigs = [
    { sideX: -1, sideZ: 1, localZ: 10.35, footX: -5.98, footZ: 10.65 },
    { sideX: 1, sideZ: 1, localZ: 10.35, footX: 5.98, footZ: 10.65 },
    { sideX: -1, sideZ: -1, localZ: -10.35, footX: -5.98, footZ: -10.95 },
    { sideX: 1, sideZ: -1, localZ: -10.35, footX: 5.98, footZ: -10.95 },
  ] as const;

  const footPadGeo = trackGeo(new THREE.CylinderGeometry(0.42, 0.48, 0.16, 18));
  const levelerStudGeo = trackGeo(new THREE.CylinderGeometry(0.11, 0.11, 0.72, 12));
  const boltHeadGeo = trackGeo(new THREE.CylinderGeometry(0.14, 0.14, 0.14, 6));

  for (const cfg of legConfigs) {
    const topAttach = localToWorldCabinet(cfg.sideX * 5.65, -2.55, cfg.localZ);
    const footTop = new THREE.Vector3(cfg.footX, CABINET_FLOOR_Y + 0.62, cfg.footZ);

    const legVec = new THREE.Vector3().subVectors(topAttach, footTop);
    const legLen = legVec.length();
    const legMid = new THREE.Vector3().addVectors(topAttach, footTop).multiplyScalar(0.5);

    // Sculpted chamfered square chrome leg post
    const legGeo = trackGeo(new THREE.BoxGeometry(0.58, legLen, 0.58));
    const legMesh = new THREE.Mesh(legGeo, brushedSteelMat);
    legMesh.position.copy(legMid);
    legMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), legVec.clone().normalize());
    legMesh.castShadow = true;
    legMesh.receiveShadow = true;
    rootGroup.add(legMesh);

    // Chrome corner mounting plate & hex leg bolts gripping cabinet body
    const platePos = localToWorldCabinet(cfg.sideX * 5.75, -3.25, cfg.localZ);
    const plate = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(0.18, 2.3, 1.05)),
      polishedChromeMat,
    );
    plate.position.copy(platePos);
    plate.rotation.x = TABLE_PITCH_RAD;
    rootGroup.add(plate);

    for (const dy of [-0.55, 0.55]) {
      const bolt = new THREE.Mesh(boltHeadGeo, polishedChromeMat);
      bolt.rotation.z = Math.PI / 2;
      bolt.position.copy(localToWorldCabinet(cfg.sideX * 5.88, -3.25 + dy, cfg.localZ));
      rootGroup.add(bolt);
    }

    // Threaded steel leveler stud + rubber leveling foot flush on Y = 0
    const stud = new THREE.Mesh(levelerStudGeo, polishedChromeMat);
    stud.position.set(cfg.footX, CABINET_FLOOR_Y + 0.44, cfg.footZ);
    rootGroup.add(stud);

    const footPad = new THREE.Mesh(footPadGeo, rubberBlackMat);
    footPad.position.set(cfg.footX, CABINET_FLOOR_Y + 0.08, cfg.footZ); // bottom at exact Y = 0.00!
    footPad.castShadow = true;
    footPad.receiveShadow = true;
    rootGroup.add(footPad);
  }

  // -------------------------------------------------------------------------
  // 6. Tall Upright Backbox (Vertical — Translite, Stereo Speakers, Amber DMD)
  // -------------------------------------------------------------------------
  const backboxGroup = new THREE.Group();
  backboxGroup.name = 'CabinetBackbox';
  rootGroup.add(backboxGroup);

  const bbWidth = 13.8; // X: -6.9 .. +6.9
  const bbBottomY = 21.15;
  const bbTopY = 36.25;
  const bbHeight = bbTopY - bbBottomY; // 15.1
  const bbCenterY = (bbBottomY + bbTopY) * 0.5; // 28.7
  const bbFrontZ = -10.75;
  const bbBackZ = -14.8;
  const bbDepth = bbFrontZ - bbBackZ; // 4.05
  const bbCenterZ = (bbFrontZ + bbBackZ) * 0.5; // -12.775

  // Rear structural neck pedestal anchoring backbox seamlessly onto tilted cabinet rear (tucked behind bbFrontZ)
  const neckCollar = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(11.35, 3.8, 2.8)),
    cabinetWoodMat,
  );
  neckCollar.position.set(0, 19.35, -12.3);
  neckCollar.castShadow = true;
  neckCollar.receiveShadow = true;
  backboxGroup.add(neckCollar);

  // Main upright backbox wooden enclosure
  const backboxShell = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(bbWidth, bbHeight, bbDepth)),
    cabinetWoodMat,
  );
  backboxShell.position.set(0, bbCenterY, bbCenterZ);
  backboxShell.castShadow = true;
  backboxShell.receiveShadow = true;
  backboxGroup.add(backboxShell);

  // Chrome T-molding edge trim framing backbox front perimeter + side glowing ribs
  const bbTopTrim = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(bbWidth + 0.16, 0.22, 0.3)),
    brushedSteelMat,
  );
  bbTopTrim.position.set(0, bbTopY + 0.04, bbFrontZ + 0.06);
  backboxGroup.add(bbTopTrim);

  const bbMidDivider = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(bbWidth + 0.12, 0.24, 0.26)),
    brushedSteelMat,
  );
  bbMidDivider.position.set(0, 25.15, bbFrontZ + 0.08);
  backboxGroup.add(bbMidDivider);

  for (const sign of [-1, 1] as const) {
    const bbSideTrim = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(0.2, bbHeight + 0.16, 0.3)),
      brushedSteelMat,
    );
    bbSideTrim.position.set(sign * (bbWidth * 0.5 + 0.02), bbCenterY, bbFrontZ + 0.06);
    backboxGroup.add(bbSideTrim);

    // Side glowing neon ribs on backbox flanks
    const sideNeon = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(0.08, bbHeight - 2.2, 0.22)),
      sign === -1 ? cyanStripeMat : magentaStripeMat,
    );
    sideNeon.position.set(sign * (bbWidth * 0.5 + 0.03), bbCenterY + 0.2, bbCenterZ + 0.6);
    backboxGroup.add(sideNeon);
  }

  // --- Upper Backlit Glowing Translite Panel ---
  const transliteWidth = 12.6;
  const transliteHeight = 10.3;
  const transliteCenterY = 30.52;

  const transliteMaterial = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: transliteTexture,
      emissive: 0xffffff,
      emissiveMap: transliteTexture,
      emissiveIntensity: 0.92,
      roughness: 0.22,
      metalness: 0.04,
      envMapIntensity: 0.45,
    }),
  );

  const transliteMesh = new THREE.Mesh(
    trackGeo(new THREE.PlaneGeometry(transliteWidth, transliteHeight)),
    transliteMaterial,
  );
  transliteMesh.name = 'BackboxTranslite';
  transliteMesh.position.set(0, transliteCenterY, bbFrontZ + 0.05);
  backboxGroup.add(transliteMesh);

  // Dark molded lightbox frame strips around the translite perimeter
  const frameDepth = 0.22;
  const topFrame = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(bbWidth - 0.15, 0.46, frameDepth)),
    darkGunmetalMat,
  );
  topFrame.position.set(0, transliteCenterY + transliteHeight * 0.5 + 0.22, bbFrontZ + 0.09);
  backboxGroup.add(topFrame);

  for (const sign of [-1, 1] as const) {
    const sideFrame = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(0.55, transliteHeight + 0.45, frameDepth)),
      darkGunmetalMat,
    );
    sideFrame.position.set(
      sign * (transliteWidth * 0.5 + 0.27),
      transliteCenterY,
      bbFrontZ + 0.09,
    );
    backboxGroup.add(sideFrame);
  }

  // --- Lower Speaker Panel & Recessed Amber DMD Display ---
  const speakerPanelY = 23.15;
  const speakerFascia = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(bbWidth - 0.2, 3.65, 0.16)),
    darkGunmetalMat,
  );
  speakerFascia.position.set(0, speakerPanelY, bbFrontZ + 0.04);
  backboxGroup.add(speakerFascia);

  // Recessed Amber DMD Screen (exact 4:1 ratio for 128x32 matrix -> 5.76 x 1.44)
  const dmdWidth = 5.76;
  const dmdHeight = 1.44;

  // Deep shadow bezel frame & recessed hood surrounding DMD
  const dmdBackplate = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(dmdWidth + 0.48, dmdHeight + 0.44, 0.16)),
    rubberBlackMat,
  );
  dmdBackplate.position.set(0, speakerPanelY, bbFrontZ + 0.12);
  backboxGroup.add(dmdBackplate);

  // Recessed 3D bezel hood rails protruding cleanly past the DMD screen
  const hoodDepth = 0.22;
  const hoodThick = 0.16;
  const dmdHoodTop = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(dmdWidth + 0.48, hoodThick, hoodDepth)),
    rubberBlackMat,
  );
  dmdHoodTop.position.set(0, speakerPanelY + dmdHeight * 0.5 + hoodThick * 0.5, bbFrontZ + 0.2);
  backboxGroup.add(dmdHoodTop);

  const dmdHoodBot = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(dmdWidth + 0.48, hoodThick, hoodDepth)),
    rubberBlackMat,
  );
  dmdHoodBot.position.set(0, speakerPanelY - dmdHeight * 0.5 - hoodThick * 0.5, bbFrontZ + 0.2);
  backboxGroup.add(dmdHoodBot);

  for (const s of [-1, 1] as const) {
    const dmdHoodSide = new THREE.Mesh(
      trackGeo(new THREE.BoxGeometry(hoodThick + 0.08, dmdHeight + 0.36, hoodDepth)),
      rubberBlackMat,
    );
    dmdHoodSide.position.set(s * (dmdWidth * 0.5 + (hoodThick + 0.08) * 0.5), speakerPanelY, bbFrontZ + 0.2);
    backboxGroup.add(dmdHoodSide);
  }

  // Thin chrome accent pinstripe around DMD bezel
  const dmdAccentTop = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(dmdWidth + 0.56, 0.05, 0.26)),
    brushedSteelMat,
  );
  dmdAccentTop.position.set(0, speakerPanelY + dmdHeight * 0.5 + 0.24, bbFrontZ + 0.2);
  backboxGroup.add(dmdAccentTop);

  const dmdAccentBot = new THREE.Mesh(
    trackGeo(new THREE.BoxGeometry(dmdWidth + 0.56, 0.05, 0.26)),
    brushedSteelMat,
  );
  dmdAccentBot.position.set(0, speakerPanelY - dmdHeight * 0.5 - 0.24, bbFrontZ + 0.2);
  backboxGroup.add(dmdAccentBot);

  const dmdMaterial = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x070400,
      emissive: 0xffffff,
      emissiveMap: dmdTexture,
      emissiveIntensity: 1.28,
      roughness: 0.2,
      metalness: 0.05,
    }),
  );

  const dmdScreen = new THREE.Mesh(
    trackGeo(new THREE.PlaneGeometry(dmdWidth, dmdHeight)),
    dmdMaterial,
  );
  dmdScreen.name = 'BackboxDmdScreen';
  dmdScreen.position.set(0, speakerPanelY, bbFrontZ + 0.215);
  backboxGroup.add(dmdScreen);

  // Left & Right Stereo Circular Speaker Grilles
  const speakerRimGeo = trackGeo(new THREE.TorusGeometry(1.26, 0.1, 14, 36));
  const speakerAccentGeo = trackGeo(new THREE.TorusGeometry(1.36, 0.032, 10, 36));
  const speakerConeGeo = trackGeo(new THREE.CylinderGeometry(1.2, 0.45, 0.26, 28));
  const speakerDustCapGeo = trackGeo(new THREE.SphereGeometry(0.36, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.5));
  const grilleRingRadii = [0.46, 0.78, 1.06];
  const grilleRingGeos = grilleRingRadii.map((r) =>
    trackGeo(new THREE.TorusGeometry(r, 0.028, 8, 32)),
  );
  const grilleSpokeGeo = trackGeo(new THREE.BoxGeometry(2.38, 0.045, 0.045));

  for (const sign of [-1, 1] as const) {
    const spkX = sign * 4.72;
    const spkGroup = new THREE.Group();
    spkGroup.position.set(spkX, speakerPanelY, bbFrontZ + 0.12);

    // Dark speaker cone
    const cone = new THREE.Mesh(speakerConeGeo, rubberBlackMat);
    cone.rotation.x = -Math.PI / 2;
    cone.position.z = -0.04;
    spkGroup.add(cone);

    const dustCap = new THREE.Mesh(speakerDustCapGeo, darkGunmetalMat);
    dustCap.rotation.x = Math.PI / 2;
    dustCap.position.z = -0.02;
    spkGroup.add(dustCap);

    // Brushed chrome circular outer bezel
    const rim = new THREE.Mesh(speakerRimGeo, brushedSteelMat);
    rim.position.z = 0.08;
    spkGroup.add(rim);

    // Subtle glowing cyan/magenta neon halo ring
    const accent = new THREE.Mesh(
      speakerAccentGeo,
      sign === -1 ? cyanStripeMat : magentaStripeMat,
    );
    accent.position.z = 0.05;
    spkGroup.add(accent);

    // Concentric protective metal speaker grille rings + crossbars
    for (const ringGeo of grilleRingGeos) {
      const ring = new THREE.Mesh(ringGeo, darkGunmetalMat);
      ring.position.z = 0.12;
      spkGroup.add(ring);
    }
    for (let k = 0; k < 4; k++) {
      const spoke = new THREE.Mesh(grilleSpokeGeo, darkGunmetalMat);
      spoke.rotation.z = (k * Math.PI) / 4;
      spoke.position.z = 0.115;
      spkGroup.add(spoke);
    }

    backboxGroup.add(spkGroup);
  }

  // -------------------------------------------------------------------------
  // Interactive Controls & State Setters
  // -------------------------------------------------------------------------
  const setPlungerCompression = (t: number): void => {
    const clamped = Math.max(0, Math.min(1, t));
    const pullOffset = clamped * PLUNGER.maxPullDistance;

    // Slide plunger rod, internal rubber tip, and red exterior knob cleanly toward +Z
    plungerAssembly.position.z = pullOffset;

    // Compress internal lane spring as tip pulls toward the front wall
    const remainingInternal = Math.max(0.18, internalSpringRestLen - pullOffset);
    internalSpringMesh.scale.z = -(remainingInternal / internalSpringRestLen);

    // Stretch external return spring smoothly between barrel housing and pulled knob
    const stretchedExternal = extSpringRestLen + pullOffset;
    extSpringMesh.scale.z = stretchedExternal / extSpringRestLen;
  };

  const setGlassMode = (mode: GlassMode): void => {
    if (mode === 'off') {
      glassMesh.visible = false;
      glassFrontTrim.visible = false;
      return;
    }
    glassMesh.visible = true;
    glassFrontTrim.visible = true;
    if (mode === 'subtle') {
      glassMaterial.opacity = 0.035;
      glassMaterial.envMapIntensity = 0.25;
      glassMaterial.clearcoat = 0.35;
      glassEdgeMat.opacity = 0.08;
    } else {
      // 'realistic' — crisp specular sheen of overhead arcade strips without washing out playfield
      glassMaterial.opacity = 0.085;
      glassMaterial.envMapIntensity = 0.6;
      glassMaterial.clearcoat = 0.5;
      glassEdgeMat.opacity = 0.18;
    }
    glassMaterial.needsUpdate = true;
  };

  const setGiDimFactor = (factor: number): void => {
    const clamped = Math.max(0.08, Math.min(1.25, factor));
    cyanStripeMat.emissiveIntensity = 0.85 * clamped;
    magentaStripeMat.emissiveIntensity = 0.8 * clamped;
    startButtonMat.emissiveIntensity = 0.75 * (0.25 + 0.75 * clamped);
    coinButtonMat.emissiveIntensity = 1.0 * (0.35 + 0.65 * clamped);
    // Translite dims dramatically on TILT while staying faintly backlit like real WPC GI relay drop
    transliteMaterial.emissiveIntensity = 0.22 + 0.7 * clamped;
    // DMD remains crisp & luminous even during TILT so players see "TILT!" clearly
    dmdMaterial.emissiveIntensity = 1.32;
  };

  // Apply initial modes
  setPlungerCompression(0);
  setGlassMode(options.initialGlassMode ?? 'subtle');
  setGiDimFactor(1.0);

  const dispose = (): void => {
    for (const geo of ownedGeometries) geo.dispose();
    for (const mat of ownedMaterials) mat.dispose();
    for (const tex of ownedTextures) tex.dispose();
  };

  return {
    rootGroup,
    playfieldGroup,
    playfieldMount,
    backboxGroup,
    setPlungerCompression,
    setGlassMode,
    setGiDimFactor,
    dispose,
  };
}
