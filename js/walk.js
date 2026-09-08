// First-person walk controller: pointer lock + WASD on desktop, joystick + drag-look on touch.
// Eye height 1.7 m above whatever is below (heightfield + raycast against floors/decks/stairs/terrain),
// simple wall collision (ray 0.4 m ahead at chest height, with sliding).
import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';

const EYE = 1.7;
const WALK = 3.0, RUN = 6.0;
const PROBE = 0.4;

const _dir = new THREE.Vector3();
const _right = new THREE.Vector3();
const _move = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _down = new THREE.Vector3(0, -1, 0);
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _hits = [];

export class WalkController {
  constructor(camera, dom, opts) {
    this.camera = camera;
    this.dom = dom;
    this.walkable = opts.walkable || [];
    this.walls = opts.walls || [];
    this.heightfield = opts.heightfield || null;
    this.onExit = opts.onExit || (() => {});
    this.isTouch = !!opts.isTouch;
    this.enabled = false;
    this.keys = Object.create(null);
    this.joy = { x: 0, y: 0 };
    this.groundY = 0;
    this.ray = new THREE.Raycaster();
    this.ray.far = 60;

    this.plc = new PointerLockControls(camera, dom);
    this.plc.pointerSpeed = 0.9;
    this.plc.minPolarAngle = 0.1;
    this.plc.maxPolarAngle = Math.PI - 0.1;
    this.plc.enabled = false;

    this._onKey = this._onKey.bind(this);
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._drag = null; // fallback drag-look (touch or when pointer lock is refused)

    this.ui = opts.ui || {};
    if (this.ui.joy) this._bindJoystick(this.ui.joy, this.ui.knob);
  }

  /** teleport to `pos` (eye position) looking along `yaw` radians (0 = -z) */
  enable(pos, yaw = 0, pitch = 0) {
    this.enabled = true;
    this.plc.enabled = true;
    this.camera.position.copy(pos);
    _euler.set(pitch, yaw, 0);
    this.camera.quaternion.setFromEuler(_euler);
    this.groundY = pos.y - EYE;
    this.keys = Object.create(null);
    window.addEventListener('keydown', this._onKey);
    window.addEventListener('keyup', this._onKey);
    this.dom.addEventListener('pointerdown', this._onPointerDown);
    window.addEventListener('pointermove', this._onPointerMove);
    window.addEventListener('pointerup', this._onPointerUp);
    window.addEventListener('pointercancel', this._onPointerUp);
  }

  disable() {
    this.enabled = false;
    this.plc.enabled = false;
    if (this.plc.isLocked) this.plc.unlock();
    window.removeEventListener('keydown', this._onKey);
    window.removeEventListener('keyup', this._onKey);
    this.dom.removeEventListener('pointerdown', this._onPointerDown);
    window.removeEventListener('pointermove', this._onPointerMove);
    window.removeEventListener('pointerup', this._onPointerUp);
    window.removeEventListener('pointercancel', this._onPointerUp);
    this._drag = null;
    this.joy.x = this.joy.y = 0;
  }

  _onKey(e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
    const down = e.type === 'keydown';
    switch (e.code) {
      case 'KeyW': case 'ArrowUp': this.keys.f = down; break;
      case 'KeyS': case 'ArrowDown': this.keys.b = down; break;
      case 'KeyA': case 'ArrowLeft': this.keys.l = down; break;
      case 'KeyD': case 'ArrowRight': this.keys.r = down; break;
      case 'ShiftLeft': case 'ShiftRight': this.keys.run = down; break;
      default: return;
    }
    if (e.code.startsWith('Arrow')) e.preventDefault();
  }

  _onPointerDown(e) {
    if (!this.enabled) return;
    if (this.isTouch || e.pointerType === 'touch') {
      // right half of the screen = look
      if (e.clientX > window.innerWidth * 0.5) this._drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
      return;
    }
    if (!this.plc.isLocked) {
      // request the lock ourselves: requestPointerLock() returns a promise in current browsers and rejects
      // (WrongDocumentError / SecurityError) when the lock is refused, which try/catch cannot see.
      // PointerLockControls still picks the lock up through the document's pointerlockchange event.
      try {
        const r = this.dom.requestPointerLock && this.dom.requestPointerLock();
        if (r && typeof r.catch === 'function') r.catch(() => { /* refused → drag-look fallback below */ });
      } catch (_) { /* refused → drag-look fallback below */ }
      this._drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
    }
  }

  _onPointerMove(e) {
    const d = this._drag;
    if (!d || d.id !== e.pointerId || this.plc.isLocked) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    d.x = e.clientX; d.y = e.clientY;
    this.look(-dx * 0.0045, -dy * 0.0045);
  }

