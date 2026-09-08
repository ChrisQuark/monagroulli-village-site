// Monagroulli Log Village — web viewer (three.js, vendored, no external requests). See SPEC.md §5.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { sunDirection, formatHour } from './sun.js';
import { Heightfield } from './heightfield.js';
import { WalkController } from './walk.js';
import { initGallery } from './gallery.js';

const $ = (id) => document.getElementById(id);
const DEG = Math.PI / 180;
// house root: "House_<plot>_<n>" / "House_<anything>" (real scene) or "H<n>" (placeholder scene)
const HOUSE_RE = /^(House_P\d+_\d+|House_\d+_\d+|House_[^_]+|H\d+)(?=_|$)/;
const ROOF_RE = /roof/i;
const WALK_RE = /(^|_)(floor|deck|stair(?!_soffit)|step|plinth|terrace|terrain|ground|road|pavement|paving|gravel|path|lawn|grass|court|apron|pad)/i;
// terrain-class meshes (139k-tri terrain, site surfaces): their height comes from the heightfield, so they are kept
// out of the walk raycast when a real heightfield exists (raycasting them cost ~43 ms per frame)
const TERRAIN_RE = /^(terrain|Site_|green_lawn|Green_paving|Court_)/;
const WALL_RE = /(^|_)(wall|glass|win|balustrade|rail|kitchen|island|bed\d|sofa|wardrobe|stove|post|plotwall|retaining|fence)/i;
const v3 = (a) => Array.isArray(a) && a.length >= 3 && a.slice(0, 3).every(Number.isFinite);
const IS_TOUCH = matchMedia('(pointer: coarse)').matches || (navigator.maxTouchPoints > 0 && /Mobi|Android|iP(hone|ad)/.test(navigator.userAgent));
if (IS_TOUCH) document.body.classList.add('touch');

// ---------------------------------------------------------------- WebGL check
const canvas = $('c');
let gl = null;
try {
  // WebGL 2 only: three r163+ refuses a WebGL 1 context, so a fallback would only throw inside main()
  gl = canvas.getContext('webgl2', { antialias: true, alpha: false, powerPreference: 'high-performance' });
} catch (_) { gl = null; }
if (new URLSearchParams(location.search).has('nowebgl')) gl = null;   // debug: preview the no-WebGL overlay

initGallery();
if (!gl) {
  $('loading').hidden = true;
  $('webgl-error').hidden = false;
} else {
  try { main(gl); }
  catch (e) {
    console.error(e);
    $('loading').hidden = true;
    $('webgl-error').hidden = false;
  }
}

function main(gl) {
// ---------------------------------------------------------------- renderer / scene / camera
const renderer = new THREE.WebGLRenderer({ canvas, context: gl, antialias: true, alpha: false });
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap; // PCFSoftShadowMap is deprecated in r185 (aliases to PCF)
renderer.setClearColor(0x0f1418, 1);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 6000);
scene.add(camera);

const labelRenderer = new CSS2DRenderer({ element: $('labels') });

const orbit = new OrbitControls(camera, canvas);
orbit.enableDamping = true;
orbit.dampingFactor = 0.08;
orbit.minDistance = 3;
orbit.maxDistance = 400;
orbit.maxPolarAngle = 88 * DEG;
orbit.screenSpacePanning = false;

// ---------------------------------------------------------------- state
const state = {
  mode: 'orbit',           // orbit | bird | walk
  bird: 'top',
  quality: IS_TOUCH ? 'low' : 'high',
  hour: 16.5,
  northDeg: 112,
  meta: {},
  focus: { box: new THREE.Box3(), center: new THREE.Vector3(), radius: 30, groundY: 0 },
  north: new THREE.Vector3(0, 0, -1),
  east: new THREE.Vector3(1, 0, 0),
  houses: new Map(),       // id -> { id, root, box }
  roofs: [], walkable: [], walls: [], pickable: [], lightsPos: [],
  presets: [],
  envReady: false, glbReady: false, usingSky: false, placeholder: false,
  tween: null,
  labelsVisible: true,
  selected: null,
};

// ---------------------------------------------------------------- lights
const sun = new THREE.DirectionalLight(0xffffff, 3);
sun.castShadow = true;
// the first render allocates the shadow map (4096² + depth ≈ 128 MB) before the GLB lands, so start phones at 2048
sun.shadow.mapSize.set(IS_TOUCH ? 2048 : 4096, IS_TOUCH ? 2048 : 4096);
sun.shadow.bias = -0.00035;
sun.shadow.normalBias = IS_TOUCH ? 0.06 : 0.03;
scene.add(sun, sun.target);
const hemi = new THREE.HemisphereLight(0xbfd4ff, 0x6b5a45, 0.25);
scene.add(hemi);

// pooled point lights for `Light_*` objects (walk mode only, the 4 nearest)
const pointPool = [];
for (let i = 0; i < 4; i++) {
  const l = new THREE.PointLight(0xffc98a, 0, 9, 2);
  l.visible = false;
  scene.add(l);
  pointPool.push(l);
}
let lightUsed = new Uint8Array(0);

