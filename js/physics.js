/**
 * physics.js
 * Lightweight AABB physics: a uniform spatial grid of static colliders,
 * ray casting (slab test + grid traversal), box movement with per-axis
 * resolution and sliding, and overlap queries for triggers.
 *
 * Everything is axis-aligned boxes — sufficient for an architectural
 * environment and fast enough to avoid allocations in the hot loop.
 */
import * as THREE from 'three';

export const Material = {
  CONCRETE: 'concrete',
  METAL: 'metal',
  WOOD: 'wood',
  GLASS: 'glass',
  SOIL: 'soil',
  FABRIC: 'fabric',
  GRAVEL: 'gravel',
};

const CELL = 8; // grid cell size in metres
const BIG_SPAN = 40; // colliders touching more cells than this go in the "big" list

let _nextId = 1;

export class Collider {
  constructor(min, max, material, opts = {}) {
    this.id = _nextId++;
    this.min = min.clone();
    this.max = max.clone();
    this.material = material || Material.CONCRETE;
    this.enabled = true;
    this.breakable = !!opts.breakable;   // glass panes etc.
    this.tag = opts.tag || 'static';     // 'static' | 'door' | 'glass' | 'prop' ...
    this.entity = opts.entity || null;   // optional back-reference (Door, prop…)
    this.cells = null;                   // filled by PhysicsWorld
    this.big = false;
  }
}

export class PhysicsWorld {
  constructor() {
    this.colliders = [];
    this.bigColliders = [];
    this.grid = new Map(); // "cx,cz" -> Collider[]
    // scratch objects reused across calls (no GC churn in the loop)
    this._ray = { hit: null };
  }

  clear() {
    this.colliders.length = 0;
    this.bigColliders.length = 0;
    this.grid.clear();
  }

  _key(cx, cz) { return cx * 73856093 ^ cz * 19349663; }

