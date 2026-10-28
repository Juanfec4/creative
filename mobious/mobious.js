// A floating, self-rotating 3D Mobius strip rendered as layered ASCII.
//
// The band is a real solid: a rectangular cross-section swept around a loop while it turns through a half-twist.
//   P(u, v, w) = C(u) + HW v B(u) + TH w N(u),   C = (cos u, sin u, 0),  B = (cos(u/2) cos u, cos(u/2) sin u, sin(u/2)),
//   N = (sin(u/2) cos u, sin(u/2) sin u, -cos(u/2)),   u in [0, 2pi), v and w in [-1, 1].
// Its surface is four faces swept over u: the two wide faces (w = +-1) and the two narrow side faces (v = +-1).
// Each frame it is rotated, bobbed, projected in perspective and rasterised with a depth buffer. Shading is deferred:
// the raster pass stores (u, v) per pixel and the shader recomputes the exact position and normal from them, so the
// lighting is smooth even though the mesh is coarse. A cell compositor then gives every character cell a background
// colour and a character chosen by the layer that owns it.
//
// Layers, back to front: dust (drifting motes), glow (aura behind the strip), floor (pool of light below it),
// strip (the surface), edge (the bevelled rims, drawn with glyphs that follow the band direction).
const Mobious = (function () {
  'use strict';

  const { MT } = (typeof module !== 'undefined' && module.exports) ? require('./rng.js') : window.RNG;
  const PI = Math.PI;
  const TAU = 2 * PI;

  const FPS = 30;
  const MAXROWS = 130;

  // strip geometry: ring radius 1, ribbon half-width HW
  const HW = 0.40;                  // half-width of the band
  const TH = 0.15;                  // half-thickness: this is what makes it an extruded shape
  const NU = 300, NV = 12, NW = 3;  // mesh resolution along the loop, across the width, and through the thickness

  // camera
  const CAM_D = 4.2;                // distance to the object
  const FOCAL = 3.0;                // perspective scale (screen-height units per world unit at distance 1)
  const SCALE = 0.41;              // overall size on screen
  const FLOOR_Y = 0.40;             // y of the floor pool (screen units)

  const QL = 48;

  const RAMP = ' .\'`^",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$';
  const CIDX = {};
  for (let i = 0; i < RAMP.length; i++) CIDX[RAMP[i]] = i;

  // Layers: bg = strength of the background colour field, chars = draw characters, density = fraction of cells with a character
  const LAYERS = {
    dust:  { on: true },
    glow:  { on: true, bg: 0.35, chars: true, density: 0.10 },
    floor: { on: true, bg: 0.55, chars: true, density: 0.26 },
    strip: { on: true, bg: 0.55, chars: true, density: 1.00 },
    edge:  { on: true, bg: 0.60, chars: true, density: 1.00 },
  };
  const STRIP_FAM = ".:;+=xX#%@";
  const GLOW_FAM = ".'`,";
  const FLOOR_FAM = ".-~=";

  const OPTS = { speed: 1.0 };

  const prnd = new MT().initByArray([21]);

  function clip(x, a, b) { return x < a ? a : (x > b ? b : x); }
  function ss(a, b, x) { const t = clip((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
  function mix(a, b, k) { return a + (b - a) * k; }

  // ---------- geometry ----------

  let CW, CH, ROWS, COLS, W, H, GW, GH, SS = 1;
  let X, Y, HSC;

  // The four faces of the solid, each a grid over (u, other parameter). Every vertex stores its local (u, v, w).
  //   face 0: w = +1 (wide), 1: w = -1 (wide), 2: v = +1 (side), 3: v = -1 (side)
  function localPos(u, v, w, out) {
    const c = Math.cos(u), sn = Math.sin(u), a = Math.cos(u / 2), b = Math.sin(u / 2);
    out[0] = c + HW * v * a * c + TH * w * b * c;
    out[1] = sn + HW * v * a * sn + TH * w * b * sn;
    out[2] = HW * v * b - TH * w * a;
  }
  const FACES = [];
  (function buildFaces() {
    const tmp = [0, 0, 0];
    for (let f = 0; f < 4; f++) {
      const n2 = f < 2 ? NV : NW;
      const cnt = (NU + 1) * (n2 + 1);
      const face = { n2, x: new Float32Array(cnt), y: new Float32Array(cnt), z: new Float32Array(cnt),
        u: new Float32Array(cnt), v: new Float32Array(cnt), w: new Float32Array(cnt) };
      for (let i = 0; i <= NU; i++) {
        const u = TAU * i / NU;
        for (let j = 0; j <= n2; j++) {
          const t = -1 + 2 * j / n2;
          const v = f < 2 ? t : (f === 2 ? 1 : -1);
          const w = f < 2 ? (f === 0 ? 1 : -1) : t;
          localPos(u, v, w, tmp);
          const k = i * (n2 + 1) + j;
          face.x[k] = tmp[0]; face.y[k] = tmp[1]; face.z[k] = tmp[2];
          face.u[k] = u; face.v[k] = v; face.w[k] = w;
        }
      }
      FACES.push(face);
    }
  })();

  // dust motes
  const DUST = [];
  for (let i = 0; i < 90; i++) {
    DUST.push({ a: prnd.uniform(0, TAU), r: prnd.uniform(0.25, 0.95), y: prnd.uniform(-0.5, 0.5), z: prnd.uniform(0.3, 1.0),
      s: prnd.uniform(0.02, 0.07), ph: prnd.uniform(0, TAU), b: prnd.uniform(0.3, 1.0) });
  }

  function init(cw, ch, rows, aspect) {
    CW = cw; CH = ch;
    ROWS = rows - (rows % 8);
    SS = ROWS > 64 ? 1 : 2;
    COLS = Math.trunc(ROWS * ch * (aspect || 1.0) / cw);
    COLS = COLS - (COLS % 8);
    W = COLS * CW; H = ROWS * CH;
    GW = COLS * SS; GH = ROWS * SS;
    X = new Float32Array(GW * GH);
    Y = new Float32Array(GW * GH);
    for (let j = 0; j < GH; j++) {
      const yv = Math.fround(((j + 0.5) * (CH / SS) - H / 2) / H);
      for (let i = 0; i < GW; i++) {
        X[j * GW + i] = Math.fround(((i + 0.5) * (CW / SS) - W / 2) / H);
        Y[j * GW + i] = yv;
      }
    }
    HSC = new Float32Array(ROWS * COLS);
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const hh = (BigInt(r) * 73856093n) ^ (BigInt(c) * 19349663n) ^ 0x5bd1e995n;
        HSC[r * COLS + c] = Number(hh % 1009n) / 1009.0;
      }
    }
  }

  // ---------- motion ----------

  const M = { r: new Float64Array(9), tx: 0, ty: 0, tz: 0, hue: 0, bob: 0 };

  function mat(ax, ay, az) {                      // R = Ry(ay) * Rx(ax) * Rz(az)
    const cx = Math.cos(ax), sx = Math.sin(ax), cy = Math.cos(ay), sy = Math.sin(ay), cz = Math.cos(az), sz = Math.sin(az);
    // Rz
    const a00 = cz, a01 = -sz, a02 = 0, a10 = sz, a11 = cz, a12 = 0, a20 = 0, a21 = 0, a22 = 1;
    // Rx * Rz
    const b00 = a00, b01 = a01, b02 = a02;
    const b10 = cx * a10 - sx * a20, b11 = cx * a11 - sx * a21, b12 = cx * a12 - sx * a22;
    const b20 = sx * a10 + cx * a20, b21 = sx * a11 + cx * a21, b22 = sx * a12 + cx * a22;
    // Ry * (Rx * Rz)
    const r = M.r;
    r[0] = cy * b00 + sy * b20; r[1] = cy * b01 + sy * b21; r[2] = cy * b02 + sy * b22;
    r[3] = b10; r[4] = b11; r[5] = b12;
    r[6] = -sy * b00 + cy * b20; r[7] = -sy * b01 + cy * b21; r[8] = -sy * b02 + cy * b22;
  }

  function motion(t) {
    const s = t * OPTS.speed;
    // slow tumble on all three axes, plus a gentle float: bobbing up and down with a little sway
    const yaw = s * 0.42;
    const pitch = 0.32 + 0.60 * Math.sin(s * 0.27);
    const roll = s * 0.13 + 0.25 * Math.sin(s * 0.19);
    mat(pitch, yaw, roll);
    M.bob = Math.sin(t * 0.8);
    M.tx = 0.05 * Math.sin(t * 0.37 + 1.0);
    M.ty = 0.045 * M.bob + 0.012 * Math.sin(t * 1.9);       // y up, in world units
    M.tz = CAM_D + 0.18 * Math.sin(t * 0.5);
    M.hue = 0.04 * Math.sin(t * 0.2);
  }

  // ---------- raster ----------

  let zbuf, ubuf, vbuf, wbuf, fbuf;

  function raster() {
    const n = GW * GH;
    if (!zbuf || zbuf.length !== n) {
      zbuf = new Float32Array(n); ubuf = new Float32Array(n); vbuf = new Float32Array(n); wbuf = new Float32Array(n); fbuf = new Uint8Array(n);
    }
    zbuf.fill(1e9);
    const r = M.r;
    const half = GW * 0.5, halfy = GH * 0.5;
    for (let f = 0; f < 4; f++) {
      const F = FACES[f];
      const nv = (NU + 1) * (F.n2 + 1);
      const SX = new Float32Array(nv), SY = new Float32Array(nv), SZ = new Float32Array(nv);
      for (let k = 0; k < nv; k++) {
        const x = SCALE * F.x[k], y = SCALE * F.y[k], z = SCALE * F.z[k];
        const wx = r[0] * x + r[1] * y + r[2] * z + M.tx;
        const wy = r[3] * x + r[4] * y + r[5] * z + M.ty;
        const wz = r[6] * x + r[7] * y + r[8] * z + M.tz;
        const fo = FOCAL / wz;
        SX[k] = half + (wx * fo) * H / (CW / SS);
        SY[k] = halfy - (wy * fo) * H / (CH / SS);
        SZ[k] = wz;
      }
      for (let i = 0; i < NU; i++) {
        for (let j = 0; j < F.n2; j++) {
          const a = i * (F.n2 + 1) + j, b = (i + 1) * (F.n2 + 1) + j, c = a + 1, d = b + 1;
          tri(SX, SY, SZ, F, f, a, b, c);
          tri(SX, SY, SZ, F, f, b, d, c);
        }
      }
    }
  }

  function tri(SX, SY, SZ, F, f, a, b, c) {
    const ax = SX[a], ay = SY[a], bx = SX[b], by = SY[b], cx = SX[c], cy = SY[c];
    const minx = Math.max(0, Math.floor(Math.min(ax, bx, cx))), maxx = Math.min(GW - 1, Math.ceil(Math.max(ax, bx, cx)));
    const miny = Math.max(0, Math.floor(Math.min(ay, by, cy))), maxy = Math.min(GH - 1, Math.ceil(Math.max(ay, by, cy)));
    if (minx > maxx || miny > maxy) return;
    const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(den) < 1e-9) return;
    const id = 1 / den;
    for (let y = miny; y <= maxy; y++) {
      for (let x = minx; x <= maxx; x++) {
        const px = x + 0.5, py = y + 0.5;
        const l1 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) * id;
        const l2 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) * id;
        const l3 = 1 - l1 - l2;
        if (l1 < -0.001 || l2 < -0.001 || l3 < -0.001) continue;
        const z = l1 * SZ[a] + l2 * SZ[b] + l3 * SZ[c];
        const p = y * GW + x;
        if (z < zbuf[p]) {
          zbuf[p] = z;
          ubuf[p] = l1 * F.u[a] + l2 * F.u[b] + l3 * F.u[c];
          vbuf[p] = l1 * F.v[a] + l2 * F.v[b] + l3 * F.v[c];
          wbuf[p] = l1 * F.w[a] + l2 * F.w[b] + l3 * F.w[c];
          fbuf[p] = f;
        }
      }
    }
  }

  // ---------- shading ----------

  // lights (directions towards the light, y up, camera looks along +z so toward-camera is -z)
  const L1 = norm3(-0.5, 0.7, -0.6), L2 = norm3(0.7, -0.35, -0.4);
  function norm3(x, y, z) { const l = Math.hypot(x, y, z); return [x / l, y / l, z / l]; }

  let sR = 0, sG = 0, sB = 0, sE = 0, sTan = 0;

  function shadeSurface(u, v, w, face, t) {
    const r = M.r;
    const cu = Math.cos(u), su = Math.sin(u), ca = Math.cos(u / 2), sa = Math.sin(u / 2);
    // local frame: width direction B and thickness direction N (unit, orthogonal to each other and to the loop tangent)
    const Bx = ca * cu, By = ca * su, Bz = sa;
    const Nx0 = sa * cu, Ny0 = sa * su, Nz0 = -ca;
    const px = cu + HW * v * Bx + TH * w * Nx0, py = su + HW * v * By + TH * w * Ny0, pz = HW * v * Bz + TH * w * Nz0;
    // outward normal of whichever face this pixel is on
    let nx, ny, nz;
    if (face < 2) { const sg = face === 0 ? 1 : -1; nx = sg * Nx0; ny = sg * Ny0; nz = sg * Nz0; }
    else { const sg = face === 2 ? 1 : -1; nx = sg * Bx; ny = sg * By; nz = sg * Bz; }
    // to world
    const wnx = r[0] * nx + r[1] * ny + r[2] * nz, wny = r[3] * nx + r[4] * ny + r[5] * nz, wnz = r[6] * nx + r[7] * ny + r[8] * nz;
    const wx = SCALE * (r[0] * px + r[1] * py + r[2] * pz) + M.tx;
    const wy = SCALE * (r[3] * px + r[4] * py + r[5] * pz) + M.ty;
    const wz = SCALE * (r[6] * px + r[7] * py + r[8] * pz) + M.tz;
    const vl = Math.hypot(wx, wy, wz);
    const Vx = -wx / vl, Vy = -wy / vl, Vz = -wz / vl;
    const ndv = clip(wnx * Vx + wny * Vy + wnz * Vz, 0, 1);

    const wide = face < 2;
    const av = Math.abs(v), aw = Math.abs(w);
    const hs = M.hue;

    // colour: emerald through the middle of the wide faces, lime toward the rims; the side faces are a deeper green
    let br, bg, bb;
    if (wide) {
      const e = ss(0.20, 1.0, av);
      br = mix(0.03 + hs, 0.16, e); bg = mix(0.50, 0.68, e); bb = mix(0.26 - hs, 0.20, e);
    } else {
      const e = ss(0.0, 1.0, aw);
      br = mix(0.02, 0.08, e); bg = mix(0.26, 0.40, e); bb = mix(0.16, 0.14, e);
    }
    // a lighter lime band travelling around the loop (periodic in u, so it joins up across the twist)
    const band = 0.5 + 0.5 * Math.sin(2 * u + t * 0.6);
    br = mix(br, 0.28, 0.12 * band); bg = mix(bg, 0.78, 0.12 * band); bb = mix(bb, 0.28, 0.12 * band);
    // transverse ticks and a groove; both are symmetric, so they match up across the seam
    const tk = Math.abs(Math.sin(u * 18));
    const tick = 1 - 0.30 * ss(0.93, 1.0, tk);
    const groove = wide ? 1 - 0.28 * Math.exp(-Math.pow((av - 0.62) / 0.05, 2)) : 1;
    const k0 = tick * groove;
    br *= k0; bg *= k0; bb *= k0;
    if (wide) {                                                   // centre line on the wide faces
      const centre = Math.exp(-Math.pow(v / 0.045, 2));
      br = mix(br, 0.30, 0.30 * centre); bg = mix(bg, 0.72, 0.30 * centre); bb = mix(bb, 0.42, 0.30 * centre);
    }

    // lighting: a strong key light so each face gets a clearly different tone, which is what sells the thickness
    const d1 = Math.max(0, wnx * L1[0] + wny * L1[1] + wnz * L1[2]);
    const d2 = Math.max(0, wnx * L2[0] + wny * L2[1] + wnz * L2[2]);
    const Hx = L1[0] + Vx, Hy = L1[1] + Vy, Hz = L1[2] + Vz, hl = Math.hypot(Hx, Hy, Hz) || 1;
    const spec = Math.pow(Math.max(0, (wnx * Hx + wny * Hy + wnz * Hz) / hl), 40) * (wide ? 0.30 : 0.18);
    const rim = Math.pow(1 - ndv, 3) * 0.20;
    const lit = 0.20 + 0.95 * d1;
    let R_ = br * lit + 0.22 * d2 * 0.40 + spec * 0.85 + rim * 0.25;
    let G_ = bg * lit + 0.22 * d2 * 0.85 + spec + rim * 0.80;
    let B_ = bb * lit + 0.22 * d2 * 0.55 + spec * 0.85 + rim * 0.45;

    // bevelled edges where two faces meet: a bright line, so the extruded outline reads even edge-on
    const edge = wide ? ss(0.90, 0.985, av) : ss(0.86, 0.98, aw);
    R_ = mix(R_, 0.30, edge * 0.45); G_ = mix(G_, 0.78, edge * 0.45); B_ = mix(B_, 0.38, edge * 0.45);

    // screen-space direction of the band at this point, for edge glyphs
    const dux = -su + HW * v * (-0.5 * sa * cu - ca * su) + TH * w * (0.5 * ca * cu - sa * su);
    const duy = cu + HW * v * (-0.5 * sa * su + ca * cu) + TH * w * (0.5 * ca * su + sa * cu);
    const duz = HW * v * 0.5 * ca + TH * w * 0.5 * sa;
    const tx = r[0] * dux + r[1] * duy + r[2] * duz, ty = r[3] * dux + r[4] * duy + r[5] * duz;
    const ang = Math.atan2(ty, tx);
    const a2 = (ang * 180 / PI + 180) % 180;
    sTan = (a2 < 22.5 || a2 >= 157.5) ? 0 : (a2 < 67.5 ? 1 : (a2 < 112.5 ? 2 : 3));
    sR = R_; sG = G_; sB = B_; sE = edge;
  }

  // ---------- post ----------

  function bloom(img) {
    const out = Float32Array.from(img);
    const b = new Float32Array(img.length);
    for (let i = 0; i < img.length; i++) b[i] = Math.max(img[i] - 0.55, 0);
    for (const [f, w_] of [[2, 0.22], [4, 0.15], [8, 0.10]]) {
      const gh = GH / f, gw = GW / f;
      let s_ = new Float32Array(gh * gw * 3);
      const inv = 1 / (f * f);
      for (let y = 0; y < gh; y++) {
        for (let x = 0; x < gw; x++) {
          for (let ch = 0; ch < 3; ch++) {
            let acc = 0;
            for (let dy = 0; dy < f; dy++) {
              for (let dx = 0; dx < f; dx++) acc += b[((y * f + dy) * GW + (x * f + dx)) * 3 + ch];
            }
            s_[(y * gw + x) * 3 + ch] = acc * inv;
          }
        }
      }
      for (let pass = 0; pass < 2; pass++) {
        const n2 = new Float32Array(s_.length);
        for (let y = 0; y < gh; y++) {
          const yu = (y + gh - 1) % gh, yd = (y + 1) % gh;
          for (let x = 0; x < gw; x++) {
            const xl = (x + gw - 1) % gw, xr = (x + 1) % gw;
            for (let ch = 0; ch < 3; ch++) {
              n2[(y * gw + x) * 3 + ch] = (s_[(y * gw + x) * 3 + ch] * 2
                + s_[(yu * gw + x) * 3 + ch] + s_[(yd * gw + x) * 3 + ch]
                + s_[(y * gw + xl) * 3 + ch] + s_[(y * gw + xr) * 3 + ch]) / 6;
            }
          }
        }
        s_ = n2;
      }
      for (let y = 0; y < GH; y++) {
        for (let x = 0; x < GW; x++) {
          const sp_ = (((y / f) | 0) * gw + ((x / f) | 0)) * 3;
          const p = (y * GW + x) * 3;
          out[p] += w_ * s_[sp_]; out[p + 1] += w_ * s_[sp_ + 1]; out[p + 2] += w_ * s_[sp_ + 2];
        }
      }
    }
    return out;
  }

  // ---------- frame ----------

  const OWN = { none: 0, glow: 1, floor: 2, strip: 3, edge: 4 };
  const KEY = ['none', 'glow', 'floor', 'strip', 'edge'];
  const PRIO = [0, 1, 2, 3, 4];

  function renderCells(t) {
    motion(t);
    raster();

    // object centre on screen, for the glow
    const f0 = FOCAL / M.tz;
    const cx0 = M.tx * f0, cy0 = -M.ty * f0;
    const lift = 0.5 + 0.5 * M.bob;                       // 0 low .. 1 high

    const n = GW * GH;
    const img = new Float32Array(n * 3);
    const owner = new Uint8Array(n);
    const tcode = new Uint8Array(n);
    for (let j = 0; j < GH; j++) {
      for (let i = 0; i < GW; i++) {
        const p = j * GW + i;
        const x = X[p], y = Y[p];
        let r = 0, g = 0, b = 0, own = 0;

        // glow: aura behind the strip
        {
          const dx = x - cx0, dy = y - cy0;
          const g0 = 0.028 / (1 + (dx * dx + dy * dy) / 0.05);
          r += g0 * 0.25; g += g0 * 1.00; b += g0 * 0.55;
          if (g0 > 0.004) own = OWN.glow;
        }
        // floor: pool of light under the floating strip; smaller and brighter when the strip is low
        {
          const rx = 0.36 * (1 + 0.22 * lift), ry = 0.040 * (1 + 0.22 * lift);
          const dx = (x - cx0 * 0.6) / rx, dy = (y - FLOOR_Y) / ry;
          const f1 = Math.exp(-(dx * dx + dy * dy) * 1.6) * (0.075 - 0.030 * lift);
          r += f1 * 0.30; g += f1 * 1.00; b += f1 * 0.50;
          if (f1 > 0.006) own = OWN.floor;
        }

        if (zbuf[p] < 1e8) {
          shadeSurface(ubuf[p], vbuf[p], wbuf[p], fbuf[p], t);
          r = sR; g = sG; b = sB;
          own = sE > 0.6 ? OWN.edge : OWN.strip;
          tcode[p] = sTan;
        }
        img[p * 3] = r; img[p * 3 + 1] = g; img[p * 3 + 2] = b;
        owner[p] = own;
      }
    }

    const bl = bloom(img);
    for (let i = 0; i < bl.length; i++) bl[i] = 1 - Math.exp(-1.4 * Math.max(bl[i], 0));

    const idx = new Int32Array(ROWS * COLS);
    const fg = new Float32Array(ROWS * COLS * 3);
    const bg = new Float32Array(ROWS * COLS * 3);
    const ownCell = new Uint8Array(ROWS * COLS);
    const inv = 1 / (SS * SS);
    const pick = (fam, v) => fam[Math.trunc(clip(v, 0, 0.999) * fam.length)];
    const TANCH = ['-', '/', '|', '\\'];

    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        let R_ = 0, G_ = 0, B_ = 0, best = 0, bestP = -1, tc = 0;
        for (let a = 0; a < SS; a++) {
          for (let b = 0; b < SS; b++) {
            const pp = (r * SS + a) * GW + (c * SS + b);
            R_ += bl[pp * 3]; G_ += bl[pp * 3 + 1]; B_ += bl[pp * 3 + 2];
            const o = owner[pp];
            if (o && PRIO[o] > bestP) { bestP = PRIO[o]; best = o; tc = tcode[pp]; }
          }
        }
        R_ *= inv; G_ *= inv; B_ *= inv;
        const cell = r * COLS + c;
        ownCell[cell] = best;
        if (!best) continue;
        const key = KEY[best];
        const L = LAYERS[key];
        if (!L.on) continue;
        const lum = 0.30 * R_ + 0.60 * G_ + 0.10 * B_;
        const l = Math.pow(clip(lum, 0, 1), 0.75);
        const hs = HSC[cell];
        bg[cell * 3] = clip(R_ * L.bg, 0, 1); bg[cell * 3 + 1] = clip(G_ * L.bg, 0, 1); bg[cell * 3 + 2] = clip(B_ * L.bg, 0, 1);

        let ch = '', gain = 1.45, add = 0.05;
        if (L.chars) {
          if (key === 'strip') {
            if (hs < L.density) ch = pick(STRIP_FAM, l * 1.05 + (hs - 0.5) * 0.10);
          } else if (key === 'edge') {
            ch = TANCH[tc]; gain = 1.6; add = 0.12;                    // glyph follows the ribbon direction
          } else if (key === 'floor') {
            if (hs < L.density * clip(l * 3, 0, 1)) ch = pick(FLOOR_FAM, hs * 5.7 % 1);
            gain = 1.7; add = 0.0;
          } else {
            if (hs < L.density * clip((l - 0.02) / 0.25, 0, 1)) ch = pick(GLOW_FAM, hs * 7.3 % 1);
            gain = 1.7; add = 0.0;
          }
        }
        if (ch) {
          idx[cell] = CIDX[ch];
          fg[cell * 3] = clip(R_ * gain + add, 0, 1); fg[cell * 3 + 1] = clip(G_ * gain + add, 0, 1); fg[cell * 3 + 2] = clip(B_ * gain + add, 0, 1);
        }
      }
    }

    if (LAYERS.dust.on) stampDust(idx, fg, ownCell, t, cx0, cy0);

    const q = new Int16Array(ROWS * COLS * 3);
    const bq = new Int16Array(ROWS * COLS * 3);
    for (let i = 0; i < q.length; i++) {
      q[i] = clip(Math.trunc(clip(fg[i], 0, 1) * (QL - 0.01)), 0, QL - 1);
      bq[i] = clip(Math.trunc(clip(bg[i], 0, 1) * (QL - 1) + 0.5 * HSC[(i / 3) | 0]), 0, QL - 1);
    }
    return { idx, q, bq };
  }

  // drifting motes that slowly orbit the strip, with a little parallax
  function stampDust(idx, fg, own, t, cx0, cy0) {
    for (const d of DUST) {
      const a = d.a + t * d.s;
      const x = cx0 + Math.cos(a) * d.r * 0.9 * d.z;
      const y = cy0 + d.y * 0.9 + 0.04 * Math.sin(t * 0.6 + d.ph);
      const c = Math.trunc((W / 2 + x * H) / CW), r = Math.trunc((H / 2 + y * H) / CH);
      if (c < 0 || c >= COLS || r < 0 || r >= ROWS) continue;
      const p = r * COLS + c;
      if (own[p] === OWN.strip || own[p] === OWN.edge) continue;
      const tw = 0.55 + 0.45 * Math.sin(t * 1.7 + d.ph);
      const a2 = d.b * d.z * tw;
      idx[p] = CIDX[a2 > 0.55 ? '+' : (a2 > 0.3 ? '.' : '`')];
      fg[p * 3] = clip(0.45 * a2, 0, 1); fg[p * 3 + 1] = clip(1.0 * a2, 0, 1); fg[p * 3 + 2] = clip(0.60 * a2, 0, 1);
    }
  }

  const api = {
    init, renderCells, layers: LAYERS, options: OPTS, RAMP, QL, FPS, MAXROWS,
    dims: () => ({ CW, CH, ROWS, COLS, W, H }),
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
