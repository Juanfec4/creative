// A wild horse galloping at the center of the frame while the world streams past it.
// The horse never moves: an articulated skeleton (2-bone IK legs on a transverse-gallop cycle) is
// rasterised from capsules/ellipses into a supersampled coverage+tone buffer, then each cell becomes a
// character. The world scrolls toward the horse in perspective (near rows faster than far rows).
// Dry plain -> shoreline -> water. The water is a real 2D damped wave-equation grid that scrolls with the
// camera, so every hoof strike leaves a wake behind the horse. Procedural, no image files.
const WildHorse = (function () {
  'use strict';

  const FPS = 30;
  const SUB = 2;                       // wave-sim substeps per rendered frame
  const DT = 1 / (FPS * SUB);

  // ---- world / camera -------------------------------------------------------------------------------------
  const HOR = -0.05;                   // horizon y (screen-height units, 0 = center, +y down)
  const GROUND = 0.27;                 // y of the hoof line, where perspective scale s = 1
  const T_GAIT = 0.52;                 // seconds per stride
  const STANCE = 0.26;                 // fraction of the stride each foot is on the ground
  const SWEEP = 0.22;                  // how far a planted foot travels back relative to the body
  const V = SWEEP / (STANCE * T_GAIT); // ground speed that keeps planted hooves from sliding
  const LOOP = 44;                     // seconds before land/water pattern repeats
  const P = V * LOOP;
  const W1 = 0.30 * P, W2 = 0.70 * P;  // water spans world X in [W1, W2] (mod P)
  const SUNX = 0.60, SUNY = HOR - 0.24;

  // ---- wave sim grid (camera-aligned: u across, z = depth) -------------------------------------------------
  const DU = 0.025, UHALF = 3.2, NX = Math.round(2 * UHALF / DU) + 1;
  const ZMIN = 0.45, DZ = 0.04, NZ = 102, ZMAX = ZMIN + (NZ - 1) * DZ;
  const CPHYS = 1.0;
  const CX2 = (CPHYS * DT / DU) ** 2, CZ2 = (CPHYS * DT / DZ) ** 2;
  const GAMMA = 0.010;

  const clamp = (x, a, b) => x < a ? a : x > b ? b : x;
  const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const lerp = (a, b, t) => a + (b - a) * t;

  function hash(x, y) {
    let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  function vnoise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
    const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
    const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  const ridge = (x, s) => 0.5 * vnoise(x * 1.3, s) + 0.3 * vnoise(x * 3.1, s + 7) + 0.2 * vnoise(x * 7.7, s + 3);

  // small seeded rng for particles (deterministic when re-simulating)
  let seed = 1;
  const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

  // ---- palettes -------------------------------------------------------------------------------------------
  const C = [0, 0, 0];
  function grad(stops, t) {
    t = clamp(t, 0, 1);
    let i = 0;
    while (i < stops.length - 2 && t > stops[i + 1][0]) i++;
    const a = stops[i], b = stops[i + 1], k = clamp((t - a[0]) / (b[0] - a[0]), 0, 1);
    C[0] = a[1] + (b[1] - a[1]) * k; C[1] = a[2] + (b[2] - a[2]) * k; C[2] = a[3] + (b[3] - a[3]) * k;
  }
  const SKY = [[0, 2, 3, 8], [0.45, 8, 9, 20], [0.75, 20, 22, 38], [0.92, 42, 40, 58], [1, 74, 66, 80]];
  const ARMOR_PAL = [[0, 8, 10, 18], [0.4, 38, 52, 82], [0.75, 92, 112, 152], [1, 168, 190, 232]];
  const TRIM_PAL = [[0, 18, 12, 6], [0.5, 110, 78, 34], [1, 205, 158, 66]];
  const CAPE_PAL = [[0, 22, 4, 6], [0.4, 110, 16, 20], [0.75, 190, 34, 36], [1, 245, 90, 64]];
  const PALS = [null, ARMOR_PAL, CAPE_PAL, TRIM_PAL];
  const HORSE_PAL = [[0, 28, 26, 34], [0.35, 118, 112, 124], [0.65, 200, 196, 204], [1, 255, 250, 245]];

  const pick = (s, v) => s[clamp(Math.floor(v * s.length), 0, s.length - 1)];
  const SKY_CH = " .'`,:;";
  const HILL_CH = " .:;+";
  const PEBBLE = ".,:'`;-~^\"";
  const TUFT_CH = "\"^'!i|";
  const WAVE_CH = " .,-~=+*";
  const FOAM_CH = "+*#%@";
  const FLAME_CH = ".:'^~*+(){}%&8#@";
  const FLAME_PAL = [[0, 36, 3, 0], [0.18, 158, 23, 3], [0.40, 255, 87, 8], [0.62, 255, 158, 26], [0.82, 255, 219, 82], [1, 255, 245, 178]];
  const RIDER_CH = [null, "ilTxXHNMBW", "vwVWmM", "oOQ"];   // letters: armour is a ladder of light to heavy capitals, cape is w/v/m, trim is round o/O/Q
  const HORSE_CH = " .:-=+*#%@";

  // ---- dims -----------------------------------------------------------------------------------------------
  let CW, CH, COLS, ROWS, ASPECT, N, CPU;
  let SXs = 2, SYs = 4, SXN, SYN, KX, KY, OX, OY, PXU;
  let sxArr, syArr, rowS, rowZ;
  let chOut, fgOut, bgOut;
  let covBuf, toneBuf, kindBuf, sa, st, sk;

  function init(cw, chh, cols, rows) {
    CW = cw; CH = chh; COLS = cols; ROWS = rows; N = COLS * ROWS;
    ASPECT = COLS * CW / (ROWS * CH);
    CPU = ROWS * CH / CW;                // cells per screen-height unit, horizontally
    sxArr = new Float32Array(COLS); syArr = new Float32Array(ROWS);
    for (let c = 0; c < COLS; c++) sxArr[c] = (c + 0.5 - COLS / 2) * CW / (ROWS * CH);
    for (let r = 0; r < ROWS; r++) syArr[r] = (r + 0.5) / ROWS - 0.5;
    rowS = new Float32Array(ROWS); rowZ = new Float32Array(ROWS);
    for (let r = 0; r < ROWS; r++) { rowS[r] = Math.max(0.02, (syArr[r] - HOR) / (GROUND - HOR)); rowZ[r] = 1 / rowS[r]; }
    chOut = new Uint8Array(N); fgOut = new Uint8ClampedArray(N * 3); bgOut = new Uint8ClampedArray(N * 3);
    covBuf = new Float32Array(N); toneBuf = new Float32Array(N); kindBuf = new Uint8Array(N);
    SXN = COLS * SXs; SYN = ROWS * SYs;
    KX = SXs * ROWS * CH / CW; KY = SYs * ROWS; OX = COLS / 2 * SXs; OY = ROWS / 2 * SYs; PXU = 1 / KY;
    sa = new Float32Array(SXN * SYN); st = new Float32Array(SXN * SYN); sk = new Uint8Array(SXN * SYN);
    resetSim();
  }

  // ---- terrain mask ---------------------------------------------------------------------------------------
  // positive = distance (world units) inside the water, negative = on land
  function waterD(X, z) {
    const m = ((X % P) + P) % P;
    const wob = 0.5 * Math.sin(z * 1.1 + 0.5) + 0.35 * Math.sin(z * 2.9 + 1.7) + 0.2 * Math.sin(z * 6.1);
    return Math.min(m - (W1 + wob), (W2 - wob * 0.8) - m);
  }

  // ---- gait -----------------------------------------------------------------------------------------------
  const LEGS = [
    { hind: true,  near: false, ph: 0.00 },   // left hind
    { hind: true,  near: true,  ph: 0.10 },   // right hind
    { hind: false, near: false, ph: 0.32 },   // left fore
    { hind: false, near: true,  ph: 0.42 },   // right fore
  ];
  const gaitP = (t) => { const p = t / T_GAIT; return p - Math.floor(p); };

  // foot offset (x relative to the joint's rest x), lift above ground, stance flag, swing fraction
  const FS = { stance: false, off: 0, lift: 0, w: 0 };
  function legState(leg, p) {
    let u = p - leg.ph; u -= Math.floor(u);
    const cx = leg.hind ? -0.01 : 0.06;
    if (u < STANCE) {
      const w = u / STANCE;
      FS.stance = true; FS.w = w;
      FS.off = SWEEP * (0.5 - w) + cx;
      FS.lift = 0.012 * Math.pow(Math.abs(2 * w - 1), 4);
    } else {
      const w = (u - STANCE) / (1 - STANCE), e = w * w * (3 - 2 * w);
      FS.stance = false; FS.w = w;
      FS.off = -SWEEP / 2 + SWEEP * e + cx;
      FS.lift = (leg.hind ? 0.045 : 0.055) * Math.pow(Math.sin(Math.PI * w), 0.75);
    }
    return FS;
  }

  // ---- wave sim -------------------------------------------------------------------------------------------
  let hA, hB, gxF, gzF, spongeU, spongeZ;
  let simT = 0, shiftAcc = 0, prevStance = [false, false, false, false];
  const MAXP = 600;
  let pX, pY, pVX, pVY, pLife, pLife0, pKind, pGY, pN;
  const MAXM = 80;
  let mX = new Float32Array(MAXM), mGY = new Float32Array(MAXM), mSeed = new Float32Array(MAXM), mN = 0;   // hoof prints: world X, ground y

  function resetSim() {
    hA = new Float32Array(NX * NZ); hB = new Float32Array(NX * NZ);
    gxF = new Float32Array(NX * NZ); gzF = new Float32Array(NX * NZ);
    spongeU = new Float32Array(NX); spongeZ = new Float32Array(NZ);
    for (let i = 0; i < NX; i++) spongeU[i] = 1 - 0.12 * Math.pow(Math.max(0, 1 - Math.min(i, NX - 1 - i) / 14), 2);
    for (let j = 0; j < NZ; j++) spongeZ[j] = 1 - 0.12 * Math.pow(Math.max(0, 1 - Math.min(j, NZ - 1 - j) / 8), 2);
    simT = 0; shiftAcc = 0; seed = 1; mN = 0; prevStance = [false, false, false, false];
    pX = new Float32Array(MAXP); pY = new Float32Array(MAXP); pVX = new Float32Array(MAXP); pVY = new Float32Array(MAXP);
    pLife = new Float32Array(MAXP); pLife0 = new Float32Array(MAXP); pKind = new Uint8Array(MAXP); pGY = new Float32Array(MAXP); pN = 0;
  }

  function bump(u, z, amp, rad) {
    const ci = (u + UHALF) / DU, cj = (z - ZMIN) / DZ;
    const ri = rad / DU, rj = rad / DZ;
    for (let j = Math.max(1, Math.floor(cj - rj * 2)); j <= Math.min(NZ - 2, Math.ceil(cj + rj * 2)); j++) {
      for (let i = Math.max(1, Math.floor(ci - ri * 2)); i <= Math.min(NX - 2, Math.ceil(ci + ri * 2)); i++) {
        const d2 = ((i - ci) / ri) ** 2 + ((j - cj) / rj) ** 2;
        const v = amp * Math.exp(-d2);
        hA[j * NX + i] += v; hB[j * NX + i] += v;     // displacement only, no initial velocity
      }
    }
  }

  function spawn(kind, x, gy, vx, vy, life) {
    if (pN >= MAXP) return;
    const k = pN++;
    pX[k] = x; pY[k] = gy; pVX[k] = vx; pVY[k] = vy; pLife[k] = pLife0[k] = life; pKind[k] = kind; pGY[k] = kind >= 2 ? GROUND : gy;
  }

  function stepSim() {
    simT += DT;
    const t = simT, p = gaitP(t), camX = V * t;

    // hoof contacts
    for (let i = 0; i < 4; i++) {
      const leg = LEGS[i];
      const st0 = legState(leg, p);
      const stance = st0.stance;
      const gy = GROUND + (leg.near ? 0.014 : -0.014);
      const s = Math.max(0.05, (gy - HOR) / (GROUND - HOR)), z = 1 / s;
      const restX = leg.hind ? -0.12 : 0.10;
      const fx = restX + st0.off;
      const u = fx / s, X = camX + u;
      const d = waterD(X, z);
      const inWater = d > 0.05;
      if (stance && !prevStance[i]) {                 // strike
        if (inWater) {
          bump(u, z, -0.030, 0.09);
          for (let k = 0; k < 9; k++) spawn(0, fx, gy, (rnd() - 0.65) * 0.5, -(0.45 + rnd() * 0.7), 0.5 + rnd() * 0.35);
        } else {
          for (let k = 0; k < 5; k++) spawn(1, fx, gy, (rnd() - 0.7) * 0.25, -(0.05 + rnd() * 0.18), 0.5 + rnd() * 0.5);
          if (d < -0.4 && mN < MAXM) { mX[mN] = X; mGY[mN] = gy; mSeed[mN] = rnd() * 100; mN++; }   // leave a hoof print
        }
      } else if (!stance && prevStance[i]) {          // lift-off
        if (inWater) {
          bump(u, z, 0.018, 0.08);
          for (let k = 0; k < 5; k++) spawn(0, fx, gy, -(rnd() * 0.5), -(0.3 + rnd() * 0.6), 0.4 + rnd() * 0.3);
        } else {
          for (let k = 0; k < 3; k++) spawn(1, fx, gy, -(rnd() * 0.3), -(0.05 + rnd() * 0.12), 0.4 + rnd() * 0.4);
        }
      } else if (stance && inWater) {
        bump(u, z, -0.0004, 0.07);
      }
      prevStance[i] = stance;
    }

    // wave equation
    for (let j = 1; j < NZ - 1; j++) {
      const row = j * NX, sz = spongeZ[j];
      for (let i = 1; i < NX - 1; i++) {
        const k = row + i, h = hA[k];
        const lapU = hA[k - 1] + hA[k + 1] - 2 * h, lapZ = hA[k - NX] + hA[k + NX] - 2 * h;
        hB[k] = (h + (h - hB[k]) * (1 - GAMMA) + CX2 * lapU + CZ2 * lapZ) * spongeU[i] * sz;
      }
    }
    let tmp = hA; hA = hB; hB = tmp;

    // scroll with the camera (world moves left)
    shiftAcc += V * DT / DU;
    while (shiftAcc >= 1) {
      shiftAcc -= 1;
      for (let j = 0; j < NZ; j++) {
        hA.copyWithin(j * NX, j * NX + 1, (j + 1) * NX); hA[j * NX + NX - 1] = 0;
        hB.copyWithin(j * NX, j * NX + 1, (j + 1) * NX); hB[j * NX + NX - 1] = 0;
      }
    }

    // forget prints that have scrolled off the left edge
    for (let k = 0; k < mN; k++) {
      const sm = Math.max(0.05, (mGY[k] - HOR) / (GROUND - HOR));
      if ((mX[k] - camX) * sm < -1.4) { mN--; mX[k] = mX[mN]; mGY[k] = mGY[mN]; mSeed[k] = mSeed[mN]; k--; }
    }

    // particles
    for (let k = 0; k < pN; k++) {
      pLife[k] -= DT;
      const s = Math.max(0.05, (pGY[k] - HOR) / (GROUND - HOR));
      pX[k] += (pVX[k] - V * s) * DT;
      pY[k] += pVY[k] * DT;
      if (pKind[k] === 0) pVY[k] += 3.2 * DT; else pVY[k] -= 0.1 * DT;
      if (pLife[k] <= 0 || (pKind[k] === 0 && pY[k] > pGY[k])) {
        pN--;
        pX[k] = pX[pN]; pY[k] = pY[pN]; pVX[k] = pVX[pN]; pVY[k] = pVY[pN]; pLife[k] = pLife[pN]; pLife0[k] = pLife0[pN]; pKind[k] = pKind[pN]; pGY[k] = pGY[pN];
        k--;
      }
    }
  }

  function updateGrad() {
    for (let j = 1; j < NZ - 1; j++) for (let i = 1; i < NX - 1; i++) {
      const k = j * NX + i;
      gxF[k] = (hA[k + 1] - hA[k - 1]) / (2 * DU);
      gzF[k] = (hA[k + NX] - hA[k - NX]) / (2 * DZ);
    }
  }

  // ---- horse rasteriser -----------------------------------------------------------------------------------
  const LX = 0.84, LY = -0.54;   // light comes from the front, slightly above
  let bx0, bx1, by0, by1;

  function capsule(ax, ay, r0, bx, by, r1, tone, gain, kind = 0) {
    const abx = bx - ax, aby = by - ay, l2 = abx * abx + aby * aby || 1e-9;
    const rmax = Math.max(r0, r1) + PXU;
    const i0 = Math.max(0, Math.floor(OX + (Math.min(ax, bx) - rmax) * KX)), i1 = Math.min(SXN - 1, Math.ceil(OX + (Math.max(ax, bx) + rmax) * KX));
    const j0 = Math.max(0, Math.floor(OY + (Math.min(ay, by) - rmax) * KY)), j1 = Math.min(SYN - 1, Math.ceil(OY + (Math.max(ay, by) + rmax) * KY));
    for (let j = j0; j <= j1; j++) {
      const py = (j + 0.5 - OY) / KY;
      for (let i = i0; i <= i1; i++) {
        const px = (i + 0.5 - OX) / KX;
        const t = clamp(((px - ax) * abx + (py - ay) * aby) / l2, 0, 1);
        const dx = px - (ax + abx * t), dy = py - (ay + aby * t);
        const len = Math.sqrt(dx * dx + dy * dy);
        let a = 0.5 - (len - (r0 + (r1 - r0) * t)) / PXU;
        if (a <= 0) continue;
        if (a > 1) a = 1;
        const lit = len > 1e-9 ? Math.max(0, (dx * LX + dy * LY) / len) : 0;
        const k = j * SXN + i;
        st[k] = st[k] * (1 - a) + (tone + gain * lit) * a;
        sa[k] = sa[k] + a * (1 - sa[k]);
        if (a > 0.5) sk[k] = kind;
      }
    }
  }

  function ellipse(cx, cy, rx, ry, ang, tone, gain, kind = 0) {
    const ca = Math.cos(ang), sn = Math.sin(ang), rmax = Math.max(rx, ry) + PXU, rmin = Math.min(rx, ry);
    const i0 = Math.max(0, Math.floor(OX + (cx - rmax) * KX)), i1 = Math.min(SXN - 1, Math.ceil(OX + (cx + rmax) * KX));
    const j0 = Math.max(0, Math.floor(OY + (cy - rmax) * KY)), j1 = Math.min(SYN - 1, Math.ceil(OY + (cy + rmax) * KY));
    for (let j = j0; j <= j1; j++) {
      const py = (j + 0.5 - OY) / KY;
      for (let i = i0; i <= i1; i++) {
        const px = (i + 0.5 - OX) / KX;
        const dx = px - cx, dy = py - cy;
        const lx = dx * ca + dy * sn, ly = -dx * sn + dy * ca;
        const q = Math.sqrt((lx / rx) ** 2 + (ly / ry) ** 2);
        let a = 0.5 - (q - 1) * rmin / PXU;
        if (a <= 0) continue;
        if (a > 1) a = 1;
        // normal = gradient of the implicit ellipse, rotated back to screen space
        const nx = lx / (rx * rx), ny = ly / (ry * ry), nl = Math.sqrt(nx * nx + ny * ny) || 1;
        const sx = (nx * ca - ny * sn) / nl, sy = (nx * sn + ny * ca) / nl;
        const lit = Math.max(0, sx * LX + sy * LY) * Math.min(1, q + 0.15);
        const k = j * SXN + i;
        st[k] = st[k] * (1 - a) + (tone + gain * lit) * a;
        sa[k] = sa[k] + a * (1 - sa[k]);
        if (a > 0.5) sk[k] = kind;
      }
    }
  }

  function twoBone(hx, hy, tx, ty, L1, L2, bend, out) {
    const dx = tx - hx, dy = ty - hy, d = Math.sqrt(dx * dx + dy * dy) || 1e-6;
    const dd = clamp(d, Math.abs(L1 - L2) + 1e-4, L1 + L2 - 1e-4);
    const a = (L1 * L1 - L2 * L2 + dd * dd) / (2 * dd), h = Math.sqrt(Math.max(0, L1 * L1 - a * a));
    const ux = dx / d, uy = dy / d;
    out[0] = hx + ux * a - uy * bend * h; out[1] = hy + uy * a + ux * bend * h;   // joint
    out[2] = hx + ux * dd; out[3] = hy + uy * dd;                                 // foot (fetlock)
  }

  function strand(x, y, ang, len, segs, r0, r1, flutter, ph, tone, gain, kind = 0) {
    let px = x, py = y;
    for (let s = 0; s < segs; s++) {
      const f = (s + 1) / segs;
      ang += flutter * Math.sin(ph - s * 0.9) * f * 0.35;
      const nx = px + Math.cos(ang) * len / segs, ny = py + Math.sin(ang) * len / segs;
      capsule(px, py, lerp(r0, r1, s / segs), nx, ny, lerp(r0, r1, f), tone, gain, kind);
      px = nx; py = ny;
    }
  }

  const J = [0, 0, 0, 0];
  let torchX = 0, torchY = 0;

  function drawHorse(t) {
    const p = gaitP(t), ph = t * 11;
    sa.fill(0); st.fill(0); sk.fill(0);

    // body motion: highest in the flight phase, rocking nose-down as the forelegs land
    const bob = -0.020 * Math.cos(2 * Math.PI * (p - 0.87));
    const pitch = 0.06 * Math.sin(2 * Math.PI * (p - 0.62));
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const BX = 0, BY = -0.015 + bob;
    const R = (x, y) => [BX + x * cp - y * sp, BY + x * sp + y * cp];

    const [shx, shy] = R(0.10, 0.03), [hpx, hpy] = R(-0.12, 0.02);

    const leg = (i) => {
      const L = LEGS[i], s = legState(L, p);
      const jx = L.hind ? hpx : shx, jy = L.hind ? hpy : shy;
      const gy = GROUND + (L.near ? 0.014 : -0.014);
      const restX = L.hind ? -0.12 : 0.10;
      const footX = restX + s.off + (L.near ? 0.012 : -0.01);
      const L1 = L.hind ? 0.135 : 0.120, L2 = L.hind ? 0.125 : 0.140;
      twoBone(jx, jy, footX, gy - 0.029 - s.lift, L1, L2, L.hind ? 1 : -1, J);
      const th = s.stance ? 0.45 : 0.45 - 0.9 * Math.sin(Math.PI * s.w);
      const tx = J[2] + 0.034 * Math.sin(th), ty = J[3] + 0.034 * Math.cos(th);
      const base = L.near ? 0.50 : 0.26, g = L.near ? 0.45 : 0.28;
      if (L.hind) {
        capsule(jx, jy, 0.046, J[0], J[1], 0.024, base, g);
        capsule(J[0], J[1], 0.020, J[2], J[3], 0.012, base, g);
      } else {
        capsule(jx, jy, 0.034, J[0], J[1], 0.020, base, g);
        capsule(J[0], J[1], 0.018, J[2], J[3], 0.011, base, g);
      }
      capsule(J[2], J[3], 0.012, tx, ty, 0.016, base - 0.06, g);
    };

    // tail
    const [tbx, tby] = R(-0.20, -0.05);
    for (let i = 0; i < 6; i++) {
      strand(tbx, tby + i * 0.004, Math.PI - 0.30 + i * 0.05, 0.22 + 0.02 * i, 7, 0.011, 0.003, 1.0, ph + i * 0.7, 0.42, 0.45);
    }

    leg(0); leg(2);                                               // far side

    // torso
    const [rx, ry] = R(-0.12, -0.005), [cx, cy] = R(0.10, 0.0);
    capsule(rx, ry, 0.078, cx, cy, 0.088, 0.40, 0.55);
    const [bxx, byy] = R(-0.01, 0.03);
    ellipse(bxx, byy, 0.12, 0.062, pitch, 0.42, 0.48);
    // haunch and shoulder mass
    const [hmx, hmy] = R(-0.12, 0.03);
    ellipse(hmx, hmy, 0.062, 0.075, pitch, 0.46, 0.48);
    const [smx, smy] = R(0.10, 0.02);
    ellipse(smx, smy, 0.055, 0.068, pitch, 0.46, 0.48);

    // neck + head
    const nod = 0.08 * Math.sin(2 * Math.PI * (p - 0.2));
    const [nbx, nby] = R(0.12, -0.045);
    const na = -0.95 + nod + pitch;                                // neck angle (up-forward)
    const nlen = 0.19;
    const pollx = nbx + Math.cos(na) * nlen, polly = nby + Math.sin(na) * nlen;
    capsule(nbx, nby, 0.058, pollx, polly, 0.032, 0.44, 0.55);
    const ha = 0.50 - nod * 0.8;                                  // head tilt (down-forward)
    const mzx = pollx + Math.cos(ha) * 0.12, mzy = polly + Math.sin(ha) * 0.12;
    capsule(pollx, polly, 0.033, mzx, mzy, 0.020, 0.46, 0.60);
    ellipse(pollx + Math.cos(ha) * 0.03 - 0.004, polly + Math.sin(ha) * 0.03 + 0.022, 0.038, 0.028, ha, 0.44, 0.55);
    capsule(mzx, mzy, 0.022, mzx + Math.cos(ha) * 0.010, mzy + Math.sin(ha) * 0.010, 0.024, 0.48, 0.60);
    // ears (back, as the horse runs)
    capsule(pollx - 0.010, polly - 0.020, 0.011, pollx - 0.030, polly - 0.066, 0.003, 0.45, 0.55);
    capsule(pollx + 0.004, polly - 0.022, 0.011, pollx - 0.012, polly - 0.068, 0.003, 0.40, 0.55);
    // eye
    ellipse(pollx + Math.cos(ha) * 0.055 + 0.004, polly + Math.sin(ha) * 0.055 - 0.014, 0.005, 0.005, 0, 0.05, 0);

    // mane, streaming back off the crest
    for (let i = 0; i < 8; i++) {
      const f = i / 7;
      const mx = lerp(nbx, pollx, f) + Math.sin(na) * 0.045, my = lerp(nby, polly, f) - Math.cos(na) * 0.045;
      strand(mx, my, Math.PI - 0.15 - f * 0.1, 0.08 + 0.03 * (1 - f), 4, 0.007, 0.002, 1.3, ph * 1.2 + i * 0.6, 0.60, 0.40);
    }

    leg(1); leg(3);                                               // near side

    // knight in the saddle, leaning forward, torch held high in the front hand
    const lean = 0.008 * Math.sin(2 * Math.PI * (p - 0.3));
    const [kh0, kh1] = R(-0.01, -0.082);                          // hip on the saddle
    // the upper body is only loosely coupled to the horse: it rotates about the hip by a fraction of the horse's pitch
    const cpk = Math.cos(pitch * 0.25), spk = Math.sin(pitch * 0.25);
    const [ks0, ks1] = [kh0 + (0.04 + lean) * cpk + 0.108 * spk, kh1 + (0.04 + lean) * spk - 0.108 * cpk];   // shoulders
    for (let i = 0; i < 6; i++) {                                 // red cloak streaming back from the shoulders
      strand(ks0 - 0.01, ks1 + 0.006 + i * 0.012, Math.PI - 0.05 + i * 0.07, 0.16 + 0.015 * i, 5, 0.018, 0.006, 0.7, ph * 0.9 + i * 0.8, 0.55, 0.35, 2);
    }
    const ta = Math.atan2(ks1 - kh1, ks0 - kh0) + Math.PI / 2;      // direction across the torso
    const at = (f) => [lerp(kh0, ks0, f), lerp(kh1, ks1, f)];       // point along the spine, 0 = hip, 1 = shoulders
    // sword on the far hip, hanging along the flank
    const [sw0, sw1] = R(-0.03, -0.07), [sw2, sw3] = R(-0.15, 0.03);
    capsule(sw0, sw1, 0.008, sw2, sw3, 0.005, 0.14, 0.1, 1);
    capsule(sw0 + 0.004, sw1 - 0.002, 0.007, sw0 + 0.018, sw1 - 0.016, 0.005, 0.60, 0.2, 3);     // hilt and pommel
    // cuirass: dark plate with a bright ridge down the front and a belt with a buckle
    capsule(kh0, kh1, 0.038, ks0, ks1, 0.046, 0.30, 0.40, 1);
    const [r0a, r0b] = at(0.28), [r1a, r1b] = at(0.86);
    capsule(r0a + 0.016, r0b, 0.006, r1a + 0.018, r1b, 0.005, 0.62, 0.20, 1);
    const [bl0, bl1] = at(0.16);
    ellipse(bl0, bl1, 0.042, 0.009, ta, 0.20, 0.15, 3);
    ellipse(bl0 + 0.014, bl1, 0.010, 0.009, ta, 0.68, 0.20, 3);
    const [gg0, gg1] = at(0.97);
    ellipse(gg0 + 0.008, gg1 - 0.008, 0.026, 0.013, ta, 0.36, 0.30, 1);                          // gorget
    ellipse(ks0 - 0.002, ks1 - 0.004, 0.026, 0.020, ta + 0.2, 0.46, 0.35, 1);                    // pauldron
    capsule(ks0 - 0.016, ks1 + 0.010, 0.006, ks0 - 0.008, ks1 + 0.020, 0.006, 0.66, 0.1, 3);     // cloak clasp
    // legs: tasset, thigh plate, knee cop, greave, boot
    const [kk0, kk1] = R(0.045, -0.03), [kf0, kf1] = R(-0.005, 0.045), [kt0, kt1] = R(0.028, -0.052);
    capsule(kh0, kh1, 0.032, kk0, kk1, 0.024, 0.28, 0.35, 1);
    capsule(kh0, kh1 + 0.006, 0.034, kt0, kt1, 0.026, 0.34, 0.38, 1);
    ellipse(kk0, kk1, 0.021, 0.019, 0, 0.52, 0.35, 1);
    capsule(kk0, kk1, 0.021, kf0, kf1, 0.015, 0.28, 0.35, 1);
    ellipse(kf0 + 0.008, kf1 + 0.004, 0.022, 0.011, 0.15, 0.20, 0.25, 1);
    // helm: rounded skull, darker visor with an eye slit, chin guard and a fixed ridge (nothing flaps)
    const hx0 = ks0 + 0.010, hy0 = ks1 - 0.046;
    ellipse(hx0, hy0, 0.028, 0.032, 0, 0.42, 0.45, 1);
    ellipse(hx0 + 0.013, hy0 + 0.006, 0.016, 0.019, 0, 0.22, 0.30, 1);
    capsule(hx0 + 0.005, hy0 - 0.004, 0.0045, hx0 + 0.028, hy0 - 0.002, 0.004, 0.05, 0.0, 1);
    capsule(hx0 + 0.006, hy0 + 0.014, 0.012, hx0 + 0.020, hy0 + 0.020, 0.010, 0.30, 0.30, 1);
    capsule(hx0 - 0.020, hy0 - 0.022, 0.005, hx0 + 0.010, hy0 - 0.036, 0.004, 0.58, 0.15, 3);
    // arm: pauldron to elbow cop to gauntlet
    const ex = ks0 + 0.014 + lean, ey = ks1 + 0.066;               // upper arm hangs down along the body
    const hdx = ex + 0.074, hdy = ey - 0.046;                      // forearm bent forward and up, holding the torch at chest height
    capsule(ks0, ks1 + 0.01, 0.022, ex, ey, 0.018, 0.30, 0.38, 1);
    capsule(ex, ey, 0.018, hdx, hdy, 0.014, 0.28, 0.38, 1);
    ellipse(ex, ey, 0.016, 0.015, 0, 0.52, 0.30, 1);
    ellipse(hdx, hdy, 0.013, 0.012, 0, 0.40, 0.30, 1);
    torchX = hdx + 0.008; torchY = hdy - 0.042;                   // flame base
    capsule(hdx, hdy + 0.010, 0.008, torchX, torchY, 0.007, 0.45, 0.2, 3);   // torch haft

    // reduce to cells
    covBuf.fill(0); toneBuf.fill(0); kindBuf.fill(0);
    const c0 = Math.max(0, Math.floor(COLS / 2 + (-0.78) * KX / SXs)), c1 = Math.min(COLS - 1, Math.ceil(COLS / 2 + 0.62 * KX / SXs));
    const r0 = Math.max(0, Math.floor(ROWS / 2 + (-0.36) * ROWS)), r1 = Math.min(ROWS - 1, Math.ceil(ROWS / 2 + 0.36 * ROWS));
    bx0 = c0; bx1 = c1; by0 = r0; by1 = r1;
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      let a = 0, tn = 0, k1 = 0, k2 = 0, k3 = 0;
      for (let sj = 0; sj < SYs; sj++) {
        const row = (r * SYs + sj) * SXN + c * SXs;
        for (let si = 0; si < SXs; si++) {
          a += sa[row + si]; tn += st[row + si];
          if (sa[row + si] > 0.4) { if (sk[row + si] === 1) k1++; else if (sk[row + si] === 2) k2++; else if (sk[row + si] === 3) k3++; }
        }
      }
      if (a > 0) { covBuf[r * COLS + c] = a / (SXs * SYs); toneBuf[r * COLS + c] = tn / a; kindBuf[r * COLS + c] = k3 > 1 && k3 >= k1 && k3 >= k2 ? 3 : k2 > k1 && k2 > 1 ? 2 : k1 > 1 ? 1 : 0; }
    }
  }

  // ---- scene ----------------------------------------------------------------------------------------------
  const SWELL = [
    // amplitude, kx, kz, omega, phase
    [0.010, 2.3, 4.1, 1.7, 0.3], [0.007, 4.7, 2.6, 2.3, 1.1], [0.005, 7.9, 6.2, 3.1, 2.4], [0.0035, 12.0, 9.0, 3.9, 0.7],
  ];

  const sunGlow = (sx, sy) => { const dx = sx - SUNX, dy = sy - SUNY; return Math.exp(-(dx * dx + dy * dy) / 0.02); };

  function put(idx, ch, fr, fgc, fb, br, bgc, bb) {
    chOut[idx] = ch.charCodeAt(0);
    fgOut[idx * 3] = fr; fgOut[idx * 3 + 1] = fgc; fgOut[idx * 3 + 2] = fb;
    bgOut[idx * 3] = br; bgOut[idx * 3 + 1] = bgc; bgOut[idx * 3 + 2] = bb;
  }

  function renderScene(t) {
    const camX = V * t;
    for (let r = 0; r < ROWS; r++) {
      const sy = syArr[r], s = rowS[r], z = rowZ[r];
      const above = sy < HOR;
      for (let c = 0; c < COLS; c++) {
        const sx = sxArr[c], idx = r * COLS + c;
        if (above) { sky(idx, sx, sy, camX, t); continue; }
        const u = sx / s, X = camX + u;
        const d = waterD(X, z);
        if (d > -0.35) water(idx, sx, sy, s, z, u, X, d, t); else land(idx, sx, sy, s, z, X, t, d);
        if (d <= 0 && d > -0.35) { /* wet-sand blend is handled inside water() */ }
      }
    }
  }

  function sky(idx, sx, sy, camX, t) {
    const tt = (sy + 0.5) / (HOR + 0.5);
    grad(SKY, tt);
    let rr = C[0], gg = C[1], bb = C[2];
    const gl = sunGlow(sx, sy);
    rr += 60 * gl; gg += 75 * gl; bb += 110 * gl;
    // clouds: stretched value noise that drifts slowly the other way
    const cn = vnoise((sx + camX * 0.02) * 2.4, sy * 16) * 0.65 + vnoise((sx + camX * 0.02) * 6, sy * 40 + 3) * 0.35;
    const cl = smooth(0.52, 0.78, cn) * smooth(0.12, 0.5, tt) * (1 - 0.4 * smooth(0.85, 1, tt));
    if (cl > 0) { rr = lerp(rr, 52 * (0.5 + 0.5 * tt), cl * 0.6); gg = lerp(gg, 56 * (0.5 + 0.5 * tt), cl * 0.6); bb = lerp(bb, 84, cl * 0.5); }
    let ch = pick(SKY_CH, clamp(cl * 0.9 + gl * 0.8 + tt * 0.45, 0, 0.999));
    if (hash(idx, 11) > 0.12 + cl * 0.45 + gl * 0.5) ch = ' ';   // thin out the sky so it reads as flat colour, not texture
    let fr = rr * 1.5 + 25, fg = gg * 1.4 + 20, fb = bb * 1.3 + 25;
    // stars
    const dist = Math.sqrt((sx - SUNX) ** 2 + (sy - SUNY) ** 2);
    if (tt < 0.55 && hash(idx, 7) < 0.022 * (1 - tt * 1.5)) {
      const tw = 0.6 + 0.4 * Math.sin(t * 3 + idx);
      ch = tw > 0.7 ? '*' : '.'; fr = fg = fb = 200 * tw;
    }
    // sun disk
    // crescent moon: a bright disk with a shadow disk cut out of one side, the rest faintly visible
    if (dist < 0.055) {
      const inShadow = Math.sqrt((sx - SUNX - 0.028) ** 2 + (sy - SUNY + 0.012) ** 2) < 0.05;
      if (!inShadow) { ch = dist < 0.04 ? '@' : '#'; fr = 240; fg = 244; fb = 252; rr = 190; gg = 200; bb = 228; }
    }
    // far mountains and near hills, parallaxed
    const mh = 0.06 + 0.15 * ridge(sx * 1.6 + camX * 0.025, 11) - 0.03 * smooth(0.2, 1.2, Math.abs(sx));
    const hh = 0.012 + 0.05 * ridge(sx * 2.4 + camX * 0.07, 29);
    const dy = HOR - sy;
    if (dy < hh) {
      const lit = smooth(0, 0.04, hh - dy);
      put(idx, pick(HILL_CH, 0.2 + 0.4 * hash(idx, 3)), 36 + 10 * lit, 38 + 10 * lit, 56, 8, 8, 16);
      return;
    }
    if (dy < mh) {
      const k = smooth(0, mh, dy);
      const bgR = lerp(46, 30, k), bgG = lerp(48, 32, k), bgB = lerp(72, 52, k);
      put(idx, pick(HILL_CH, 0.35 + 0.5 * hash(idx, 5)), bgR * 1.4, bgG * 1.35, bgB * 1.3, bgR * 0.7, bgG * 0.65, bgB * 0.75);
      return;
    }
    put(idx, ch, fr, fg, fb, rr * 0.62, gg * 0.62, bb * 0.62);
  }

  function land(idx, sx, sy, s, z, X, t, d) {
    // gravel: smooth dark ground with soft patches of lighter and darker grit, only a sparse scatter of characters
    const fine = 1 / (1 + 0.22 * z);
    const n1 = vnoise(X * 1.1, z * 1.6), n2 = vnoise(X * 4.0 + 7, z * 5.0);
    const v = 0.78 + 0.35 * n1 + 0.18 * (n2 - 0.5) * fine;
    let rr = 62 * v, gg = 60 * v, bb = 56 * v;
    const haze = Math.exp(-s * 3.2);
    rr = lerp(rr, 70, haze); gg = lerp(gg, 68, haze); bb = lerp(bb, 92, haze);
    const near = smooth(0.4, 1.4, s);
    rr *= 1 - 0.2 * near; gg *= 1 - 0.2 * near; bb *= 1 - 0.2 * near;
    // damp gravel near the shore
    const wet = smooth(-0.35, 0, d);
    rr *= 1 - 0.4 * wet; gg *= 1 - 0.35 * wet; bb *= 1 - 0.2 * wet;
    // horse shadow (long, thrown behind by the low sun)
    const ex = (sx + 0.32) / 0.5, ey = (sy - GROUND - 0.012) / 0.034;
    const sh = Math.exp(-(ex * ex + ey * ey) * 1.4) * 0.6;
    let ch, fr, fg, fb;
    // everything is anchored to world cells (not screen cells) so the grit scrolls with the ground
    const row = (idx / COLS) | 0;
    const key = Math.floor((camX0(t) * s + sx) * CPU);
    const hp = hash(key, row), hq = hash(key + 4099, row + 17), hw = hash(key + 77, row + 5);
    const hf = hash(key * 3 + 1, row * 5 + 2);
    const dry = d < -0.4;
    const patch = dry ? smooth(0.80, 0.9, vnoise(X * 1.2 + 31, z * 1.7 + 50)) : 0;   // sparse grass patches, in the ground's frame
    if (patch > 0 && hf < 0.45 * patch * (0.4 + fine)) {                          // blades of grass, several shades of green
      ch = "\"'^;,"[Math.floor(hq * 5)];
      const g = 0.7 + 0.6 * hw;
      fr = 52 * g; fg = 112 * g + 16; fb = 54 * g;
      rr = lerp(rr, 30, 0.35 * patch); gg = lerp(gg, 46, 0.35 * patch); bb = lerp(bb, 30, 0.35 * patch);
    } else if (hp < 0.05 * fine + 0.012) {                                      // grit: varied glyph, tint and brightness
      ch = PEBBLE[Math.floor(hq * PEBBLE.length)];
      const warm = hw > 0.55, br = 1.25 + 0.9 * hash(key + 9, row + 3);
      fr = rr * br + (warm ? 20 : 4); fg = gg * br + (warm ? 8 : 6); fb = bb * br + (warm ? 0 : 16);
    } else { ch = ' '; fr = rr; fg = gg; fb = bb; }
    const k = 1 - sh;
    // dark foreground grass blades along the bottom rows
    if (sy > 0.36) {
      const Xf = camX0(t) * 2.2 + sx;
      const bh = 0.02 + 0.07 * vnoise(Xf * 9, 0.5) + 0.04 * Math.sin(t * 2.2 + Xf * 6);
      if (sy > 0.5 - bh) {
        const sw = Math.sin(t * 2.4 + Xf * 5);
        put(idx, sw > 0.35 ? '/' : sw < -0.35 ? '\\' : '|', 60, 46, 30, 12, 9, 8);
        return;
      }
    }
    put(idx, ch, fr * k, fg * k, fb * k, rr * 0.8 * k, gg * 0.8 * k, bb * 0.8 * k);
  }
  const camX0 = (t) => V * t;

  function water(idx, sx, sy, s, z, u, X, d, t) {
    // height + slope: analytic swell plus the simulated disturbance
    let H = 0, hx = 0, hz = 0;
    for (let w = 0; w < SWELL.length; w++) {
      const [a, kx, kz, om, phs] = SWELL[w];
      const arg = kx * X + kz * z - om * t + phs;
      H += a * Math.sin(arg); const cs = a * Math.cos(arg); hx += cs * kx; hz += cs * kz;
    }
    let simAmt = 0;
    {
      const fi = (u + UHALF) / DU, fj = (z - ZMIN) / DZ;
      if (fi > 2 && fi < NX - 3 && fj > 2 && fj < NZ - 3) {
        const i0 = Math.floor(fi), j0 = Math.floor(fj), ti = fi - i0, tj = fj - j0;
        const k = j0 * NX + i0, w00 = (1 - ti) * (1 - tj), w10 = ti * (1 - tj), w01 = (1 - ti) * tj, w11 = ti * tj;
        const fade = smooth(ZMAX, ZMAX - 1.0, z) * smooth(UHALF, UHALF - 0.4, Math.abs(u));
        const sH = hA[k] * w00 + hA[k + 1] * w10 + hA[k + NX] * w01 + hA[k + NX + 1] * w11;
        const sGx = gxF[k] * w00 + gxF[k + 1] * w10 + gxF[k + NX] * w01 + gxF[k + NX + 1] * w11;
        const sGz = gzF[k] * w00 + gzF[k + 1] * w10 + gzF[k + NX] * w01 + gzF[k + NX + 1] * w11;
        H += sH * fade; hx += sGx * fade; hz += sGz * fade; simAmt = Math.abs(sH) * fade;
      }
    }
    const deep = smooth(0, 2.2, Math.max(0, d));
    // reflect the sky in the water
    const mirror = HOR - (sy - HOR) * 0.8;
    grad(SKY, (mirror + 0.5) / (HOR + 0.5));
    const fres = 0.22 + 0.62 * Math.exp(-s * 2.2);
    let rr = lerp(5, C[0] * 0.85, fres), gg = lerp(14, C[1] * 0.8, fres), bb = lerp(26, C[2] * 0.8, fres);
    const shallow = 1 - deep;
    rr = lerp(rr, 44, shallow * 0.55); gg = lerp(gg, 64, shallow * 0.5); bb = lerp(bb, 74, shallow * 0.45);
    const crest = clamp(0.42 + 3.2 * hz + 0.8 * hx, 0, 1);
    const lightMul = 0.75 + 0.7 * crest;
    rr *= lightMul; gg *= lightMul; bb *= lightMul;
    // sun glitter path
    const gw = 0.05 + 0.3 * (sy - HOR);
    const gcol = Math.exp(-(((sx - SUNX) / gw) ** 2));
    const q = hz * 5 + hx * 2.2;
    const spark = Math.pow(Math.max(0, Math.sin(q * 14 + hash(idx, 2) * 6.283 + t * 2)), 8) * gcol;
    rr += 190 * spark; gg += 205 * spark; bb += 235 * spark;
    // foam: hoof wake + shoreline break
    const edge = Math.abs(d);
    const shore = (1 - smooth(0.0, 0.38 + 0.2 * Math.sin(X * 3 + t * 1.5 + z * 2), edge)) * (0.6 + 0.4 * Math.sin(X * 9 - t * 2));
    const foam = clamp((simAmt - 0.012) * 45, 0, 1) * (0.5 + 0.5 * hash(idx, Math.floor(t * 4))) + clamp(shore, 0, 1) * (d > -0.3 ? 1 : 0);
    const fam = clamp(foam, 0, 1);
    let ch, fr, fg, fb;
    if (fam > 0.18) {
      ch = pick(FOAM_CH, clamp(fam, 0, 0.999));
      fr = 245; fg = 240; fb = 235;
      rr = lerp(rr, 190, fam * 0.5); gg = lerp(gg, 195, fam * 0.5); bb = lerp(bb, 200, fam * 0.5);
    } else if (spark > 0.25) {
      ch = spark > 0.6 ? '*' : '+'; fr = 215; fg = 225; fb = 245;
    } else {
      ch = pick(WAVE_CH, clamp(crest * 0.9 + 0.1 * hash(idx, 1), 0, 0.999));
      fr = rr * 1.9 + 20; fg = gg * 1.7 + 25; fb = bb * 1.5 + 30;
    }
    // wet sand on the land side of the shoreline
    if (d <= 0) {
      const k = smooth(-0.35, 0, d);      // 0 at the sand, 1 at the waterline
      const sr = 50, sg = 48, sb = 52;
      rr = lerp(sr, rr, k); gg = lerp(sg, gg, k); bb = lerp(sb, bb, k);
      fr = lerp(sr * 1.3, fr, k); fg = lerp(sg * 1.3, fg, k); fb = lerp(sb * 1.3, fb, k);
    }
    put(idx, ch, fr, fg, fb, rr * 0.8, gg * 0.8, bb * 0.8);
  }

  // ---- compositing: reflection, horse, particles ------------------------------------------------------
  function reflection(t) {
    const camX = V * t;
    const rG = (GROUND + 0.012 + 0.5) * ROWS - 0.5;
    for (let r = Math.ceil(rG) + 1; r < ROWS; r++) {
      const rm = 2 * rG - r;
      const rm0 = Math.floor(rm), tr = rm - rm0;
      if (rm0 < by0 || rm0 + 1 > by1) continue;
      const s = rowS[r], z = rowZ[r];
      const fade = Math.exp(-(r - rG) * 0.045);
      for (let c = bx0; c <= bx1; c++) {
        const sx = sxArr[c];
        const dW = waterD(camX + sx / s, z);
        if (dW < 0.15) continue;
        // ripple the reflection sideways
        const disp = 1.6 * Math.sin(r * 1.9 + t * 3.2 + c * 0.08) + 0.5 * Math.sin(r * 4.7 - t * 5);
        const cs = Math.round(c + disp);
        if (cs < bx0 || cs > bx1) continue;
        const k0 = rm0 * COLS + cs, k1 = k0 + COLS;
        const cov = (covBuf[k0] * (1 - tr) + covBuf[k1] * tr) * 0.62 * fade;
        if (cov < 0.08) continue;
        const tone = (toneBuf[k0] * (1 - tr) + toneBuf[k1] * tr) * 0.7;
        const i = r * COLS + c;
        const a = smooth(0.08, 0.5, cov);
        grad(HORSE_PAL, tone);
        fgOut[i * 3] = lerp(fgOut[i * 3], C[0] * 0.8, a); fgOut[i * 3 + 1] = lerp(fgOut[i * 3 + 1], C[1] * 0.8, a); fgOut[i * 3 + 2] = lerp(fgOut[i * 3 + 2], C[2] * 0.8, a);
        bgOut[i * 3] = lerp(bgOut[i * 3], 16, a * 0.8); bgOut[i * 3 + 1] = lerp(bgOut[i * 3 + 1], 14, a * 0.8); bgOut[i * 3 + 2] = lerp(bgOut[i * 3 + 2], 18, a * 0.8);
        if (a > 0.4) chOut[i] = HORSE_CH.charCodeAt(clamp(Math.floor(tone * 8), 1, 9));
      }
    }
  }

  function composeHorse() {
    const at = (r, c) => (r < 0 || c < 0 || r >= ROWS || c >= COLS) ? 0 : covBuf[r * COLS + c];
    for (let r = by0; r <= by1; r++) for (let c = bx0; c <= bx1; c++) {
      const i = r * COLS + c, cov = covBuf[i];
      if (cov < 0.12) continue;
      const a = smooth(0.12, 0.55, cov);
      // silhouette edge: a cell that touches empty space gets a bright outline, the inside is a darker filled mass
      const edge = Math.min(at(r - 1, c), at(r + 1, c), at(r, c - 1), at(r, c + 1)) < 0.12;
      const kind = kindBuf[i];
      let tone = edge ? Math.min(0.72, toneBuf[i] * 1.2 + 0.08) : toneBuf[i] * (kind ? 0.95 : 0.8);
      if (kind === 1) tone = Math.min(1, tone * 1.15 + 0.12);        // steel: clearly lighter than the night behind it
      grad(kind ? PALS[kind] : HORSE_PAL, tone);
      const ci = clamp(Math.floor(1 + tone * 8), 1, 7);
      for (let k = 0; k < 3; k++) {
        fgOut[i * 3 + k] = lerp(fgOut[i * 3 + k], C[k], a);
        bgOut[i * 3 + k] = lerp(bgOut[i * 3 + k], kind === 2 ? [30 + 70 * tone, 5, 7][k] : kind === 1 ? [34 + 54 * tone, 42 + 62 * tone, 62 + 84 * tone][k] : (edge ? 46 : 38) + 50 * tone * (k === 2 ? 1 : 0.9), a);
      }
      // the rider is drawn with a different glyph family from the horse, so he reads as a separate figure
      if (cov > 0.3) {
        if (kind) {
          const fam = RIDER_CH[kind], j = Math.floor(clamp(tone, 0, 0.999) * fam.length + (hash(i, 21) - 0.5) * 1.2);
          chOut[i] = hash(i, 31) < (kind === 2 ? 0.7 : 0.6) ? fam[clamp(j, 0, fam.length - 1)].charCodeAt(0) : 32;   // thin out the letters
        } else chOut[i] = hash(i, 41) < (edge ? 0.9 : 0.62) ? HORSE_CH.charCodeAt(ci) : 32;   // thin out the horse's characters
      }
    }
  }

  function drawMarks(t) {
    const camX = V * t;
    for (let k = 0; k < mN; k++) {
      const s = Math.max(0.05, (mGY[k] - HOR) / (GROUND - HOR));
      const c0 = Math.round((mX[k] - camX) * s * CPU + COLS / 2), r0 = Math.floor((mGY[k] + 0.5) * ROWS);
      const w = 2 + Math.round(s * 1.5);
      for (let dc = -w; dc <= w; dc++) {
        const c = c0 + dc;
        if (c < 0 || c >= COLS) continue;
        for (let dr = 0; dr <= 1; dr++) {
          const r = r0 + dr;
          if (r < 0 || r >= ROWS || (dr === 1 && Math.abs(dc) > w - 1)) continue;
          const h = hash(k * 31 + dc, Math.floor(mSeed[k]) + dr);
          if (h < 0.22) continue;
          const i = r * COLS + c, a = dr === 0 ? 0.65 : 0.4;
          bgOut[i * 3] = lerp(bgOut[i * 3], 84, a); bgOut[i * 3 + 1] = lerp(bgOut[i * 3 + 1], 56, a); bgOut[i * 3 + 2] = lerp(bgOut[i * 3 + 2], 36, a);
          chOut[i] = (h < 0.5 ? ':' : h < 0.75 ? ',' : '.').charCodeAt(0);
          fgOut[i * 3] = 150; fgOut[i * 3 + 1] = 102; fgOut[i * 3 + 2] = 66;
        }
      }
    }
  }

  const flicker = (t) => 0.82 + 0.12 * Math.sin(t * 17) + 0.08 * Math.sin(t * 29 + 1);

  // the world is lit only by dim cold moonlight; the torch is what actually illuminates things
  function applyLighting(t) {
    const fl = flicker(t);
    for (let r = 0; r < ROWS; r++) {
      const dy = syArr[r] - torchY, sy = syArr[r];
      for (let c = 0; c < COLS; c++) {
        const dx = sxArr[c] - torchX, d2 = dx * dx + dy * dy, i = r * COLS + c;
        const L = (1.5 * Math.exp(-d2 / 0.14) + 0.3 * Math.exp(-d2 / 0.7)) * fl;
        const mx = sxArr[c] - SUNX, my = sy - SUNY, moon = 0.75 * Math.exp(-(mx * mx + my * my) / 0.012);   // the moon keeps its own glow
        const mr = 0.24 + L + moon * 0.8, mg = 0.27 + L * 0.58 + moon * 0.85, mb = 0.36 + L * 0.26 + moon;
        fgOut[i * 3] *= mr; fgOut[i * 3 + 1] *= mg; fgOut[i * 3 + 2] *= mb;
        bgOut[i * 3] *= mr; bgOut[i * 3 + 1] *= mg; bgOut[i * 3 + 2] *= mb;
        // warm wash from the flame on top of the multiplied colour
        const w = 38 * L * L;
        bgOut[i * 3] += w; bgOut[i * 3 + 1] += w * 0.45; bgOut[i * 3 + 2] += w * 0.1;
      }
    }
  }

  const sy_ = (r) => syArr[r];
  const FL_H = 0.075, FL_W = 0.017;     // a small flame: height and half-width in screen-height units

  function drawTorch(t) {
    const flick = flicker(t);
    const cc = Math.round(torchX * CPU + COLS / 2), cr = Math.round((torchY + 0.5) * ROWS);
    // sparks and smoke shed by the torch; they stay in the air while the horse runs on, so they stream out behind
    if (rnd() < 0.4) spawn(2, torchX + (rnd() - 0.5) * 0.012, torchY - 0.02 - rnd() * 0.02, -(rnd() * 0.15), -(0.05 + rnd() * 0.3), 0.5 + rnd() * 0.5);
    if (rnd() < 0.12) spawn(3, torchX - 0.005, torchY - 0.05, -(rnd() * 0.1), -(0.04 + rnd() * 0.12), 0.6 + rnd() * 0.6);
    const gw = Math.ceil(0.05 * CPU), gh = Math.ceil(0.07 * ROWS);
    for (let r = Math.max(0, cr - gh); r <= Math.min(ROWS - 1, cr + gh); r++) {
      const dy = syArr[r] - torchY;
      for (let c = Math.max(0, cc - gw); c <= Math.min(COLS - 1, cc + gw); c++) {
        const dx = sxArr[c] - torchX, i = r * COLS + c;
        // flame: one small campfire-style tongue, a teardrop with a wavering centre line and turbulent edges,
        // coloured by temperature (dark red, orange, yellow, pale yellow) with a heavier glyph where it is hotter
        const yn = -(dy + 0.003) / (FL_H * flick);
        if (yn < -0.08 || yn > 1.08) continue;
        const yp = clamp(yn, 0, 1);
        const cx = torchX + 0.005 * Math.sin(yp * 5.5 + t * 7) * yp + 0.012 * (vnoise(yp * 1.7, t * 1.8) - 0.5) * yp;
        let w = FL_W * Math.pow(Math.sin(Math.PI * Math.pow(yp, 0.55)), 0.9) * (1 - 0.25 * yp);
        if (yp < 0.30) w = Math.max(w, 0.45 * FL_W * (1 - yp / 0.30));
        const ex = Math.abs(sxArr[c] - cx);
        if (ex > w * 1.8 + 0.004) continue;
        const en = vnoise(sxArr[c] * 90 + 3, sy_(r) * 90 - t * 4.2) - 0.5;
        const dn = ex / (w + 1e-4) + en * (0.26 + 0.8 * yp);
        const dd = smooth(1.05, 0.22, dn) * smooth(1.08, 0.84, yn) * smooth(-0.08, 0.0, yn);
        if (dd <= 0.05) continue;
        const core = Math.exp(-(((sxArr[c] - cx) / (w * 0.4 + 1e-4)) ** 2)) * Math.pow(1 - yp, 0.6);
        const T = clamp((Math.pow(dd, 1.15) * (1 - 0.6 * Math.pow(yp, 1.05))) * 0.78 + 0.22 * core * dd, 0, 1);
        grad(FLAME_PAL, T);
        const al = dd * (0.35 + 0.65 * smooth(0, 0.35, T)), gain = 0.5 + 0.58 * T;
        bgOut[i * 3] = bgOut[i * 3] * (1 - 0.6 * al) + C[0] * gain * al * 0.85;
        bgOut[i * 3 + 1] = bgOut[i * 3 + 1] * (1 - 0.6 * al) + C[1] * gain * al * 0.85;
        bgOut[i * 3 + 2] = bgOut[i * 3 + 2] * (1 - 0.6 * al) + C[2] * gain * al * 0.85;
        if (al > 0.22) {
          chOut[i] = pick(FLAME_CH, T + (hash(c * 7 + Math.floor(t * 12), r) - 0.5) * 0.12).charCodeAt(0);
          fgOut[i * 3] = C[0] * 1.1; fgOut[i * 3 + 1] = C[1] * 1.1; fgOut[i * 3 + 2] = C[2] * 1.1;
        }
      }
    }
  }

  function drawParticles() {
    for (let k = 0; k < pN; k++) {
      const c = Math.floor(pX[k] * ROWS * CH / CW + COLS / 2), r = Math.floor((pY[k] + 0.5) * ROWS);
      if (c < 0 || c >= COLS || r < 0 || r >= ROWS) continue;
      const i = r * COLS + c, f = clamp(pLife[k] / pLife0[k], 0, 1);
      if (pKind[k] === 2) {                                   // ember: bright, cools to red, flickers out
        chOut[i] = (f > 0.6 ? '*' : f > 0.3 ? '+' : '.').charCodeAt(0);
        fgOut[i * 3] = 255; fgOut[i * 3 + 1] = 70 + 160 * f * f; fgOut[i * 3 + 2] = 20 + 60 * f * f * f;
      } else if (pKind[k] === 3) {                            // smoke: faint grey wisps
        chOut[i] = (f > 0.5 ? ':' : f > 0.2 ? '.' : ',').charCodeAt(0);
        const g = 40 + 70 * f;
        fgOut[i * 3] = g; fgOut[i * 3 + 1] = g * 0.96; fgOut[i * 3 + 2] = g * 1.05;
      } else if (pKind[k] === 0) {
        chOut[i] = (f > 0.6 ? '*' : f > 0.3 ? 'o' : '.').charCodeAt(0);
        fgOut[i * 3] = 235; fgOut[i * 3 + 1] = 245; fgOut[i * 3 + 2] = 255;
      } else {
        chOut[i] = (f > 0.55 ? ':' : f > 0.25 ? '.' : ',').charCodeAt(0);
        fgOut[i * 3] = 140 * (0.4 + 0.6 * f); fgOut[i * 3 + 1] = 136 * (0.4 + 0.6 * f); fgOut[i * 3 + 2] = 140 * (0.4 + 0.6 * f);
      }
    }
  }

  function renderCells(t) {
    if (t < simT - 1e-6) resetSim();
    while (simT < t - 1e-9) stepSim();
    updateGrad();
    drawHorse(t);
    renderScene(t);
    drawMarks(t);
    reflection(t);
    composeHorse();
    applyLighting(t);
    drawTorch(t);
    drawParticles();
    return { ch: chOut, fg: fgOut, bg: bgOut };
  }

  return { FPS, init, renderCells, debug: () => ({ covBuf, toneBuf, COLS, ROWS }), dims: () => ({ COLS, ROWS, W: COLS * CW, H: ROWS * CH }) };
})();

if (typeof module !== 'undefined') module.exports = WildHorse;