// ---------------------------------------------------------------- environment (HDRI → PMREM, else procedural Sky)
const pmrem = new THREE.PMREMGenerator(renderer);
pmrem.compileEquirectangularShader();
let sky = null, skyScene = null, envRT = null, skyBakePending = false;

function useSkyFallback() {
  state.usingSky = true;
  sky = new Sky();
  sky.scale.setScalar(20000);
  const u = sky.material.uniforms;
  u.turbidity.value = 3;
  u.rayleigh.value = 1.2;
  u.mieCoefficient.value = 0.005;
  u.mieDirectionalG.value = 0.8;
  if (u.cloudCoverage) { u.cloudCoverage.value = 0.3; u.cloudDensity.value = 0.35; }
  // three's Sky shader is calibrated for toneMappingExposure ≈ 0.5; scale it down for our exposure 1.0
  // (the same material is used for the PMREM bake, so environment lighting scales consistently)
  u.skyExposure = { value: 0.42 };
  sky.material.fragmentShader = sky.material.fragmentShader
    .replace('uniform float mieDirectionalG;', 'uniform float mieDirectionalG;\n\t\tuniform float skyExposure;')
    .replace('gl_FragColor = vec4( texColor, 1.0 );', 'gl_FragColor = vec4( texColor * skyExposure, 1.0 );');
  sky.material.needsUpdate = true;
  scene.add(sky);
  skyScene = new THREE.Scene();
  skyScene.add(sky.clone()); // same material/uniforms, separate scene for the PMREM bake
  updateSun();               // sets sunPosition and schedules the bake
}

function bakeSky() {
  if (!sky) return;
  if (envRT) envRT.dispose();
  envRT = pmrem.fromScene(skyScene, 0.02);
  scene.environment = envRT.texture;   // intensity follows the time of day in updateSun()
}

new HDRLoader().load('hdri/sky.hdr', (tex) => {
  if (state.usingSky) { tex.dispose(); return; }   // arrived after the timeout below: the Sky fallback is already in use
  tex.mapping = THREE.EquirectangularReflectionMapping;
  envRT = pmrem.fromEquirectangular(tex);
  scene.environment = envRT.texture;
  scene.background = tex;
  updateSun();                                      // sets environment / background intensity for the hour
  envDone();
}, undefined, () => { if (!state.usingSky) { useSkyFallback(); envDone(); } });
// a hung HDR request must not pin the overlay at 90 %
setTimeout(() => { if (!state.envReady && !state.usingSky) { useSkyFallback(); envDone(); } }, 20000);

function envDone() { state.envReady = true; setProgress(); }

// ---------------------------------------------------------------- loading overlay
const loadState = { glb: 0 };
function setProgress(msg) {
  const p = Math.min(100, Math.round(loadState.glb * 90 + (state.envReady ? 10 : 0)));
  $('loadpct').textContent = String(p);
  $('loadbar').style.width = p + '%';
  if (msg !== undefined) $('loadmsg').textContent = msg;
  if (state.envReady && state.glbReady) {
    $('loading').classList.add('done');
    setTimeout(() => { $('loading').hidden = true; }, 600);
  }
}

// ---------------------------------------------------------------- meta / heightfield / GLB
async function fetchJSON(url) {
  try { const r = await fetch(url, { cache: 'no-cache' }); return r.ok ? await r.json() : null; } catch (_) { return null; }
}

const gltfLoader = new GLTFLoader();
const dracoLoader = new DRACOLoader().setDecoderPath('js/vendor/draco/');
gltfLoader.setDRACOLoader(dracoLoader);
function loadGLB(url) {
  return new Promise((resolve, reject) => {
    gltfLoader.load(url, resolve, (ev) => {
      loadState.glb = ev.total ? Math.min(1, ev.loaded / ev.total) : Math.min(0.95, ev.loaded / 25e6);
      setProgress();
    }, reject);
  });
}

let heightfield = new Heightfield(null);

async function boot() {
  const [meta, hf] = await Promise.all([fetchJSON('scene/meta.json'), fetchJSON('scene/heightfield.json')]);
  state.meta = meta || {};
  if (Number.isFinite(state.meta.north_deg)) state.northDeg = state.meta.north_deg;
  const nd = state.northDeg * DEG;
  state.north.set(Math.cos(nd), 0, -Math.sin(nd));
  state.east.set(Math.sin(nd), 0, Math.cos(nd));
  heightfield = new Heightfield(hf);
  walk.heightfield = heightfield;

  let gltf;
  try { gltf = await loadGLB('scene/scene.glb'); }
  catch (_) {
    setProgress('placeholder scene');
    loadState.glb = 0;
    gltf = await loadGLB('scene/placeholder_v1.glb');
    state.placeholder = true;
  }
  onSceneLoaded(gltf.scene);
}

function houseIdOf(o, root) {
  // topmost ancestor (or self) whose name matches a house root
  let id = null, node = null;
  for (let a = o; a && a !== root; a = a.parent) {
    const m = HOUSE_RE.exec(a.name);
    if (m) { id = m[1]; node = a; }
  }
  return id ? { id, node } : null;
}

