/**
 * HYPERNOVA — WebGL Renderer, Scene Graph, Lighting Rig & Selective Bloom Pipeline
 *
 * Manages the Three.js WebGLRenderer (ACESFilmic tone mapping, PCFShadowMap),
 * post-processing EffectComposer (RenderPass -> UnrealBloomPass -> OutputPass),
 * calibrated overhead arcade lighting, and the 4 pooled dynamic flasher PointLights.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { PALETTE, TABLE_PITCH_RAD } from '../config/constants';
import { FLASHER_LAMPS } from '../config/tableLayout';
import type { LampId, LampState, QualityLevel } from '../config/types';

export type LampStateCollection =
  | Partial<Record<LampId, LampState>>
  | ReadonlyMap<LampId, LampState>;

export interface SceneContextCallbacks {
  readonly onLost?: () => void;
  readonly onRestored?: () => void;
}

export interface SceneManagerOptions {
  readonly canvas: HTMLCanvasElement;
  readonly width?: number;
  readonly height?: number;
  readonly quality?: QualityLevel;
  readonly contextCallbacks?: SceneContextCallbacks;
}

export interface FlasherLightEntry {
  readonly lampId: LampId;
  readonly light: THREE.PointLight;
  readonly basePosition: THREE.Vector3;
  readonly baseColor: number;
}

/** Playfield center Y elevation in world space (arcade floor = Y = 0). */
const DEFAULT_PLAYFIELD_CENTER_Y = 17.5;

const BASE_KEY_INTENSITY = 1.55;
const BASE_RIM_INTENSITY = 0.62;
const BASE_HEMI_INTENSITY = 0.52;
const BASE_BACKBOX_SPILL_INTENSITY = 4.2;
const FLASHER_MAX_POINT_INTENSITY = 10.5;
const FLASHER_DISTANCE = 12.0;
const FLASHER_DECAY = 1.85;

function readLampState(
  lamps: LampStateCollection,
  lampId: LampId,
): LampState | undefined {
  if (lamps instanceof Map) {
    return lamps.get(lampId);
  }
  return (lamps as Partial<Record<LampId, LampState>>)[lampId];
}

export class SceneManager {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;

  readonly keyLight: THREE.DirectionalLight;
  readonly rimLight: THREE.DirectionalLight;
  readonly hemiLight: THREE.HemisphereLight;
  readonly backboxGlowLight: THREE.PointLight;

  /** Parent group holding the 4 pooled dynamic flasher PointLights in playfield-local coordinates. */
  readonly flasherGroup: THREE.Group;
  readonly flasherLights: readonly FlasherLightEntry[];

  private readonly canvas: HTMLCanvasElement;
  private quality: QualityLevel;
  private width: number;
  private height: number;
  private lastPixelRatio = 1;
  private lastComposerWidth = 0;
  private lastComposerHeight = 0;
  private giDimFactor = 1.0;
  private composerTarget!: THREE.WebGLRenderTarget;
  private _composer!: EffectComposer;
  private _renderPass!: RenderPass;
  private _bloomPass!: UnrealBloomPass;
  private _outputPass!: OutputPass;
  private contextCallbacks: SceneContextCallbacks | null = null;
  private contextLost = false;
  private disposed = false;

  get composer(): EffectComposer {
    return this._composer;
  }

  get renderPass(): RenderPass {
    return this._renderPass;
  }

  get bloomPass(): UnrealBloomPass {
    return this._bloomPass;
  }

  get outputPass(): OutputPass {
    return this._outputPass;
  }

  private readonly handleContextLost = (event: Event): void => {
    event.preventDefault();
    if (this.disposed) return;
    this.contextLost = true;
    this.contextCallbacks?.onLost?.();
  };

  private readonly handleContextRestored = (): void => {
    if (this.disposed) return;
    this.contextLost = false;

    // Pre-loss GL resources belong to the invalidated context and were already reclaimed
    // by the driver; drop references without calling .dispose() to avoid
    // WebGL INVALID_OPERATION: delete warnings from stale pre-loss dispose listeners.
    const targetShadowSize = this.getShadowMapSize(this.quality);
    this.keyLight.shadow.map = null;
    this.keyLight.shadow.mapPass = null;
    this.keyLight.shadow.mapSize.set(targetShadowSize, targetShadowSize);
    this.keyLight.shadow.needsUpdate = true;

    const pixelRatio = this.getTargetPixelRatio(this.quality);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(this.width, this.height, false);

    // Reallocate fresh EffectComposer & UnrealBloomPass render targets on the restored context
    this.buildPostProcessing();

    // Notify caller so GPU-only PMREM environment & CanvasTextures are refreshed
    this.contextCallbacks?.onRestored?.();
  };