  add(min, max, material, opts) {
    const c = new Collider(min, max, material, opts);
    this.colliders.push(c);

    const cx0 = Math.floor(c.min.x / CELL), cx1 = Math.floor(c.max.x / CELL);
    const cz0 = Math.floor(c.min.z / CELL), cz1 = Math.floor(c.max.z / CELL);
    const span = (cx1 - cx0 + 1) * (cz1 - cz0 + 1);

    if (span > BIG_SPAN) {
      // Very large colliders (ground slabs, long walls) are always tested.
      c.big = true;
      this.bigColliders.push(c);
      return c;
    }

    c.cells = [];
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const k = this._key(cx, cz);
        let arr = this.grid.get(k);
        if (!arr) { arr = []; this.grid.set(k, arr); }
        arr.push(c);
        c.cells.push(k);
      }
    }
    return c;
  }

  /** Convenience: add a box from centre + size. */
  addBox(center, size, material, opts) {
    const hs = size.clone().multiplyScalar(0.5);
    return this.add(center.clone().sub(hs), center.clone().add(hs), material, opts);
  }

  remove(c) {
    const i = this.colliders.indexOf(c);
    if (i >= 0) this.colliders.splice(i, 1);
    if (c.big) {
      const j = this.bigColliders.indexOf(c);
      if (j >= 0) this.bigColliders.splice(j, 1);
    } else if (c.cells) {
      for (const k of c.cells) {
        const arr = this.grid.get(k);
        if (arr) {
          const idx = arr.indexOf(c);
          if (idx >= 0) arr.splice(idx, 1);
        }
      }
    }
  }

  /** Gather candidate colliders overlapping a world-space AABB. */
  queryAABB(min, max, out) {
    out.length = 0;
    const seen = this._seen || (this._seen = new Set());
    seen.clear();
    for (const c of this.bigColliders) {
      if (c.enabled && !seen.has(c.id)) { seen.add(c.id); out.push(c); }
    }
    const cx0 = Math.floor(min.x / CELL), cx1 = Math.floor(max.x / CELL);
    const cz0 = Math.floor(min.z / CELL), cz1 = Math.floor(max.z / CELL);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const arr = this.grid.get(this._key(cx, cz));
        if (!arr) continue;
        for (const c of arr) {
          if (!c.enabled || seen.has(c.id)) continue;
          if (c.max.x < min.x || c.min.x > max.x) continue;
          if (c.max.z < min.z || c.min.z > max.z) continue;
          if (c.max.y < min.y || c.min.y > max.y) continue;
          seen.add(c.id);
          out.push(c);
        }
      }
    }
    return out;
  }

  /**
   * Amanatides–Woo style grid walk collecting candidates along a ray,
   * then exact slab tests. Returns the nearest hit:
   * { dist, point, normal, collider } or null.
   */
  raycast(origin, dir, maxDist, opts = {}) {
    const ignore = opts.ignore || null; // Set of collider ids, or predicate(collider)
    let best = null;
    let bestDist = maxDist;

    const test = (c) => {
      if (!c.enabled) return;
      if (ignore) {
        if (typeof ignore === 'function') { if (ignore(c)) return; }
        else if (ignore.has(c.id)) return;
      }
      const d = rayAABB(origin, dir, c.min, c.max, bestDist);
      if (d !== null && d < bestDist) {
        bestDist = d;
        if (!best) best = { dist: 0, point: new THREE.Vector3(), normal: new THREE.Vector3(), collider: null };
        best.dist = d;
        best.collider = c;
        best.point.copy(origin).addScaledVector(dir, d);
        hitNormal(origin, dir, c, best.point, best.normal);
      }
    };

    const seen = this._raySeen || (this._raySeen = new Set());
    seen.clear();

    for (const c of this.bigColliders) {
      seen.add(c.id);
      test(c);
    }

    // Walk grid cells along the ray (XZ plane; Y handled by exact tests).
    let cx = Math.floor(origin.x / CELL);
    let cz = Math.floor(origin.z / CELL);
    const stepX = dir.x > 0 ? 1 : -1;
    const stepZ = dir.z > 0 ? 1 : -1;
    const tDeltaX = dir.x !== 0 ? Math.abs(CELL / dir.x) : Infinity;
    const tDeltaZ = dir.z !== 0 ? Math.abs(CELL / dir.z) : Infinity;
    let tMaxX = dir.x !== 0
      ? ((stepX > 0 ? (cx + 1) * CELL - origin.x : origin.x - cx * CELL) / Math.abs(dir.x))
      : Infinity;
    let tMaxZ = dir.z !== 0
      ? ((stepZ > 0 ? (cz + 1) * CELL - origin.z : origin.z - cz * CELL) / Math.abs(dir.z))
      : Infinity;

    let t = 0;
    let guard = 0;
    while (t <= bestDist && guard++ < 512) {
      const arr = this.grid.get(this._key(cx, cz));
      if (arr) {
        for (const c of arr) {
          if (seen.has(c.id)) continue;
          seen.add(c.id);
          test(c);
        }
      }
      if (tMaxX < tMaxZ) { t = tMaxX; tMaxX += tDeltaX; cx += stepX; }
      else { t = tMaxZ; tMaxZ += tDeltaZ; cz += stepZ; }
    }

    return best;
  }

  /** Quick boolean line-of-sight test. */
  hasLOS(a, b, ignore) {
    const delta = _losVec.copy(b).sub(a);
    const dist = delta.length();
    if (dist < 0.001) return true;
    delta.divideScalar(dist);
    const hit = this.raycast(a, delta, dist, { ignore });
    return hit === null;
  }

  /**
   * Move an AABB by (dx,dy,dz) resolving collisions per-axis so the box
   * slides along surfaces. Mutates box.min / box.max in place.
   * stepHeight: if > 0 (and the mover is grounded), low obstructions such as
   * stair treads are stepped onto instead of blocking movement.
   * Returns { onGround, hitX, hitZ, hitCeil, steppedUp, groundCollider }.
   */
  moveBox(box, dx, dy, dz, out, stepHeight = 0) {
    out.onGround = false; out.hitX = false; out.hitZ = false; out.hitCeil = false;
    out.steppedUp = false;
    out.groundCollider = null;

    const list = this._moveList || (this._moveList = []);
    const EPS = 0.001;

    // --- X axis ---
    if (dx !== 0) {
      box.min.x += dx; box.max.x += dx;
      this.queryAABB(box.min, box.max, list);
      for (const c of list) {
        if (c.max.x <= box.min.x || c.min.x >= box.max.x) continue;
        if (c.max.y <= box.min.y + EPS || c.min.y >= box.max.y - EPS) continue;
        if (c.max.z <= box.min.z + EPS || c.min.z >= box.max.z - EPS) continue;
        if (stepHeight > 0) {
          const rise = c.max.y - box.min.y;
          if (rise > EPS && rise <= stepHeight) {
            const h = box.max.y - box.min.y;
            box.min.y = c.max.y + EPS; box.max.y = box.min.y + h;
            out.steppedUp = true;
            continue;
          }
        }
        if (dx > 0) { const w = box.max.x - box.min.x; box.max.x = c.min.x - EPS; box.min.x = box.max.x - w; }
        else { const w = box.max.x - box.min.x; box.min.x = c.max.x + EPS; box.max.x = box.min.x + w; }
        out.hitX = true;
      }
    }

    // --- Z axis ---
    if (dz !== 0) {
      box.min.z += dz; box.max.z += dz;
      this.queryAABB(box.min, box.max, list);
      for (const c of list) {
        if (c.max.z <= box.min.z || c.min.z >= box.max.z) continue;
        if (c.max.y <= box.min.y + EPS || c.min.y >= box.max.y - EPS) continue;
        if (c.max.x <= box.min.x + EPS || c.min.x >= box.max.x - EPS) continue;
        if (stepHeight > 0) {
          const rise = c.max.y - box.min.y;
          if (rise > EPS && rise <= stepHeight) {
            const h = box.max.y - box.min.y;
            box.min.y = c.max.y + EPS; box.max.y = box.min.y + h;
            out.steppedUp = true;
            continue;
          }
        }
        const w = box.max.z - box.min.z;
        if (dz > 0) { box.max.z = c.min.z - EPS; box.min.z = box.max.z - w; }
        else { box.min.z = c.max.z + EPS; box.max.z = box.min.z + w; }
        out.hitZ = true;
      }
    }

    // --- Y axis ---
    // Penetration allowances: a collider only counts as floor/ceiling if the
    // penetration depth is consistent with this frame's motion. A box that is
    // deeply embedded (e.g. spawned inside a pillar) must NOT be launched to
    // the top of the obstacle — the depenetration pass handles that case.
    const fallAllow = dy < 0 ? -dy + 0.15 : 0.15;
    const riseAllow = dy > 0 ? dy + 0.15 : 0.15;
    if (dy !== 0) {
      box.min.y += dy; box.max.y += dy;
      this.queryAABB(box.min, box.max, list);
      for (const c of list) {
        if (c.max.y <= box.min.y || c.min.y >= box.max.y) continue;
        if (c.max.x <= box.min.x + EPS || c.min.x >= box.max.x - EPS) continue;
        if (c.max.z <= box.min.z + EPS || c.min.z >= box.max.z - EPS) continue;
        const h = box.max.y - box.min.y;
        if (dy > 0) {
          if (c.min.y < box.max.y - riseAllow) continue; // deep embed, not a ceiling
          box.max.y = c.min.y - EPS; box.min.y = box.max.y - h; out.hitCeil = true;
        } else {
          if (c.max.y > box.min.y + fallAllow) continue; // deep embed, not a floor
          box.min.y = c.max.y + EPS; box.max.y = box.min.y + h;
          out.onGround = true; out.groundCollider = c;
        }
      }
    } else {
      // standing still vertically — probe just below the feet for ground state
      const probeMin = _probeMin.set(box.min.x, box.min.y - 0.06, box.min.z);
      const probeMax = _probeMax.set(box.max.x, box.min.y + 0.01, box.max.z);
      this.queryAABB(probeMin, probeMax, list);
      for (const c of list) {
        if (c.max.y <= box.min.y - 0.06 || c.min.y >= box.max.y) continue;
        if (c.max.x <= box.min.x + EPS || c.min.x >= box.max.x - EPS) continue;
        if (c.max.z <= box.min.z + EPS || c.min.z >= box.max.z - EPS) continue;
        if (Math.abs(c.max.y - box.min.y) < 0.07) { out.onGround = true; out.groundCollider = c; break; }
      }
    }

    // --- horizontal depenetration (spawned-inside / squeeze cases) ---
    this.queryAABB(box.min, box.max, list);
    for (const c of list) {
      const ox = Math.min(box.max.x - c.min.x, c.max.x - box.min.x);
      const oy = Math.min(box.max.y - c.min.y, c.max.y - box.min.y);
      const oz = Math.min(box.max.z - c.min.z, c.max.z - box.min.z);
      if (ox <= EPS || oy <= EPS || oz <= EPS) continue; // no real overlap
      if (ox <= oz) {
        const w = box.max.x - box.min.x;
        const cx = box.min.x + box.max.x, ccx = c.min.x + c.max.x;
        if (cx < ccx) { box.max.x = c.min.x - EPS; box.min.x = box.max.x - w; }
        else { box.min.x = c.max.x + EPS; box.max.x = box.min.x + w; }
      } else {
        const w = box.max.z - box.min.z;
        const cz = box.min.z + box.max.z, ccz = c.min.z + c.max.z;
        if (cz < ccz) { box.max.z = c.min.z - EPS; box.min.z = box.max.z - w; }
        else { box.min.z = c.max.z + EPS; box.max.z = box.min.z + w; }
      }
    }

    return out;
  }
}