function ancestorIsRoof(o, root) {
  for (; o && o !== root; o = o.parent) if (ROOF_RE.test(o.name)) return true;
  return false;
}

// The old placeholder GLB was exported without its textures (every textured material is plain white),
// so give it flat colours by material name. Never applied to the real scene.
const PLACEHOLDER_PALETTE = {
  Ground: 0x8a8264, Asphalt: 0x3d3f42, Gravel: 0x9d968a, Paving: 0xb9b2a4, Concrete: 0x9a9892, Stone_Wall: 0x8c8479,
  Log_Larch: 0xc9955a, Cladding_Boards: 0xb88650, Glulam_Beam: 0xc59a60, Oak_Floor: 0xb08652, Clay_Tiles: 0x6e7074,
};
function applyPlaceholderPalette(root) {
  const done = new Set();
  root.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
      if (!m || done.has(m) || m.map) continue;
      done.add(m);
      const c = PLACEHOLDER_PALETTE[m.name];
      if (c !== undefined && m.color) m.color.setHex(c);
    }
  });
}

function instanceRepeats(root) {
  const groups = new Map();
  root.traverse((o) => {
    // lamps (`*_Light_*`) are instanced too: their positions were collected in onSceneLoaded before this runs
    if (!o.isMesh || o.isInstancedMesh) return;
    const mats = Array.isArray(o.material) ? o.material.map((m) => m.uuid).join('|') : o.material.uuid;
    const key = o.geometry.uuid + '#' + mats;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(o);
  });
  const made = [];
  for (const list of groups.values()) {
    if (list.length < 3) continue;
    const first = list[0];
    const im = new THREE.InstancedMesh(first.geometry, first.material, list.length);
    im.name = 'INST' + list.length + '_' + first.name.replace(/^(House_P\d+_\d+|tree_\d+|bush_\d+|car_\d+|inst\d+)_/, '');
    im.castShadow = first.castShadow; im.receiveShadow = first.receiveShadow;
    im.userData.members = [];
    list.forEach((m, i) => {
      m.updateWorldMatrix(true, false);
      im.setMatrixAt(i, m.matrixWorld);
      const hid = houseIdOf(m, root);
      im.userData.members.push({ name: m.name, house: hid ? hid.id : null });
    });
    im.instanceMatrix.needsUpdate = true;
    im.computeBoundingSphere();   // sphere over all instances → off-screen groups are frustum-culled (matrices are static)
    for (const m of list) m.parent.remove(m);
    root.add(im); made.push(im);
  }
  return made;
}

function onSceneLoaded(root) {
  scene.add(root);
  root.updateMatrixWorld(true);
  if (state.placeholder) applyPlaceholderPalette(root);
  const tmp = new THREE.Box3();
  const hb = state.focus.box.makeEmpty();
  const glassMats = new Set();
  const seenMats = new Set();
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const useHF = heightfield.ok && !heightfield.isPlaceholder;

  root.traverse((o) => {
    if (ROOF_RE.test(o.name) && !ancestorIsRoof(o.parent, root)) state.roofs.push(o);
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = true;
    o.frustumCulled = true;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m) continue;
      if (/glass/i.test(m.name || '') || /glass/i.test(o.name)) glassMats.add(m);
      if (seenMats.has(m)) continue;
      seenMats.add(m);
      for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap']) if (m[k]) m[k].anisotropy = aniso;
      // foliage cards: alpha-tested instead of blended — instanced trees cannot be depth-sorted, and blended
      // leaves cast full-quad shadows
      if (/^leaf_/i.test(m.name || '')) { m.transparent = false; m.alphaTest = 0.5; m.depthWrite = true; m.needsUpdate = true; }
    }
    const hid = houseIdOf(o, root);
    if (hid) state.pickable.push(o);                                            // only houses are clickable
    if (WALK_RE.test(o.name) && !(useHF && TERRAIN_RE.test(o.name))) state.walkable.push(o);
    if (WALL_RE.test(o.name)) state.walls.push(o);
    if (/(^|_)Light_/i.test(o.name)) state.lightsPos.push(o.getWorldPosition(new THREE.Vector3()));   // Light_court*, House_*_Light_*
    if (hid) {
      let h = state.houses.get(hid.id);
      if (!h) { h = { id: hid.id, root: hid.node, box: new THREE.Box3() }; state.houses.set(hid.id, h); }
      tmp.setFromObject(o);
      h.box.union(tmp);
      hb.union(tmp);
    }
  });
  lightUsed = new Uint8Array(state.lightsPos.length);

  // Collapse repeated meshes (24 identical houses, hundreds of trees) into InstancedMeshes:
  // ~4000 draw calls -> a few hundred. Done after the traverse so per-house boxes/lights are known.
  const made = instanceRepeats(root);
  if (made.length) {
    const alive = (o) => !!o.parent;
    state.pickable = state.pickable.filter(alive).concat(made.filter((m) => m.userData.members.some((x) => x.house)));
    state.walkable = state.walkable.filter(alive).concat(made.filter((m) => WALK_RE.test(m.name)));
    state.walls = state.walls.filter(alive).concat(made.filter((m) => WALL_RE.test(m.name)));
    state.roofs = state.roofs.filter(alive).concat(made.filter((m) => ROOF_RE.test(m.name)));
  applyVersion(state.version || 1);
  }
  // the controller was built with the pre-instancing arrays; hand it the final ones
  walk.walkable = state.walkable;
  walk.walls = state.walls;

  for (const m of glassMats) {
    m.transparent = true;
    m.depthWrite = false;
    m.envMapIntensity = 1;
    m.side = THREE.DoubleSide;
    m.userData.transmission = m.transmission || 0;
    if (!m.userData.transmission && m.opacity >= 1) m.opacity = 0.4;
  }
  // any other transmissive material (the pool `water`) must be switchable too: its transmission pass re-renders
  // the whole opaque scene every frame, which is what applyQuality() turns off in low quality
  for (const m of seenMats) {
    if (m.isMeshPhysicalMaterial && m.transmission > 0 && !m.userData.transmission) {
      m.userData.transmission = m.transmission;
      m.userData.opacity = m.opacity;
      m.transparent = true;   // so the low-quality opacity fallback actually shows through
    }
  }
  applyQuality();

  // focus bounds: the houses if any, else everything (a huge ground plane must not dominate)
  if (hb.isEmpty()) hb.setFromObject(root);
  const f = state.focus;
  hb.getCenter(f.center);
  f.radius = Math.max(15, Math.min(250, hb.getSize(tmp.min).length() * 0.5));
  f.groundY = hb.min.y;
  if (heightfield.ok && !heightfield.isPlaceholder) {
    const g = heightfield.sample(f.center.x, f.center.z);
    if (g !== null) f.groundY = g;
  }

  fitShadowCamera();
  buildPresets();
  buildLabels();
  updateSun();
  goPreset(state.presets[0], true);

  state.glbReady = true;
  setProgress('');
}