  _onPointerUp(e) {
    if (this._drag && this._drag.id === e.pointerId) this._drag = null;
  }

  /** rotate the view by yaw/pitch deltas (radians) */
  look(dyaw, dpitch) {
    _euler.setFromQuaternion(this.camera.quaternion);
    _euler.y += dyaw;
    _euler.x = Math.max(-1.45, Math.min(1.45, _euler.x + dpitch));
    this.camera.quaternion.setFromEuler(_euler);
  }

  _bindJoystick(base, knob) {
    const R = 40;
    let id = null, cx = 0, cy = 0;
    const set = (x, y) => {
      const len = Math.hypot(x, y);
      if (len > R) { x *= R / len; y *= R / len; }
      knob.style.transform = `translate(${x}px, ${y}px)`;
      this.joy.x = x / R; this.joy.y = -y / R;
    };
    base.addEventListener('pointerdown', (e) => {
      id = e.pointerId; const r = base.getBoundingClientRect();
      cx = r.left + r.width / 2; cy = r.top + r.height / 2;
      try { base.setPointerCapture(id); } catch (_) { /* synthetic / already-released pointer */ }
      set(e.clientX - cx, e.clientY - cy); e.preventDefault();
    });
    base.addEventListener('pointermove', (e) => { if (e.pointerId === id) set(e.clientX - cx, e.clientY - cy); });
    const end = (e) => { if (e.pointerId === id) { id = null; set(0, 0); } };
    base.addEventListener('pointerup', end);
    base.addEventListener('pointercancel', end);
  }

  /** ground height under (x, z): nearest walkable surface below eye+0.6, else heightfield, else null */
  groundAt(x, z, fromY) {
    _origin.set(x, fromY, z);
    this.ray.set(_origin, _down);
    _hits.length = 0;
    this.ray.intersectObjects(this.walkable, false, _hits);
    if (_hits.length) return _hits[0].point.y;
    if (this.heightfield && this.heightfield.ok) return this.heightfield.sample(x, z);
    return null;
  }

  _blocked(px, py, pz, dx, dz, len) {
    if (!this.walls.length) return false;
    _origin.set(px, py, pz);
    _dir.set(dx, 0, dz).normalize();
    this.ray.set(_origin, _dir);
    const far = this.ray.far;
    this.ray.far = PROBE + len;
    _hits.length = 0;
    this.ray.intersectObjects(this.walls, false, _hits);
    this.ray.far = far;
    return _hits.length > 0;
  }

  update(dt) {
    if (!this.enabled) return;
    const cam = this.camera;
    const k = this.keys;
    let fwd = (k.f ? 1 : 0) - (k.b ? 1 : 0) + this.joy.y;
    let side = (k.r ? 1 : 0) - (k.l ? 1 : 0) + this.joy.x;
    const mag = Math.hypot(fwd, side);
    if (mag > 1) { fwd /= mag; side /= mag; }
    const speed = (k.run ? RUN : WALK) * Math.min(1, mag || 0);

    if (speed > 0) {
      cam.getWorldDirection(_dir);
      _dir.y = 0;
      if (_dir.lengthSq() < 1e-6) _dir.set(0, 0, -1);
      _dir.normalize();
      _right.set(-_dir.z, 0, _dir.x); // right-hand side on the ground plane
      _move.copy(_dir).multiplyScalar(fwd).addScaledVector(_right, side).normalize().multiplyScalar(speed * dt);

      const chest = this.groundY + 1.0;
      const p = cam.position;
      const len = _move.length();
      if (!this._blocked(p.x, chest, p.z, _move.x, _move.z, len)) {
        p.x += _move.x; p.z += _move.z;
      } else if (Math.abs(_move.x) > 1e-6 && !this._blocked(p.x, chest, p.z, _move.x, 0, Math.abs(_move.x))) {
        p.x += _move.x;                 // slide along the wall
      } else if (Math.abs(_move.z) > 1e-6 && !this._blocked(p.x, chest, p.z, 0, _move.z, Math.abs(_move.z))) {
        p.z += _move.z;
      }
    }

    // ground follow (also when idle, so the first frame settles). The probe starts 1.2 m above the current
    // ground (enough for a stair riser) so walking under a stair flight does not pop you onto it.
    const p = cam.position;
    const g = this.groundAt(p.x, p.z, this.groundY + 1.2);
    if (g !== null && g !== undefined) this.groundY = g;
    const targetY = this.groundY + EYE;
    p.y += (targetY - p.y) * Math.min(1, dt * 12);
  }
}