  constructor(options: SceneManagerOptions) {
    const { canvas } = options;
    this.canvas = canvas;
    this.contextCallbacks = options.contextCallbacks ?? null;
    this.quality = options.quality ?? 'high';
    this.width = Math.max(1, Math.floor(options.width ?? (canvas.clientWidth || window.innerWidth || 1280)));
    this.height = Math.max(1, Math.floor(options.height ?? (canvas.clientHeight || window.innerHeight || 720)));

    // 1. WebGLRenderer calibrated for crisp PBR + selective bloom
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      stencil: false,
    });
    // Register context lifecycle listeners AFTER WebGLRenderer so Three.js runs
    // its internal initGLContext() restore before our callbacks rebuild PMREM/textures.
    this.canvas.addEventListener('webglcontextlost', this.handleContextLost, false);
    this.canvas.addEventListener('webglcontextrestored', this.handleContextRestored, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.setPixelRatio(this.getTargetPixelRatio(this.quality));
    this.renderer.setSize(this.width, this.height, false);

    // 2. Scene & subtle deep arcade atmosphere
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(PALETTE.bgDeep);
    this.scene.fog = new THREE.FogExp2(PALETTE.bgDeep, 0.0052);
    this.scene.environmentIntensity = 0.72;

    // 3. PerspectiveCamera (positioned/driven by CameraController)
    this.camera = new THREE.PerspectiveCamera(45, this.width / this.height, 0.5, 160);
    this.camera.position.set(0, 35.2, 23.8);
    this.camera.lookAt(0, 18.5, 0.2);

    // 4. Post-processing pipeline (HDR HalfFloat render target + selective UnrealBloom + OutputPass)
    this.buildPostProcessing();

    // 5. Overhead Arcade Lighting Rig
    // Cool cosmic sky + faint deep magenta floor bounce so dark areas never crush completely
    this.hemiLight = new THREE.HemisphereLight(0x4060a6, 0x24113a, BASE_HEMI_INTENSITY);
    this.hemiLight.position.set(0, 45, 0);
    this.scene.add(this.hemiLight);

    // Angled overhead arcade spotlight / key directional light casting crisp playfield shadows
    this.keyLight = new THREE.DirectionalLight(0xf3f6ff, BASE_KEY_INTENSITY);
    this.keyLight.position.set(11.0, 35.5, 9.5);
    this.keyLight.target.position.set(0, DEFAULT_PLAYFIELD_CENTER_Y, 0);
    this.keyLight.castShadow = true;

    const shadowRes = this.getShadowMapSize(this.quality);
    this.keyLight.shadow.mapSize.set(shadowRes, shadowRes);
    this.keyLight.shadow.camera.near = 6;
    this.keyLight.shadow.camera.far = 54;
    this.keyLight.shadow.camera.left = -10.5;
    this.keyLight.shadow.camera.right = 10.5;
    this.keyLight.shadow.camera.top = 15.5;
    this.keyLight.shadow.camera.bottom = -15.5;
    this.keyLight.shadow.bias = -0.00035;
    this.keyLight.shadow.normalBias = 0.032;
    this.keyLight.shadow.radius = 2.0;
    this.scene.add(this.keyLight);
    this.scene.add(this.keyLight.target);

    // Subtle cool cyan back-rim directional light accentuating chrome rails & wireform curves
    this.rimLight = new THREE.DirectionalLight(0x52c8ff, BASE_RIM_INTENSITY);
    this.rimLight.position.set(-10.5, 29.0, -14.5);
    this.rimLight.target.position.set(0, DEFAULT_PLAYFIELD_CENTER_Y + 0.5, 0);
    this.scene.add(this.rimLight);
    this.scene.add(this.rimLight.target);

    // Soft ambient glow cast from the backlit translite onto the upper arch & cabinet hood
    this.backboxGlowLight = new THREE.PointLight(
      0x7cb8ff,
      BASE_BACKBOX_SPILL_INTENSITY,
      28,
      1.6,
    );
    this.backboxGlowLight.position.set(0, 29.0, -9.0);
    this.scene.add(this.backboxGlowLight);

    // 6. 4 Pooled Dynamic Flasher PointLights (positioned in playfield-local space)
    this.flasherGroup = new THREE.Group();
    this.flasherGroup.name = 'FlasherLightsGroup';
    this.flasherGroup.position.set(0, DEFAULT_PLAYFIELD_CENTER_Y, 0);
    this.flasherGroup.rotation.x = TABLE_PITCH_RAD;
    this.scene.add(this.flasherGroup);

    const flashers: FlasherLightEntry[] = [];
    for (const def of FLASHER_LAMPS) {
      const light = new THREE.PointLight(def.color, 0, FLASHER_DISTANCE, FLASHER_DECAY);
      const basePos = new THREE.Vector3(def.position.x, def.position.y + 0.35, def.position.z);
      light.position.copy(basePos);
      light.name = `Flasher_${def.lampId}`;
      this.flasherGroup.add(light);
      flashers.push({
        lampId: def.lampId,
        light,
        basePosition: basePos,
        baseColor: def.color,
      });
    }
    this.flasherLights = flashers;
  }

  private buildPostProcessing(): void {
    const pixelRatio = this.renderer.getPixelRatio();
    const drawWidth = Math.max(1, Math.floor(this.width * pixelRatio));
    const drawHeight = Math.max(1, Math.floor(this.height * pixelRatio));
    const maxSamples = this.renderer.capabilities.isWebGL2
      ? Math.min(4, this.renderer.capabilities.maxSamples)
      : 0;
    this.composerTarget = new THREE.WebGLRenderTarget(drawWidth, drawHeight, {
      type: THREE.HalfFloatType,
      samples: this.quality === 'high' ? maxSamples : 0,
    });

    this._composer = new EffectComposer(this.renderer, this.composerTarget);
    this._renderPass = new RenderPass(this.scene, this.camera);
    this._bloomPass = new UnrealBloomPass(
      new THREE.Vector2(drawWidth, drawHeight),
      this.quality === 'high' ? 0.26 : 0.2, // strength: crisp neon glow without washing out rails/playfield
      this.quality === 'high' ? 0.26 : 0.22, // radius: tight arcade LED aura
      1.28, // threshold: strictly selective for emissive LEDs, plasma core & flashers
    );
    this._outputPass = new OutputPass();

    this._composer.addPass(this._renderPass);
    this._composer.addPass(this._bloomPass);
    this._composer.addPass(this._outputPass);

    // Normalize EffectComposer logical width/height once after all passes are registered
    this._composer.setSize(this.width, this.height);
    this._bloomPass.resolution.set(drawWidth, drawHeight);
    this.lastPixelRatio = pixelRatio;
    this.lastComposerWidth = this.width;
    this.lastComposerHeight = this.height;
  }

  private getTargetPixelRatio(q: QualityLevel): number {
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    return Math.min(dpr, q === 'high' ? 2 : 1.5);
  }

  private getShadowMapSize(q: QualityLevel): number {
    return q === 'high' ? 2048 : 1024;
  }

  /** Sets the scene's PMREM environment map used by chrome balls, rails, and playfield clearcoat. */
  setEnvironment(envMap: THREE.Texture | null, intensity = 0.72): void {
    this.scene.environment = envMap;
    this.scene.environmentIntensity = intensity;
  }

  /**
   * Reparents the 4 dynamic flasher PointLights directly into the cabinet's tilted
   * `playfieldGroup` so flashers follow nudge shake and sit in exact playfield-local coords.
   */
  attachFlashersTo(playfieldGroup: THREE.Group): void {
    this.flasherGroup.position.set(0, 0, 0);
    this.flasherGroup.rotation.set(0, 0, 0);
    playfieldGroup.add(this.flasherGroup);
  }

  /** Updates the 4 pooled dynamic flasher PointLights from LampController output. */
  applyFlashers(lampStates: LampStateCollection): void {
    for (const entry of this.flasherLights) {
      const state = readLampState(lampStates, entry.lampId);
      if (!state || state.intensity <= 0.005) {
        entry.light.intensity = 0;
        continue;
      }
      entry.light.color.setHex(state.color);
      entry.light.intensity = Math.min(2.6, Math.max(0, state.intensity)) * FLASHER_MAX_POINT_INTENSITY;
    }
  }

  /** Directly sets an individual flasher PointLight by LampId. */
  setFlasher(lampId: LampId, intensity: number, colorHex?: number): void {
    for (const entry of this.flasherLights) {
      if (entry.lampId === lampId) {
        if (colorHex !== undefined) {
          entry.light.color.setHex(colorHex);
        }
        entry.light.intensity = Math.max(0, intensity) * FLASHER_MAX_POINT_INTENSITY;
        return;
      }
    }
  }

  /** Dims overhead playfield general illumination cleanly (e.g. during TILT blackout). */
  setGiDimFactor(factor: number): void {
    const clamped = Math.max(0.15, Math.min(1.2, factor));
    if (Math.abs(clamped - this.giDimFactor) < 0.0005) return;
    this.giDimFactor = clamped;

    this.keyLight.intensity = BASE_KEY_INTENSITY * clamped;
    this.rimLight.intensity = BASE_RIM_INTENSITY * (0.35 + 0.65 * clamped);
    this.hemiLight.intensity = BASE_HEMI_INTENSITY * (0.4 + 0.6 * clamped);
    this.backboxGlowLight.intensity = BASE_BACKBOX_SPILL_INTENSITY * (0.3 + 0.7 * clamped);
  }

  /** Registers lifecycle callbacks for WebGL context loss and restoration. */
  setContextCallbacks(callbacks: SceneContextCallbacks | null): void {
    this.contextCallbacks = callbacks;
  }

  isContextLost(): boolean {
    return this.contextLost;
  }

  getQuality(): QualityLevel {
    return this.quality;
  }

  setQuality(quality: QualityLevel): void {
    if (this.disposed) return;
    this.quality = quality;

    // Refine bloom intensity slightly on medium quality for softer bandwidth usage
    this.bloomPass.strength = quality === 'high' ? 0.26 : 0.2;
    this.bloomPass.radius = quality === 'high' ? 0.26 : 0.22;

    // Defer GPU buffer/shadow reallocations until context is restored
    if (this.contextLost) return;

    // Update shadow map resolution cleanly
    const targetShadowSize = this.getShadowMapSize(quality);
    if (
      this.keyLight.shadow.mapSize.width !== targetShadowSize ||
      this.keyLight.shadow.mapSize.height !== targetShadowSize
    ) {
      this.keyLight.shadow.mapSize.set(targetShadowSize, targetShadowSize);
      if (this.keyLight.shadow.map) {
        this.keyLight.shadow.map.dispose();
        this.keyLight.shadow.map = null;
      }
      if (this.keyLight.shadow.mapPass) {
        this.keyLight.shadow.mapPass.dispose();
        this.keyLight.shadow.mapPass = null;
      }
      this.keyLight.shadow.needsUpdate = true;
    }

    // Update MSAA sample count on composer buffers if WebGL2
    const maxSamples = this.renderer.capabilities.isWebGL2
      ? Math.min(4, this.renderer.capabilities.maxSamples)
      : 0;
    const desiredSamples = quality === 'high' ? maxSamples : 0;
    if (this.composer.renderTarget1.samples !== desiredSamples) {
      this.composer.renderTarget1.samples = desiredSamples;
      this.composer.renderTarget2.samples = desiredSamples;
      this.composer.renderTarget1.dispose();
      this.composer.renderTarget2.dispose();
    }

    this.resize(this.width, this.height);
  }

  resize(width: number, height: number): void {
    if (this.disposed) return;
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));

    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();

    if (this.contextLost) return;

    const pixelRatio = this.getTargetPixelRatio(this.quality);
    const drawWidth = Math.max(1, Math.floor(this.width * pixelRatio));
    const drawHeight = Math.max(1, Math.floor(this.height * pixelRatio));

    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(this.width, this.height, false);

    // Avoid redundant EffectComposer/UnrealBloomPass reallocations:
    // composer.setPixelRatio() internally calls composer.setSize(oldW, oldH).
    const prChanged = pixelRatio !== this.lastPixelRatio;
    const sizeChanged =
      this.width !== this.lastComposerWidth || this.height !== this.lastComposerHeight;
    if (prChanged) {
      this.composer.setPixelRatio(pixelRatio);
      this.lastPixelRatio = pixelRatio;
    }
    if (sizeChanged) {
      this.composer.setSize(this.width, this.height);
      this.lastComposerWidth = this.width;
      this.lastComposerHeight = this.height;
    }
    if (prChanged || sizeChanged) {
      this.bloomPass.resolution.set(drawWidth, drawHeight);
    }
  }

  render(): void {
    if (this.disposed || this.contextLost) return;
    this.composer.render();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.canvas.removeEventListener('webglcontextlost', this.handleContextLost, false);
    this.canvas.removeEventListener('webglcontextrestored', this.handleContextRestored, false);
    this.contextCallbacks = null;

    if (!this.contextLost) {
      this._bloomPass.dispose();
      this._outputPass.dispose();
      this._composer.dispose();
      this.composerTarget.dispose();

      if (this.keyLight.shadow.map) {
        this.keyLight.shadow.map.dispose();
        this.keyLight.shadow.map = null;
      }
      if (this.keyLight.shadow.mapPass) {
        this.keyLight.shadow.mapPass.dispose();
        this.keyLight.shadow.mapPass = null;
      }
    } else {
      this.keyLight.shadow.map = null;
      this.keyLight.shadow.mapPass = null;
    }

    this.renderer.dispose();
  }
}