// ---------------------------------------------------------------- sun / shadows
const _sunDir = new THREE.Vector3();
const _sunCol = new THREE.Color();
const WARM = new THREE.Color(1.0, 0.62, 0.35), NOON = new THREE.Color(1.0, 0.97, 0.92);

function updateSun() {
  const d = sunDirection(state.hour, state.northDeg);
  _sunDir.set(d.x, d.y, d.z);
  if (state.mode === 'walk') fitShadowCamera(camera.position, WALK_SHADOW_R, WALK_SHADOW_D); else fitShadowCamera();
  const el = Math.max(0, d.elevation);
  const t = Math.min(1, el / (35 * DEG));
  _sunCol.copy(WARM).lerp(NOON, Math.sqrt(t));
  sun.color.copy(_sunCol);
  sun.intensity = 3.2 * Math.pow(Math.min(1, el / (20 * DEG)), 0.6) + 0.05;
  sun.visible = d.elevation > -2 * DEG;
  hemi.intensity = 0.18 + 0.25 * t;
  // ambient / sky brightness follow the hour too, so the evening is not lit like midday
  scene.environmentIntensity = (state.usingSky ? 0.9 : 1) * (0.3 + 0.7 * t);
  scene.backgroundIntensity = 0.3 + 0.7 * t;
  if (sky) {
    sky.material.uniforms.sunPosition.value.copy(_sunDir);
    if (!skyBakePending) { skyBakePending = true; requestAnimationFrame(() => { skyBakePending = false; bakeSky(); }); }
  }
  $('suntime').value = formatHour(state.hour);
}

// Walk mode: a 25 m shadow box that follows the camera (≈1.2 cm/texel at 4K instead of ≈4.8 cm for the whole site)
const WALK_SHADOW_R = 25, WALK_SHADOW_D = 120;

/** Aim the sun at `center` from `dist` away and size its shadow frustum to the half-extent `radius`
 *  (no arguments: the whole site). */
function fitShadowCamera(center = state.focus.center, radius = state.focus.radius * 1.15 + 20, dist = state.focus.radius * 2.5) {
  sun.position.copy(center).addScaledVector(_sunDir, dist);
  sun.target.position.copy(center);
  sun.target.updateMatrixWorld();
  const c = sun.shadow.camera;
  c.left = -radius; c.right = radius; c.top = radius; c.bottom = -radius;
  c.near = 1; c.far = dist + radius * 2 + 50;
  c.updateProjectionMatrix();
  sun.shadow.needsUpdate = true;
}

// ---------------------------------------------------------------- quality
const VERSION_RE = /(^|_)(Furn|Light)_V([123])_/;
function applyVersion(v) {
  state.version = v;
  scene.traverse((o) => {
    if (!o.isMesh && !o.isInstancedMesh) return;
    const m = VERSION_RE.exec(o.name || '');
    if (m) o.visible = (m[3] === String(v));
  });
  for (const r of state.roofs) { const m = VERSION_RE.exec(r.name || ''); if (m) r.visible = (m[3] === String(v)); }
}
document.getElementById('version')?.addEventListener('change', (e) => applyVersion(e.target.value));

