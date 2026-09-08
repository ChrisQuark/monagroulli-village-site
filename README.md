# Monagroulli Log Village — web viewer

Static site (Netlify publishes this folder). three.js is vendored under `js/vendor/` — no CDN, no
external requests.

## Run locally

```
cd web
python3 -m http.server 8765
# open http://localhost:8765
```

ES modules need an http:// origin; opening `index.html` from `file://` will not work.

## Files

```
index.html            page (top bar, info card, compass, loading overlay, gallery, about)
css/style.css
js/app.js             viewer: renderer, environment, sun, modes, presets, picking, roof/labels/quality
js/walk.js            first-person controller (pointer lock / touch joystick, heightfield + raycast ground, wall collision)
js/sun.js             solar position (lat 34.7°, 15 June) → light direction, rotated by north_deg
js/heightfield.js     bilinear terrain lookup
js/gallery.js         renders grid + lightbox
js/vendor/            three.module.min.js + three.core.min.js (r185) and the addons used
                      (HDRLoader is r185's name for RGBELoader; OrbitControls, PointerLockControls, GLTFLoader, Sky, CSS2DRenderer)
scene/scene.glb       the real village (written by blender/build.py) — falls back to scene/placeholder_v1.glb
scene/heightfield.json {"origin":[x,z],"step":s,"cols":c,"rows":r,"z_offset":o,"data":[row-major]} (three.js x/z, y = data + z_offset)
scene/meta.json       optional, see below (a minimal one with north_deg = 112 is checked in)
hdri/sky.hdr          equirect HDRI; if missing a procedural sky is used (PMREM baked from three's Sky)
renders/index.json    ["file.jpg", …], [{"file":"…","caption":"…","thumb":"…"}] or, as tools/make_gallery.py writes it,
                      [{"src":"renders/…","thumb":"renders/…","caption":"…","w":…,"h":…}] — gallery hides itself when empty
```

## scene/meta.json (optional; all coordinates in three.js space: x = Blender X, y = Blender Z, z = −Blender Y)

```json
{
  "north_deg": 112,
  "presets": [ {"name": "Aerial", "pos": [x, y, z], "target": [x, y, z]}, {"name": "Plot 6 street", …}, {"name": "Pool", …},
               {"name": "Paddle court", …}, {"name": "Inside a house", …} ],
  "plot_labels": [ {"text": "Plot 1", "pos": [x, y, z]}, … ],
  "houses": [ {"id": "House_6_1", "plot": 6, "no": 1, "label": "House 1"}, … ],
  "walk_start": [x, y, z]
}
```

`walk_start` is where **Walk** drops you from an aerial view (facing the site centre). When the orbit camera is
already within 4 m of the ground and its target is not inside a house, Walk starts at the orbit target instead.

Without `meta.json` the presets are computed from the bounding box of the houses and the house id is
parsed from the object name (`House_<plot>_<n>` → plot / house number).

## Naming conventions the viewer relies on (object names in the GLB)

* House root: an object (group or mesh) named `House_…` — the click raycast walks up to the topmost such
  ancestor. The placeholder scene uses `H1_…` … `H5_…` (handled too).
* Roof toggle hides every object whose name contains `roof` (case-insensitive), including children.
* Walkable surfaces (first-person ground): names containing `Floor_`, `Deck_`, `Stair_` (but not `Stair_Soffit`),
  `Plinth_`, `terrain`, `ground`, `road`, `pavement`, `paving`, `gravel`, `path`, `lawn`, `grass`, `court`, `step`, `terrace`.
  Terrain-class meshes (`terrain*`, `Site_*`, `green_lawn`, `Green_paving`, `Court_*`) are not raycast when a real
  heightfield exists — their height comes from `heightfield.json` (the 139k-triangle terrain cost ~43 ms per probe).
* Collision: names containing `Wall_`, `glass`, `win`, `balustrade`, `rail`, `kitchen`, `island`, `bed<n>`, `sofa`,
  `wardrobe`, `stove`, `post`, `fence`, `retaining`.
* Glass: materials or objects whose name contains `glass` are made transparent (depthWrite off). Any other
  transmissive material (the pool `water`) has its transmission switched off in low quality.
* `leaf_*` materials are alpha-tested (0.5) rather than blended, so instanced trees sort and shadow correctly.
* `Light_*` / `*_Light_*` objects (court lights, the 14 lamps in every house): their positions feed a pool of
  4 warm point lights while walking. Only house meshes are click-pickable.

## Debug hooks

* `window.__mv` exposes `state, camera, orbit, walk, scene, renderer, sun, setMode, goPreset, showHouse, pick,
  updateSun, walkTo, tick(dt), resize` for scripted checks (`tick` runs one frame without requestAnimationFrame).
* `index.html?nowebgl` shows the "WebGL is not available" overlay.
* When the fallback `placeholder_v1.glb` is used (its materials were exported without textures) the viewer tints
  its materials by name (`PLACEHOLDER_PALETTE` in app.js); the real scene is never touched.

## Controls

* Orbit: drag rotate, wheel zoom, right-drag / two-finger pan. Click a house → info card.
* Bird's eye: top-down / 45° presets, wheel zoom, drag to pan.
* Walk: click the view to capture the mouse, WASD / arrows, Shift = run, Esc releases the mouse,
  "Exit walk" returns to orbit. Touch: left joystick moves, drag on the right half looks.
* Sun slider: 07:00–19:00 on 15 June; Roof / Labels / Quality toggles.

## Changelog

* v5 — walk mode: terrain height from the heightfield instead of raycasting the 139k-tri terrain (48 ms → ~1 ms per frame); starts at `meta.walk_start` from aerial views; house lamps light up; 25 m shadow box follows the walker; exit keeps the view direction; `Stair_Soffit` no longer walkable; WASD works after using the sun slider.
* v5 — mobile / low quality: 2K shadow map from the first frame, pool water transmission off (86 ms → 8 ms), half-res transmission buffer, `▾ About` link to reach the sections below the canvas, bird's-eye fits portrait screens, WebGL-1-only browsers get the error box instead of a stuck loader, HDR fetch times out to the procedural sky after 20 s.
* v5 — gallery accepts `tools/make_gallery.py`'s `{src, thumb, caption, w, h}` items; anisotropic filtering on all maps; alpha-tested leaves; environment / background brightness follow the time of day; instanced meshes are frustum-culled by bounding sphere; `/scene/*` now `max-age=0, must-revalidate` on Netlify.
