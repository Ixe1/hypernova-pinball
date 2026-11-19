/**
 * HYPERNOVA — Dark Arcade Studio HDRI & Surrounding 1990s Arcade Room Builder
 *
 * Generates:
 *   1. High-contrast procedural Dark Arcade Studio environment map via PMREMGenerator
 *      (deep obsidian surround + bright overhead cyan, magenta, and warm-white neon
 *      light strips so chrome pinballs, wireform rails, and brushed stainless cabinet
 *      trim catch dramatic specular ribbons).
 *   2. Moody surrounding 1990s arcade room anchored cleanly to arcade floor Y = 0:
 *      - Procedural 90s geometric neon-speckled arcade carpet floor
 *      - Soft animated under-cabinet cyan/magenta floor bounce glow
 *      - Distant dark arcade back wall with pulsing neon cove strips & subtle
 *        distant neighboring arcade cabinet silhouettes
 */

import * as THREE from 'three';
import { PALETTE } from '../config/constants';

export interface RebuildEnvironmentOptions {
  /** Skip disposing the previous WebGLRenderTarget (use on WebGL context restore to avoid INVALID_OPERATION warnings). */
  readonly skipDisposeOld?: boolean;
}

export interface ArcadeEnvironment {
  readonly envMap: THREE.Texture;
  readonly roomGroup: THREE.Group;
  rebuildEnvironment(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    options?: RebuildEnvironmentOptions,
  ): THREE.Texture;
  update(t: number): void;
  dispose(): void;
}

function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generates a tileable 512x512 dark indigo-charcoal 1990s arcade carpet texture
 * with subtle geometric neon confetti triangles, orbits, squiggles, and speckles.
 */