function applyQuality() {
  const hi = state.quality === 'high';
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, hi ? 2 : 1.25));
  const size = hi ? 4096 : 2048;
  if (sun.shadow.mapSize.x !== size) {
    sun.shadow.mapSize.set(size, size);
    if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
  }
  sun.shadow.normalBias = size === 2048 ? 0.06 : 0.03;   // coarser texels need more normal offset to avoid acne
  renderer.transmissionResolutionScale = hi ? 1 : 0.5;    // half-res transmission buffer when it is on at all
  scene.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m || !m.isMeshPhysicalMaterial || !m.userData.transmission) continue;
      m.transmission = hi ? m.userData.transmission : 0;   // transmission pass is costly on low-end GPUs
      m.opacity = hi ? (m.userData.opacity ?? 0.9) : 0.4;
      m.needsUpdate = true;
    }
  });
  $('tQuality').setAttribute('aria-pressed', hi ? 'true' : 'false');
  $('tQuality').title = hi ? 'Quality: high (4K shadows, full DPR) — click for low' : 'Quality: low (2K shadows, 1.25 DPR) — click for high';
  resize();
}

// ---------------------------------------------------------------- presets / camera moves
function buildPresets() {
  const f = state.focus, r = f.radius, c = f.center, N = state.north, E = state.east, gy = f.groundY;
  const v = (base, dn, de, dy) => new THREE.Vector3().copy(base).addScaledVector(N, dn).addScaledVector(E, de).setY(base.y + dy);
  // vertical fov: on a portrait phone the narrow horizontal fov is the limiting one
  const fitD = (r / Math.tan(camera.fov * 0.5 * DEG)) * 1.05 / Math.min(1, camera.aspect);
  const list = [{ name: 'Aerial', pos: v(c, -r * 1.5, -r * 1.5, r * 1.3), target: c.clone() }];
  const fromMeta = Array.isArray(state.meta.presets) ? state.meta.presets : [];
  if (fromMeta.length) {
    for (const p of fromMeta) {
      if (!p || !v3(p.pos) || !v3(p.target)) continue;
      const item = { name: p.name || 'Preset', pos: new THREE.Vector3().fromArray(p.pos), target: new THREE.Vector3().fromArray(p.target) };
      if (item.name.toLowerCase() === 'aerial') list[0] = item; else list.push(item);
    }
  } else {
    // defaults from the bounding box: north road = plot 6 street; pool / court to the south-east (green area)
    list.push({ name: 'Plot 6 street', pos: v(c, r * 0.95, -r * 0.6, 0).setY(gy + 1.7), target: v(c, r * 0.4, 0, 0).setY(gy + 2) });
    list.push({ name: 'Pool', pos: v(c, -r * 0.9, r * 0.5, 0).setY(gy + 6), target: v(c, -r * 0.4, 0, 0).setY(gy) });
    list.push({ name: 'Paddle court', pos: v(c, -r * 0.5, r * 1.1, 0).setY(gy + 8), target: v(c, -r * 0.3, r * 0.4, 0).setY(gy) });
    const first = state.houses.values().next().value;
    const inside = first && findInteriorSpot(first);
    if (inside) list.push({ name: 'Inside a house', pos: inside.pos, target: inside.target });
  }
  list.push({ name: "Bird's eye · top", pos: v(c, -fitD * 0.02, 0, fitD), target: c.clone(), bird: 'top' });
  list.push({ name: "Bird's eye · 45°", pos: v(c, -fitD * 0.75, 0, fitD * 0.75), target: c.clone(), bird: '45' });
  state.presets = list;
  const sel = $('preset');
  sel.innerHTML = '<option value="">Preset…</option>';
  list.forEach((p, i) => {
    if (p.bird) return;
    const o = document.createElement('option'); o.value = String(i); o.textContent = p.name; sel.appendChild(o);
  });
}

// A standing spot inside a house: grid-sample the footprint at eye height above the walkable floor and keep the
// point with the most clearance from Wall_ meshes (8 horizontal probes), preferring the south (veranda) side.
const _probe = new THREE.Raycaster();
const _pp = new THREE.Vector3(), _pd = new THREE.Vector3();
function findInteriorSpot(h) {
  const b = h.box, N = state.north, E = state.east;
  const size = b.getSize(new THREE.Vector3());
  if (size.x < 3 || size.z < 3) return null;
  const c = b.getCenter(new THREE.Vector3());
  let best = null;
  _probe.far = 3;
  for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) {
    const x = b.min.x + size.x * (0.15 + 0.7 * i / 5), z = b.min.z + size.z * (0.15 + 0.7 * j / 5);
    const g = walk.groundAt(x, z, b.max.y + 1);
    if (g === null || g === undefined || g < b.min.y - 0.5 || g > b.min.y + 4.5) continue;   // outside / on the roof
    _pp.set(x, g + 1.2, z);
    let clear = 3;
    for (let k = 0; k < 8 && clear > 0.3; k++) {
      _pd.set(Math.cos(k * Math.PI / 4), 0, Math.sin(k * Math.PI / 4));
      _probe.set(_pp, _pd);
      const hit = _probe.intersectObjects(state.walls, false)[0];
      if (hit && hit.distance < clear) clear = hit.distance;
    }
    if (clear < 0.7) continue;
    const south = -((x - c.x) * N.x + (z - c.z) * N.z) / Math.max(size.x, size.z);   // 0.5 = south edge
    const score = Math.min(clear, 2) + south * 1.5;
    if (!best || score > best.score) best = { score, x, z, g };
  }
  if (!best) return null;
  const pos = new THREE.Vector3(best.x, best.g + 1.6, best.z);
  // look towards the veranda glazing (south), slightly across the room
  const target = pos.clone().addScaledVector(N, -4).addScaledVector(E, -1.5).setY(pos.y - 0.3);
  return { pos, target };
}