// ---------------------------------------------------------------
// Ray / AABB helpers
// ---------------------------------------------------------------

/** Slab test. Returns entry distance within [0, maxDist] or null. */
export function rayAABB(origin, dir, min, max, maxDist) {
  let tmin = 0;
  let tmax = maxDist;

  for (let i = 0; i < 3; i++) {
    const o = i === 0 ? origin.x : i === 1 ? origin.y : origin.z;
    const d = i === 0 ? dir.x : i === 1 ? dir.y : dir.z;
    const lo = i === 0 ? min.x : i === 1 ? min.y : min.z;
    const hi = i === 0 ? max.x : i === 1 ? max.y : max.z;

    if (Math.abs(d) < 1e-8) {
      if (o < lo || o > hi) return null;
    } else {
      let t1 = (lo - o) / d;
      let t2 = (hi - o) / d;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
  }
  return tmin;
}

/** Determine which face was entered to get a proper normal. */
function hitNormal(origin, dir, c, point, normal) {
  const EPS = 0.005;
  normal.set(0, 1, 0);
  if (Math.abs(point.x - c.min.x) < EPS && dir.x > 0) normal.set(-1, 0, 0);
  else if (Math.abs(point.x - c.max.x) < EPS && dir.x < 0) normal.set(1, 0, 0);
  else if (Math.abs(point.y - c.min.y) < EPS && dir.y > 0) normal.set(0, -1, 0);
  else if (Math.abs(point.y - c.max.y) < EPS && dir.y < 0) normal.set(0, 1, 0);
  else if (Math.abs(point.z - c.min.z) < EPS && dir.z > 0) normal.set(0, 0, -1);
  else if (Math.abs(point.z - c.max.z) < EPS && dir.z < 0) normal.set(0, 0, 1);
  return normal;
}

/** Ray vs oriented-ish test against an entity AABB with local hit info (used for hit zones). */
export function rayAABBLocal(origin, dir, min, max, maxDist, outLocal) {
  const d = rayAABB(origin, dir, min, max, maxDist);
  if (d === null) return null;
  if (outLocal) {
    outLocal.x = origin.x + dir.x * d;
    outLocal.y = origin.y + dir.y * d - min.y;   // height above the entity's feet
    outLocal.z = origin.z + dir.z * d;
    outLocal.dist = d;
  }
  return d;
}

const _losVec = new THREE.Vector3();
const _probeMin = new THREE.Vector3();
const _probeMax = new THREE.Vector3();