function createArcadeCarpetTexture(): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Failed to acquire 2D canvas context for arcade carpet texture.');
  }

  const rng = createRng(0x1993_ca9e);

  // Deep moody indigo-charcoal carpet weave base
  ctx.fillStyle = '#080a16';
  ctx.fillRect(0, 0, size, size);

  // Subtle dark woven fabric stipple
  for (let i = 0; i < 3600; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const shade = rng() > 0.5 ? 'rgba(26, 32, 62, 0.24)' : 'rgba(4, 5, 12, 0.35)';
    ctx.fillStyle = shade;
    ctx.fillRect(x, y, 2, 2);
  }

  // Helper to draw seamlessly wrapped across tile edges
  const drawWrapped = (cx: number, cy: number, drawFn: (ox: number, oy: number) => void): void => {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        drawFn(cx + dx * size, cy + dy * size);
      }
    }
  };

  const neonColors = [
    'rgba(0, 240, 255, 0.24)',
    'rgba(255, 43, 214, 0.22)',
    'rgba(139, 61, 255, 0.26)',
    'rgba(255, 155, 26, 0.18)',
  ];

  // Classic 90s arcade geometric triangles
  for (let i = 0; i < 24; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const r = 7 + rng() * 11;
    const rot = rng() * Math.PI * 2;
    const col = neonColors[i % neonColors.length];
    const filled = rng() > 0.65;

    drawWrapped(x, y, (ox, oy) => {
      ctx.save();
      ctx.translate(ox, oy);
      ctx.rotate(rot);
      ctx.beginPath();
      ctx.moveTo(0, -r);
      ctx.lineTo(r * 0.86, r * 0.65);
      ctx.lineTo(-r * 0.86, r * 0.65);
      ctx.closePath();
      if (filled) {
        ctx.fillStyle = col;
        ctx.fill();
      } else {
        ctx.strokeStyle = col;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      ctx.restore();
    });
  }

  // Geometric retro squiggles & zig-zag ribbons
  for (let i = 0; i < 18; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const rot = rng() * Math.PI * 2;
    const col = neonColors[(i + 1) % neonColors.length];

    drawWrapped(x, y, (ox, oy) => {
      ctx.save();
      ctx.translate(ox, oy);
      ctx.rotate(rot);
      ctx.strokeStyle = col;
      ctx.lineWidth = 2.2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-16, 0);
      ctx.lineTo(-8, -6);
      ctx.lineTo(0, 5);
      ctx.lineTo(8, -6);
      ctx.lineTo(16, 2);
      ctx.stroke();
      ctx.restore();
    });
  }

  // Tiny orbital rings & star confetti flecks
  for (let i = 0; i < 36; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const r = 3 + rng() * 7;
    const col = neonColors[(i + 2) % neonColors.length];

    drawWrapped(x, y, (ox, oy) => {
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(ox, oy, r, 0, Math.PI * 2);
      ctx.stroke();
    });
  }

  for (let i = 0; i < 120; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const r = 1 + rng() * 2;
    ctx.fillStyle = neonColors[i % neonColors.length];
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(14, 14);
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Generates a soft under-cabinet cyan/violet/magenta floor bounce spill decal texture.
 */
function createUnderGlowTexture(): THREE.CanvasTexture {
  const w = 512;
  const h = 512;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Failed to acquire 2D canvas context for under-cabinet glow.');
  }

  ctx.clearRect(0, 0, w, h);

  // Left cyan bounce lobe
  const leftGrad = ctx.createRadialGradient(w * 0.34, h * 0.5, 10, w * 0.34, h * 0.5, w * 0.44);
  leftGrad.addColorStop(0.0, 'rgba(0, 240, 255, 0.52)');
  leftGrad.addColorStop(0.45, 'rgba(0, 180, 255, 0.22)');
  leftGrad.addColorStop(1.0, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = leftGrad;
  ctx.fillRect(0, 0, w, h);

  // Right magenta bounce lobe
  ctx.globalCompositeOperation = 'screen';
  const rightGrad = ctx.createRadialGradient(w * 0.66, h * 0.5, 10, w * 0.66, h * 0.5, w * 0.44);
  rightGrad.addColorStop(0.0, 'rgba(255, 43, 214, 0.48)');
  rightGrad.addColorStop(0.45, 'rgba(170, 40, 255, 0.22)');
  rightGrad.addColorStop(1.0, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = rightGrad;
  ctx.fillRect(0, 0, w, h);

  // Center violet core merge
  const centerGrad = ctx.createRadialGradient(w * 0.5, h * 0.5, 16, w * 0.5, h * 0.5, w * 0.38);
  centerGrad.addColorStop(0.0, 'rgba(139, 61, 255, 0.36)');
  centerGrad.addColorStop(1.0, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = centerGrad;
  ctx.fillRect(0, 0, w, h);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Generates a subtle recessed CRT / arcade marquee glow texture for distant
 * background cabinets so they read as moody atmospheric silhouettes, never flat blocks.
 */
function createDistantPanelTexture(isMarquee: boolean): THREE.CanvasTexture {
  const w = 256;
  const h = isMarquee ? 96 : 192;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Failed to acquire 2D canvas context for distant cabinet panel.');
  }

  // Deep recessed bezel background
  ctx.fillStyle = '#050712';
  ctx.fillRect(0, 0, w, h);

  // Soft diffused interior glow vignette
  const grad = ctx.createRadialGradient(
    w * 0.5,
    h * 0.5,
    Math.min(w, h) * 0.08,
    w * 0.5,
    h * 0.5,
    Math.max(w, h) * 0.52,
  );
  grad.addColorStop(0.0, 'rgba(255, 255, 255, 0.85)');
  grad.addColorStop(0.55, 'rgba(215, 228, 255, 0.35)');
  grad.addColorStop(0.88, 'rgba(60, 80, 120, 0.08)');
  grad.addColorStop(1.0, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = grad;
  ctx.fillRect(10, 10, w - 20, h - 20);

  if (isMarquee) {
    // Stylized blurred marquee stripe hint
    ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.fillRect(28, h * 0.36, w - 56, h * 0.14);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.fillRect(54, h * 0.58, w - 108, h * 0.1);
  } else {
    // Subtle dark CRT scanlines
    ctx.fillStyle = 'rgba(0, 0, 0, 0.38)';
    for (let y = 0; y < h; y += 6) {
      ctx.fillRect(0, y, w, 2);
    }
  }

  // Dark matte bezel frame
  ctx.strokeStyle = 'rgba(4, 5, 12, 0.95)';
  ctx.lineWidth = 14;
  ctx.strokeRect(0, 0, w, h);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Generates a balanced Dark Arcade Studio HDRI environment texture using PMREMGenerator.
 * Keeps the overhead zenith dark so flat playfield glass, clearcoat wood, and horizontal
 * steel rails stay rich and glare-free, while narrower lateral HDR neon strips (~1.3-1.75)
 * give chrome pinballs, wireform tubes, and curved hardware crisp specular ribbons.
 */
function generateStudioEnvMap(renderer: THREE.WebGLRenderer): THREE.WebGLRenderTarget {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.background = new THREE.Color(0x040610);

  const tempGeos: THREE.BufferGeometry[] = [];
  const tempMats: THREE.Material[] = [];

  const addPanel = (
    w: number,
    h: number,
    pos: [number, number, number],
    lookAt: [number, number, number],
    r: number,
    g: number,
    b: number,
  ): void => {
    const geo = new THREE.PlaneGeometry(w, h);
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color().setRGB(r, g, b),
      side: THREE.DoubleSide,
    });
    tempGeos.push(geo);
    tempMats.push(mat);

    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(pos[0], pos[1], pos[2]);
    mesh.lookAt(lookAt[0], lookAt[1], lookAt[2]);
    envScene.add(mesh);
  };

  // Deep obsidian-indigo arcade room studio dome (keeps zenith glare-free)
  const shellGeo = new THREE.SphereGeometry(40, 24, 16);
  const shellMat = new THREE.MeshBasicMaterial({
    color: 0x060916,
    side: THREE.BackSide,
  });
  tempGeos.push(shellGeo);
  tempMats.push(shellMat);
  envScene.add(new THREE.Mesh(shellGeo, shellMat));

  // Narrow high-lateral warm-white studio rim strips (off-zenith so flat glass never glares white,
  // while curved chrome pinballs & wireform tubes catch sharp crisp metallic highlights)
  addPanel(1.8, 22.0, [-10.5, 13.5, 0.0], [0, 0, 0], 1.55, 1.62, 1.78);
  addPanel(1.8, 22.0, [10.5, 13.5, 0.0], [0, 0, 0], 1.55, 1.62, 1.78);
  addPanel(11.0, 1.6, [0.0, 14.5, -14.0], [0, 0, 0], 1.65, 1.5, 1.38);

  // Mid-lateral neon cyan & laser magenta accent strips for 1990s cosmic metallic sheen
  addPanel(1.8, 24.0, [-15.5, 9.0, -1.0], [0, 0, 0], 0.14, 1.42, 1.78);
  addPanel(1.8, 24.0, [15.5, 9.0, -1.0], [0, 0, 0], 1.72, 0.22, 1.48);

  // Side horizontal arcade marquee bounce panels (colored rim glints on chrome spheres)
  addPanel(13.0, 3.6, [-19.0, 3.2, -3.5], [0, 1.5, 0], 0.1, 1.15, 1.48);
  addPanel(13.0, 3.6, [19.0, 3.2, -3.5], [0, 1.5, 0], 1.42, 0.18, 1.22);

  // Distant warm amber & violet fore/aft accents
  addPanel(10.0, 2.8, [0.0, 6.5, -20.0], [0, 1.5, 0], 1.45, 0.86, 0.24);
  addPanel(8.0, 2.4, [0.0, 4.0, 19.5], [0, 1.5, 0], 0.65, 0.38, 1.2);

  // Subtle low-value indigo floor reflection plane
  addPanel(32.0, 32.0, [0.0, -14.0, 0.0], [0, 0, 0], 0.1, 0.13, 0.24);

  const renderTarget = pmrem.fromScene(envScene, 0.04);

  // Clean up temporary studio scene assets & PMREM generator
  for (const g of tempGeos) g.dispose();
  for (const m of tempMats) m.dispose();
  pmrem.dispose();

  return renderTarget;
}

/**
 * Builds the procedural Dark Arcade Studio HDRI and surrounding dim 1990s arcade room.
 * Arcade floor rests cleanly at world Y = 0, matching CabinetBuilder leg contact.
 */
export function buildArcadeEnvironment(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
): ArcadeEnvironment {
  let pmremTarget = generateStudioEnvMap(renderer);
  let currentEnvMap = pmremTarget.texture;

  scene.environment = currentEnvMap;
  scene.background = new THREE.Color(PALETTE.bgDeep);
  // Linear fog begins well behind the cabinet/backbox so the machine stays razor crisp
  scene.fog = new THREE.Fog(PALETTE.bgDeep, 48, 105);

  const roomGroup = new THREE.Group();
  roomGroup.name = 'ArcadeRoomEnvironment';

  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const textures: THREE.Texture[] = [];

  const trackGeo = <T extends THREE.BufferGeometry>(g: T): T => {
    geometries.push(g);
    return g;
  };
  const trackMat = <T extends THREE.Material>(m: T): T => {
    materials.push(m);
    return m;
  };

  // =========================================================================
  // 1. PROCEDURAL 90s NEON-SPECKLED ARCADE CARPET FLOOR AT Y = 0
  // =========================================================================
  const carpetTex = createArcadeCarpetTexture();
  textures.push(carpetTex);

  const floorGeo = trackGeo(new THREE.PlaneGeometry(120, 120));
  const floorMat = trackMat(
    new THREE.MeshStandardMaterial({
      map: carpetTex,
      roughness: 0.94,
      metalness: 0.03,
      envMapIntensity: 0.18,
    }),
  );
  const floorMesh = new THREE.Mesh(floorGeo, floorMat);
  floorMesh.rotation.x = -Math.PI / 2;
  floorMesh.position.y = 0;
  floorMesh.receiveShadow = true;
  roomGroup.add(floorMesh);

  // =========================================================================
  // 2. SOFT UNDER-CABINET COLORED FLOOR BOUNCE GLOW (CENTERED AT (0, 0.02, 0))
  // =========================================================================
  const underGlowTex = createUnderGlowTexture();
  textures.push(underGlowTex);

  const underGlowGeo = trackGeo(new THREE.PlaneGeometry(20, 30));
  const underGlowMat = trackMat(
    new THREE.MeshBasicMaterial({
      map: underGlowTex,
      transparent: true,
      opacity: 0.56,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  const underGlowMesh = new THREE.Mesh(underGlowGeo, underGlowMat);
  underGlowMesh.rotation.x = -Math.PI / 2;
  underGlowMesh.position.set(0, 0.025, 0);
  roomGroup.add(underGlowMesh);

  // =========================================================================
  // 3. DISTANT ARCADE BACK WALL & AMBIENT NEON COVE STRIPS (Z = -29)
  // =========================================================================
  const backWallZ = -29;
  const wallMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x060814,
      roughness: 0.9,
      metalness: 0.08,
      envMapIntensity: 0.14,
    }),
  );

  const backWallGeo = trackGeo(new THREE.PlaneGeometry(124, 58));
  const backWall = new THREE.Mesh(backWallGeo, wallMat);
  backWall.position.set(0, 29, backWallZ);
  roomGroup.add(backWall);

  // Subtle left & right flanking arcade room walls far outside camera paths
  const sideWallGeo = trackGeo(new THREE.PlaneGeometry(108, 58));
  const leftWall = new THREE.Mesh(sideWallGeo, wallMat);
  leftWall.rotation.y = Math.PI / 2;
  leftWall.position.set(-50, 29, 12);
  roomGroup.add(leftWall);

  const rightWall = new THREE.Mesh(sideWallGeo, wallMat);
  rightWall.rotation.y = -Math.PI / 2;
  rightWall.position.set(50, 29, 12);
  roomGroup.add(rightWall);

  // Animated distant neon ambiance strips on the back wall (tasteful, low-glare)
  const animatedStrips: Array<{ mat: THREE.MeshBasicMaterial; base: number; phase: number; speed: number }> = [];

  const addNeonStrip = (
    w: number,
    h: number,
    x: number,
    y: number,
    z: number,
    colorHex: number,
    intensity: number,
    baseOpacity: number,
    phase: number,
    speed: number,
  ): void => {
    const geo = trackGeo(new THREE.BoxGeometry(w, h, 0.18));
    const col = new THREE.Color(colorHex).multiplyScalar(intensity);
    const mat = trackMat(
      new THREE.MeshBasicMaterial({
        color: col,
        transparent: true,
        opacity: baseOpacity,
      }),
    );
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    roomGroup.add(mesh);
    animatedStrips.push({ mat, base: baseOpacity, phase, speed });
  };

  // Horizontal upper & lower back-wall neon accent tubes
  addNeonStrip(96, 0.2, 0, 42.0, backWallZ + 0.18, PALETTE.cyan, 0.85, 0.45, 0.0, 0.75);
  addNeonStrip(96, 0.16, 0, 40.9, backWallZ + 0.18, PALETTE.magenta, 0.8, 0.4, 1.4, 0.75);
  addNeonStrip(96, 0.16, 0, 8.2, backWallZ + 0.18, PALETTE.violet, 0.75, 0.36, 2.2, 0.6);

  // Vertical architectural neon pilasters framing the distant arcade bay
  const pilasterXs = [-38, -22, 22, 38];
  pilasterXs.forEach((px, idx) => {
    addNeonStrip(
      0.16,
      32,
      px,
      24.5,
      backWallZ + 0.2,
      idx % 2 === 0 ? PALETTE.cyan : PALETTE.magenta,
      0.78,
      0.35,
      idx * 1.1,
      0.85,
    );
  });

  // =========================================================================
  // 4. DISTANT BACKGROUND ARCADE CABINET SILHOUETTES (PERIPHERAL & SUBTLE)
  // =========================================================================
  const marqueePanelTex = createDistantPanelTexture(true);
  const screenPanelTex = createDistantPanelTexture(false);
  textures.push(marqueePanelTex, screenPanelTex);

  const silhouetteMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x070914,
      roughness: 0.82,
      metalness: 0.16,
      envMapIntensity: 0.16,
    }),
  );
  const cabBodyGeo = trackGeo(new THREE.BoxGeometry(7.4, 21.5, 8.4));
  const cabMarqueeGeo = trackGeo(new THREE.PlaneGeometry(6.2, 1.75));
  const cabScreenGeo = trackGeo(new THREE.PlaneGeometry(5.2, 3.8));

  const neighbors: Array<{ x: number; z: number; rotY: number; marqueeColor: number; screenColor: number }> = [
    { x: -28.5, z: -23.5, rotY: 0.14, marqueeColor: PALETTE.magenta, screenColor: PALETTE.cyan },
    { x: -38.5, z: -21.5, rotY: 0.24, marqueeColor: PALETTE.amber, screenColor: PALETTE.violet },
    { x: 28.5, z: -23.5, rotY: -0.14, marqueeColor: PALETTE.cyan, screenColor: PALETTE.magenta },
    { x: 38.5, z: -21.5, rotY: -0.24, marqueeColor: PALETTE.emerald, screenColor: PALETTE.cyan },
  ];

  neighbors.forEach((n, idx) => {
    const cabGroup = new THREE.Group();
    cabGroup.position.set(n.x, 0, n.z);
    cabGroup.rotation.y = n.rotY;

    const body = new THREE.Mesh(cabBodyGeo, silhouetteMat);
    body.position.y = 10.75;
    cabGroup.add(body);

    const marqueeMat = trackMat(
      new THREE.MeshBasicMaterial({
        map: marqueePanelTex,
        color: new THREE.Color(n.marqueeColor).multiplyScalar(0.55),
        transparent: true,
        opacity: 0.26,
      }),
    );
    const marquee = new THREE.Mesh(cabMarqueeGeo, marqueeMat);
    marquee.position.set(0, 19.6, 4.24);
    cabGroup.add(marquee);
    animatedStrips.push({ mat: marqueeMat, base: 0.26, phase: idx * 1.7 + 0.5, speed: 0.7 });

    const screenMat = trackMat(
      new THREE.MeshBasicMaterial({
        map: screenPanelTex,
        color: new THREE.Color(n.screenColor).multiplyScalar(0.45),
        transparent: true,
        opacity: 0.2,
      }),
    );
    const screen = new THREE.Mesh(cabScreenGeo, screenMat);
    screen.position.set(0, 14.0, 4.24);
    screen.rotation.x = -0.18;
    cabGroup.add(screen);
    animatedStrips.push({ mat: screenMat, base: 0.2, phase: idx * 2.1, speed: 1.15 });

    roomGroup.add(cabGroup);
  });

  scene.add(roomGroup);

  return {
    get envMap(): THREE.Texture {
      return currentEnvMap;
    },
    roomGroup,
    rebuildEnvironment(
      nextRenderer: THREE.WebGLRenderer,
      nextScene: THREE.Scene,
      options?: RebuildEnvironmentOptions,
    ): THREE.Texture {
      const previousTarget = pmremTarget;
      const previousEnvMap = currentEnvMap;

      pmremTarget = generateStudioEnvMap(nextRenderer);
      currentEnvMap = pmremTarget.texture;
      nextScene.environment = currentEnvMap;

      if (scene !== nextScene && scene.environment === previousEnvMap) {
        scene.environment = currentEnvMap;
      }

      // Mark procedural room CanvasTextures dirty so they re-upload cleanly after context restore
      for (const tex of textures) {
        tex.needsUpdate = true;
      }

      // Skip disposing dead pre-loss WebGLRenderTarget after WebGL context loss/restore so
      // Chrome does not log "WebGL: INVALID_OPERATION: delete: object does not belong to this context".
      if (!options?.skipDisposeOld) {
        previousTarget.dispose();
      }
      return currentEnvMap;
    },
    update(t: number): void {
      // Gentle breathing under-cabinet neon bounce glow
      underGlowMat.opacity = 0.50 + 0.11 * Math.sin(t * 1.35);

      // Subtle atmospheric shimmer on distant back-wall neon strips & neighbor marquees
      for (let i = 0; i < animatedStrips.length; i++) {
        const s = animatedStrips[i];
        s.mat.opacity = s.base * (0.88 + 0.12 * Math.sin(t * s.speed + s.phase));
      }
    },
    dispose(): void {
      roomGroup.removeFromParent();
      if (scene.environment === currentEnvMap) {
        scene.environment = null;
      }
      pmremTarget.dispose();
      for (const tex of textures) tex.dispose();
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      textures.length = 0;
      geometries.length = 0;
      materials.length = 0;
    },
  };
}