const _tp = new THREE.Vector3(), _tt = new THREE.Vector3();
function goPreset(p, instant = false) {
  if (!p) return;
  if (state.mode === 'walk') setMode('orbit');
  if (instant) {
    camera.position.copy(p.pos);
    orbit.target.copy(p.target);
    orbit.update();
    return;
  }
  state.tween = { p0: camera.position.clone(), t0: orbit.target.clone(), p1: p.pos, t1: p.target, t: 0, dur: 1.4 };
  orbit.enabled = false;
}

function updateTween(dt) {
  const tw = state.tween;
  if (!tw) return;
  tw.t = Math.min(1, tw.t + dt / tw.dur);
  const s = tw.t * tw.t * (3 - 2 * tw.t);
  _tp.lerpVectors(tw.p0, tw.p1, s);
  _tt.lerpVectors(tw.t0, tw.t1, s);
  camera.position.copy(_tp);
  orbit.target.copy(_tt);
  camera.lookAt(_tt);
  if (tw.t >= 1) { state.tween = null; orbit.enabled = state.mode !== 'walk'; orbit.update(); }
}

// ---------------------------------------------------------------- modes
const walk = new WalkController(camera, canvas, {
  walkable: state.walkable, walls: state.walls, heightfield, isTouch: IS_TOUCH,
  ui: { joy: $('joy'), knob: $('joyknob') },
});
// PointerLockControls logs a console.error when the browser refuses pointer lock; swap in a quiet handler.
walk.plc.disconnect();
walk.plc._onPointerlockError = () => { /* drag-look fallback handles it */ };
walk.plc.connect(canvas);
walk.plc.enabled = false;
const HINT_LOCKED = 'W A S D / arrows to move · Shift run · Esc to release the mouse';
const HINT_FREE = 'Click the view to look around · <b>W A S D</b> / arrows to move · <b>Shift</b> run';
walk.plc.addEventListener('lock', () => { $('walkhint').textContent = HINT_LOCKED; });
walk.plc.addEventListener('unlock', () => { if (state.mode === 'walk') $('walkhint').innerHTML = HINT_FREE; });

const _fwd = new THREE.Vector3();
function setMode(mode, birdKind) {
  if (state.mode === 'walk' && mode !== 'walk') {
    walk.disable();
    // keep looking where we were: orbit around a point 8 m ahead instead of snapping back to the pre-walk target
    camera.getWorldDirection(_fwd);
    orbit.target.copy(camera.position).addScaledVector(_fwd, 8);
    fitShadowCamera();   // back to the whole-site shadow box
  }
  state.tween = null;
  state.mode = mode;
  document.querySelectorAll('#topbar .mode').forEach((b) => b.setAttribute('aria-pressed', b.dataset.mode === mode ? 'true' : 'false'));
  $('birdsub').hidden = mode !== 'bird';
  $('walkui').hidden = mode !== 'walk';
  orbit.enabled = mode !== 'walk';
  orbit.enableRotate = mode !== 'bird';
  if (mode === 'walk') {
    if (!walk.enabled) enterWalk();
  } else if (mode === 'bird') {
    state.bird = birdKind || state.bird;
    document.querySelectorAll('#birdsub button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.bird === state.bird ? 'true' : 'false'));
    const p = state.presets.find((q) => q.bird === state.bird);
    if (p) goPreset(p);
  }
}

// is the ground point (x, z) inside a house footprint (with a margin so we never spawn in a wall)?
function insideHouse(x, z, margin = 0.5) {
  for (const h of state.houses.values()) {
    const b = h.box;
    if (x > b.min.x - margin && x < b.max.x + margin && z > b.min.z - margin && z < b.max.z + margin) return true;
  }
  return false;
}

function enterWalk(at, yaw) {
  // a focused control (e.g. the sun slider after a drag) would swallow the WASD keys
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  let pos, y;
  if (at) { pos = at.clone(); y = yaw || 0; }
  else {
    const t = orbit.target, c = state.focus.center;
    const camGround = walk.groundAt(camera.position.x, camera.position.z, camera.position.y + 0.5);
    const nearGround = camera.position.y - (camGround ?? state.focus.groundY) < 4;
    if (nearGround && !insideHouse(t.x, t.z)) {
      // already down at street level: drop in at the orbit target, looking the way the camera was looking
      _fwd.subVectors(t, camera.position); _fwd.y = 0;
      y = Math.atan2(-_fwd.x, -_fwd.z);
      pos = t.clone();
    } else if (v3(state.meta.walk_start)) {
      // from an aerial view the orbit target is usually inside a house: start at the site's walk_start, facing the centre
      pos = new THREE.Vector3().fromArray(state.meta.walk_start);
      y = Math.atan2(-(c.x - pos.x), -(c.z - pos.z));
    } else {
      _fwd.subVectors(t, camera.position); _fwd.y = 0;
      y = Math.atan2(-_fwd.x, -_fwd.z);
      pos = t.clone();
    }
  }
  const g = walk.groundAt(pos.x, pos.z, pos.y + 60);
  pos.y = (g !== null && g !== undefined ? g : state.focus.groundY) + 1.7;
  walk.enable(pos, y, 0);
  $('walkhint').innerHTML = HINT_FREE;
}

function walkTo(pos, yaw) {
  if (state.mode === 'walk') walk.disable();
  setMode('walk');           // enters at the orbit target…
  walk.disable();
  enterWalk(pos, yaw);       // …then re-enters at the requested spot
}

// ---------------------------------------------------------------- labels
const labelGroup = new THREE.Group();
scene.add(labelGroup);
let houseLabel = null;
function buildLabels() {
  const labels = Array.isArray(state.meta.plot_labels) ? state.meta.plot_labels : [];
  for (const l of labels) {
    if (!l || !v3(l.pos)) continue;
    const div = document.createElement('div');
    div.className = 'plotlabel';
    div.textContent = l.text || '';
    const o = new CSS2DObject(div);
    o.position.fromArray(l.pos);
    labelGroup.add(o);
  }
  const div = document.createElement('div');
  div.className = 'houselabel';
  houseLabel = new CSS2DObject(div);
  houseLabel.visible = false;
  scene.add(houseLabel);
}

// ---------------------------------------------------------------- picking → info card
const raycaster = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
let pdown = null;
canvas.addEventListener('pointerdown', (e) => {
  // take the focus off the sun slider / preset select so the walk keys reach the window listener
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  pdown = { x: e.clientX, y: e.clientY, t: performance.now() };
});
canvas.addEventListener('pointerup', (e) => {
  if (!pdown || state.mode === 'walk') { pdown = null; return; }
  const moved = Math.hypot(e.clientX - pdown.x, e.clientY - pdown.y);
  const dtms = performance.now() - pdown.t;
  pdown = null;
  if (moved > 6 || dtms > 500 || e.button !== 0) return;
  pick(e.clientX, e.clientY);
});

function isShown(o) {
  for (; o; o = o.parent) if (o.visible === false) return false;
  return true;
}

function pick(cx, cy) {
  const r = canvas.getBoundingClientRect();
  _ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(_ndc, camera);
  const hits = raycaster.intersectObjects(state.pickable, false);
  for (const h of hits) {
    if (!isShown(h.object)) continue;           // hidden roofs etc.
    let hid = houseIdOf(h.object, scene);
    if (!hid && h.object.isInstancedMesh && h.instanceId !== undefined) {
      const mem = h.object.userData.members && h.object.userData.members[h.instanceId];
      if (mem && mem.house) hid = { id: mem.house };
    }
    if (hid) { showHouse(hid.id); return; }
    break;                                       // first visible hit is not a house
  }
  hideInfo();
}

function houseInfo(id) {
  const metaHouses = Array.isArray(state.meta.houses) ? state.meta.houses : [];
  const mh = metaHouses.find((h) => h && (h.id === id || h.name === id));
  let plot = mh && mh.plot, no = mh && (mh.no ?? mh.number);
  const label = mh && mh.label;
  let m;
  if (plot === undefined) {
    if ((m = /^House_(\d+)_(\d+)$/.exec(id))) { plot = m[1]; no = m[2]; }
    else if ((m = /^House_(\d+)$/.exec(id))) { no = m[1]; }
    else if ((m = /^H(\d+)$/.exec(id))) { no = m[1]; plot = 'placeholder'; }
  }
  return {
    plot: plot === undefined ? 'Plot –' : (plot === 'placeholder' ? 'Placeholder scene' : `Plot ${plot}`),
    name: label || (no !== undefined ? `House ${no}` : id.replace(/^House_/, 'House ')),
  };
}

function showHouse(id) {
  const h = state.houses.get(id);
  if (!h) return;
  state.selected = id;
  const info = houseInfo(id);
  $('infoPlot').textContent = info.plot;
  $('infoName').textContent = info.name;
  $('info').hidden = false;
  $('hint').classList.add('hide');
  if (houseLabel) {
    houseLabel.element.textContent = info.name;
    h.box.getCenter(houseLabel.position);
    houseLabel.position.y = h.box.max.y + 0.6;
    houseLabel.visible = true;
  }
}
function hideInfo() {
  $('info').hidden = true;
  state.selected = null;
  if (houseLabel) houseLabel.visible = false;
}
$('infoClose').addEventListener('click', hideInfo);
$('infoWalk').addEventListener('click', () => {
  const h = state.selected && state.houses.get(state.selected);
  if (!h) return;
  const c = h.box.getCenter(new THREE.Vector3());
  // stand in front of the veranda (south side) facing the house
  const pos = c.clone().addScaledVector(state.north, -(h.box.getSize(_tp).length() * 0.5 + 3));
  const yaw = Math.atan2(-(c.x - pos.x), -(c.z - pos.z));
  hideInfo();
  walkTo(pos, yaw);
});

// ---------------------------------------------------------------- UI wiring
document.querySelectorAll('#topbar .mode').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
document.querySelectorAll('#birdsub button').forEach((b) => b.addEventListener('click', () => setMode('bird', b.dataset.bird)));
$('exitWalk').addEventListener('click', () => setMode('orbit'));
$('preset').addEventListener('change', (e) => {
  const p = state.presets[Number(e.target.value)];
  if (p) { if (state.mode !== 'orbit') setMode('orbit'); goPreset(p); }
  e.target.value = '';
  e.target.blur();
});
$('sun').addEventListener('input', (e) => { state.hour = Number(e.target.value); updateSun(); });
$('tRoof').addEventListener('click', (e) => {
  const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
  e.currentTarget.setAttribute('aria-pressed', on ? 'true' : 'false');
  for (const r of state.roofs) r.visible = on;
});
$('tLabels').addEventListener('click', (e) => {
  state.labelsVisible = e.currentTarget.getAttribute('aria-pressed') !== 'true';
  e.currentTarget.setAttribute('aria-pressed', state.labelsVisible ? 'true' : 'false');
  labelGroup.visible = state.labelsVisible;
});
$('tQuality').addEventListener('click', () => { state.quality = state.quality === 'high' ? 'low' : 'high'; applyQuality(); });
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('info').hidden) hideInfo(); });
setTimeout(() => $('hint').classList.add('hide'), 9000);

// ---------------------------------------------------------------- compass
const needle = $('needle');
const _cu = new THREE.Vector3(), _cf = new THREE.Vector3();
let lastCompass = 1e9;
function updateCompass() {
  _cu.set(0, 1, 0).applyQuaternion(camera.quaternion); _cu.y = 0;
  camera.getWorldDirection(_cf); _cf.y = 0;
  const up = _cu.lengthSq() > _cf.lengthSq() ? _cu : _cf; // screen-up direction on the ground plane
  if (up.lengthSq() < 1e-8) return;
  up.normalize();
  const N = state.north;
  const rx = -up.z, rz = up.x;                              // screen-right on the ground plane
  const ang = Math.atan2(N.x * rx + N.z * rz, N.x * up.x + N.z * up.z);
  if (Math.abs(ang - lastCompass) > 0.002) { lastCompass = ang; needle.style.transform = `rotate(${ang / DEG}deg)`; }
}

// ---------------------------------------------------------------- resize / loop
function resize() {
  const w = canvas.clientWidth || window.innerWidth, h = canvas.clientHeight || window.innerHeight;
  if (w < 2 || h < 2) return;             // hidden tab / collapsed pane: keep the last real size
  renderer.setSize(w, h, false);
  labelRenderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

function updatePointLights() {
  const n = state.lightsPos.length;
  if (state.mode !== 'walk' || n === 0) { for (const l of pointPool) l.visible = false; return; }
  lightUsed.fill(0);
  const cp = camera.position;
  for (let k = 0; k < pointPool.length; k++) {
    let best = -1, bd = 30 * 30;
    for (let i = 0; i < n; i++) {
      if (lightUsed[i]) continue;
      const d = state.lightsPos[i].distanceToSquared(cp);
      if (d < bd) { bd = d; best = i; }
    }
    const l = pointPool[k];
    if (best < 0) { l.visible = false; continue; }
    lightUsed[best] = 1;
    l.position.copy(state.lightsPos[best]);
    l.visible = true;
    l.intensity = 6;
  }
}

const timer = new THREE.Timer();
function tick(dt) {
  updateTween(dt);
  if (state.mode === 'walk') {
    walk.update(dt);
    fitShadowCamera(camera.position, WALK_SHADOW_R, WALK_SHADOW_D);   // tight shadow box around the walker
  } else if (orbit.enabled) orbit.update(dt);
  updatePointLights();
  updateCompass();
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
}
function frame() {
  requestAnimationFrame(frame);
  timer.update();
  tick(Math.min(0.05, timer.getDelta()));
}

boot().catch((err) => {
  console.error(err);
  $('loadmsg').textContent = 'Could not load the 3D scene (' + (err && err.message ? err.message : err) + ')';
});
frame();

// debug hook (used by the verification script; harmless in production)
window.__mv = { state, camera, orbit, walk, scene, renderer, sun, setMode, goPreset, showHouse, pick, updateSun, walkTo, tick, resize };
}
