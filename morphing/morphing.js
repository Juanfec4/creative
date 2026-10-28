// A solid that morphs between a 3D cube and a 3D square pyramid while it rotates.
//
// Both solids share one set of 8 vertices: the 4 bottom corners never move, and the 4 top corners slide in toward the centre
// line and rise a little. At morph = 0 they sit above the bottom corners (a cube); at morph = 1 they have all met at a single
// point (a pyramid). The four side faces stay flat the whole way (trapezoids that narrow into triangles) and the top face
// shrinks to nothing, so every in-between shape is a convex solid.
// Each frame the solid is rotated and projected in perspective and its faces are rasterised into supersampled pixels with a
// depth buffer. Every face has its own colour and is lit flat; the edges are found per pixel and drawn with glyphs that follow
// their direction (| - / \). A cell compositor then turns it all into coloured characters, plus a glow and a pool of light.
const Morphing = (function () {
  'use strict';

  const PI = Math.PI, TAU = 2 * PI;
  const FPS = 30;

  const PERIOD = 12;               // seconds for one cube -> pyramid -> cube cycle
  const APEX_RISE = 0.45;          // how much taller the pyramid's apex is than the cube's top
  const CAM_D = 6.2, FOCAL = 3.4, SCALE = 0.30, ZOOM = 1.35;

  const clamp = (x, a, b) => x < a ? a : x > b ? b : x;
  const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const lerp = (a, b, t) => a + (b - a) * t;

  function hash(x, y) {
    let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  const FILL_CH = ".:-=+xX#%@";
  const GLOW_CH = ".'`,";
  const FLOOR_CH = ".-~=";
  const EDGE_CH = ['-', '\\', '|', '/'];                  // by direction: 0 horizontal, then rotating clockwise on screen
  const pick = (s, v) => s[clamp(Math.floor(v * s.length), 0, s.length - 1)];

  // ---- solid ------------------------------------------------------------------------------------------------
  // vertices 0..3 bottom, 4..7 top (same x, y); x/y signs per corner
  const CX = [-1, 1, 1, -1], CY = [-1, -1, 1, 1];
  // faces as quads, wound counter-clockwise seen from outside, each with a base colour
  const FACES = [
    { q: [0, 3, 2, 1], col: [150, 112, 255] },   // bottom
    { q: [4, 5, 6, 7], col: [236, 240, 255] },   // top (vanishes in the pyramid)
    { q: [0, 1, 5, 4], col: [255, 172, 78] },    // front
    { q: [1, 2, 6, 5], col: [255, 92, 140] },    // right
    { q: [2, 3, 7, 6], col: [86, 164, 255] },    // back
    { q: [3, 0, 4, 7], col: [120, 255, 176] },   // left
  ];

  // ---- dims -------------------------------------------------------------------------------------------------
  let CW, CH, COLS, ROWS, N, CPU;
  const SXs = 2, SYs = 4;
  let SXN, SYN, zbuf, sr, sg, sb, sl, se, cover, cellR, cellG, cellB, cellL, cellE, cellD, glowA, glowB;
  let chOut, fgOut, bgOut;

  function init(cw, chh, cols, rows) {
    CW = cw; CH = chh; COLS = cols; ROWS = rows; N = COLS * ROWS;
    CPU = ROWS * CH / CW;
    SXN = COLS * SXs; SYN = ROWS * SYs;
    const S = SXN * SYN;
    zbuf = new Float32Array(S); sr = new Float32Array(S); sg = new Float32Array(S); sb = new Float32Array(S); sl = new Float32Array(S);
    se = new Int8Array(S);                                // -1 = interior, else the edge direction code 0..3
    cover = new Float32Array(N); cellR = new Float32Array(N); cellG = new Float32Array(N); cellB = new Float32Array(N); cellL = new Float32Array(N);
    cellE = new Float32Array(N); cellD = new Int8Array(N);
    glowA = new Float32Array(N); glowB = new Float32Array(N);
    chOut = new Uint8Array(N); fgOut = new Uint8ClampedArray(N * 3); bgOut = new Uint8ClampedArray(N * 3);
  }

  // ---- view -------------------------------------------------------------------------------------------------
  const M = new Float32Array(9);
  function setView(t) {
    const spin = 0.50 * t, tilt = 0.50 + 0.14 * Math.sin(t * 0.41), roll = 0.12 * Math.sin(t * 0.29);
    const cs = Math.cos(spin), sn = Math.sin(spin), ct = Math.cos(tilt), st = Math.sin(tilt), cr = Math.cos(roll), sr_ = Math.sin(roll);
    const rz = [cs, -sn, 0, sn, cs, 0, 0, 0, 1];                    // spin about the solid's own vertical axis
    const rx = [1, 0, 0, 0, ct, -st, 0, st, ct];                    // tilt it toward the camera
    const rr = [cr, -sr_, 0, sr_, cr, 0, 0, 0, 1];
    const mul = (a, b) => { const o = new Array(9); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) o[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j]; return o; };
    const m = mul(rr, mul(rx, rz));
    for (let i = 0; i < 9; i++) M[i] = m[i];
  }
  // object (x, y, z up) -> view (X right, Y up, Z toward the camera)
  const toView = (x, y, z, out) => {
    const a = M[0] * x + M[1] * y + M[2] * z, b = M[3] * x + M[4] * y + M[5] * z, c = M[6] * x + M[7] * y + M[8] * z;
    out[0] = a; out[1] = c; out[2] = -b;
  };

  // ---- per-frame geometry -----------------------------------------------------------------------------------
  const VPX = new Float32Array(8), VPY = new Float32Array(8), VD = new Float32Array(8);     // screen position (sample units) and depth
  const VVX = new Float32Array(8), VVY = new Float32Array(8), VVZ = new Float32Array(8);   // view-space position
  let morph = 0;

  function buildVertices() {
    const top = 1 + APEX_RISE * morph, inset = 1 - morph, lift = 0.22 * morph;                // lift recentres the pyramid, which is bottom-heavy
    const q = [0, 0, 0];
    for (let k = 0; k < 8; k++) {
      const c = k & 3, isTop = k >= 4;
      const x = CX[c] * (isTop ? inset : 1), y = CY[c] * (isTop ? inset : 1), z = (isTop ? top : -1) - lift;
      toView(x, y, z, q);
      VVX[k] = q[0]; VVY[k] = q[1]; VVZ[k] = q[2];
      const d = CAM_D - q[2];
      VD[k] = d;
      VPX[k] = (q[0] * FOCAL / d * SCALE * CPU * ZOOM + COLS / 2) * SXs;
      VPY[k] = (-q[1] * FOCAL / d * SCALE * ROWS * ZOOM + ROWS / 2) * SYs;
    }
  }

  // ---- shading ----------------------------------------------------------------------------------------------
  const LIGHT = (() => { const l = [-0.5, 0.7, 0.55], n = Math.hypot(l[0], l[1], l[2]); return [l[0] / n, l[1] / n, l[2] / n]; })();

  // flat shading for a whole face: returns [r, g, b, brightness]
  function shadeFace(nx, ny, nz, col, dist, out) {
    const diff = Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);
    const hx = LIGHT[0], hy = LIGHT[1], hz = LIGHT[2] + 1, hl = Math.hypot(hx, hy, hz);
    const spec = Math.pow(Math.max(0, (nx * hx + ny * hy + nz * hz) / hl), 18);
    const rim = Math.pow(1 - clamp(nz, 0, 1), 2.2);
    const lit = 0.34 + 0.85 * diff;
    const fog = clamp(1.2 - (dist - (CAM_D - 1.6)) * 0.16, 0.5, 1.1);
    out[0] = (col[0] * lit + 50 * rim + 255 * spec * 0.4) * fog;
    out[1] = (col[1] * lit + 90 * rim + 255 * spec * 0.4) * fog;
    out[2] = (col[2] * lit + 200 * rim + 255 * spec * 0.4) * fog;
    out[3] = clamp((0.22 + 0.78 * diff) * fog + spec * 0.5, 0, 1);
  }

  // ---- rasteriser -------------------------------------------------------------------------------------------
  const _s = [0, 0, 0, 0];

  function triangle(a, b, c, mask, col, nrm) {
    const x0 = VPX[a], y0 = VPY[a], x1 = VPX[b], y1 = VPY[b], x2 = VPX[c], y2 = VPY[c];
    const area2 = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (Math.abs(area2) < 0.5) return;
    const den = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
    // heights of each vertex above its opposite edge, and the direction of each real edge, for edge detection
    const e0 = Math.hypot(x2 - x1, y2 - y1) || 1, e1 = Math.hypot(x0 - x2, y0 - y2) || 1, e2 = Math.hypot(x1 - x0, y1 - y0) || 1;
    const h0 = Math.abs(area2) / e0, h1 = Math.abs(area2) / e1, h2 = Math.abs(area2) / e2;
    const dirOf = (dx, dy) => { let a = Math.atan2(dy, dx); if (a < 0) a += PI; return Math.floor(((a + PI / 8) % PI) / (PI / 4)) % 4; };
    const d0 = dirOf(x2 - x1, y2 - y1), d1 = dirOf(x0 - x2, y0 - y2), d2 = dirOf(x1 - x0, y1 - y0);
    const dist = (VD[a] + VD[b] + VD[c]) / 3;
    shadeFace(nrm[0], nrm[1], nrm[2], col, dist, _s);
    const minx = Math.max(0, Math.floor(Math.min(x0, x1, x2))), maxx = Math.min(SXN - 1, Math.ceil(Math.max(x0, x1, x2)));
    const miny = Math.max(0, Math.floor(Math.min(y0, y1, y2))), maxy = Math.min(SYN - 1, Math.ceil(Math.max(y0, y1, y2)));
    const EW = 1.15;                                             // edge half-width in samples
    for (let y = miny; y <= maxy; y++) {
      for (let x = minx; x <= maxx; x++) {
        const px = x + 0.5, py = y + 0.5;
        const l0 = ((y1 - y2) * (px - x2) + (x2 - x1) * (py - y2)) / den;
        const l1 = ((y2 - y0) * (px - x2) + (x0 - x2) * (py - y2)) / den;
        const l2 = 1 - l0 - l1;
        if (l0 < -0.003 || l1 < -0.003 || l2 < -0.003) continue;
        const z = l0 * VD[a] + l1 * VD[b] + l2 * VD[c];
        const idx = y * SXN + x;
        if (z >= zbuf[idx]) continue;
        zbuf[idx] = z;
        sr[idx] = _s[0]; sg[idx] = _s[1]; sb[idx] = _s[2]; sl[idx] = _s[3];
        let ed = -1, best = EW;
        if (mask[0] && l0 * h0 < best) { best = l0 * h0; ed = d0; }
        if (mask[1] && l1 * h1 < best) { best = l1 * h1; ed = d1; }
        if (mask[2] && l2 * h2 < best) { best = l2 * h2; ed = d2; }
        se[idx] = ed;
      }
    }
  }

  const QMASK1 = [1, 0, 1], QMASK2 = [1, 1, 0];                  // real edges of the two triangles of a quad (a b c) and (a c d)
  function raster() {
    zbuf.fill(1e9); sl.fill(0); se.fill(-1);
    for (const F of FACES) {
      const [a, b, c, d] = F.q;
      // face normal in view space from its screen-space-independent vertices
      const ux = VVX[b] - VVX[a], uy = VVY[b] - VVY[a], uz = VVZ[b] - VVZ[a];
      const vx = VVX[c] - VVX[a], vy = VVY[c] - VVY[a], vz = VVZ[c] - VVZ[a];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      let nl = Math.hypot(nx, ny, nz);
      if (nl < 1e-5) {                                           // the two edges are parallel (the apex triangle): use the other pair
        const wx = VVX[d] - VVX[a], wy = VVY[d] - VVY[a], wz = VVZ[d] - VVZ[a];
        nx = vy * wz - vz * wy; ny = vz * wx - vx * wz; nz = vx * wy - vy * wx; nl = Math.hypot(nx, ny, nz);
        if (nl < 1e-6) continue;
      }
      nx /= nl; ny /= nl; nz /= nl;
      // back-face cull: the face points away from the camera if its normal has no component toward it
      const cx = (VVX[a] + VVX[b] + VVX[c] + VVX[d]) / 4, cy = (VVY[a] + VVY[b] + VVY[c] + VVY[d]) / 4, cz = (VVZ[a] + VVZ[b] + VVZ[c] + VVZ[d]) / 4;
      if (nx * (cx) + ny * (cy) + nz * (cz - CAM_D) >= 0) continue;
      triangle(a, b, c, QMASK1, F.col, [nx, ny, nz]);
      triangle(a, c, d, QMASK2, F.col, [nx, ny, nz]);
    }
  }

  // ---- cell compositor --------------------------------------------------------------------------------------
  let accR = 0, accG = 0, accB = 0, accN = 0;
  function reduce() {
    accR = accG = accB = accN = 0;
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      let hit = 0, R_ = 0, G_ = 0, B_ = 0, L_ = 0, edge = 0;
      const dirs = [0, 0, 0, 0];
      for (let sj = 0; sj < SYs; sj++) {
        const row = (r * SYs + sj) * SXN + c * SXs;
        for (let si = 0; si < SXs; si++) {
          if (zbuf[row + si] < 1e8) {
            hit++; R_ += sr[row + si]; G_ += sg[row + si]; B_ += sb[row + si]; L_ += sl[row + si];
            if (se[row + si] >= 0) { edge++; dirs[se[row + si]]++; }
          }
        }
      }
      const i = r * COLS + c;
      if (hit > 0) {
        cover[i] = hit / (SXs * SYs); cellR[i] = R_ / hit; cellG[i] = G_ / hit; cellB[i] = B_ / hit; cellL[i] = L_ / hit; cellE[i] = edge / hit;
        let bd = 0; for (let k = 1; k < 4; k++) if (dirs[k] > dirs[bd]) bd = k;
        cellD[i] = bd; accR += R_; accG += G_; accB += B_; accN += hit;
      } else cover[i] = 0;
    }
  }

  function blur(src, dst, rad) {
    const tmp = glowB;
    for (let r = 0; r < ROWS; r++) {
      let sum = 0;
      for (let c = -rad; c <= rad; c++) if (c >= 0 && c < COLS) sum += src[r * COLS + c];
      for (let c = 0; c < COLS; c++) {
        tmp[r * COLS + c] = sum / (2 * rad + 1);
        const add = c + rad + 1, rem = c - rad;
        if (add < COLS) sum += src[r * COLS + add];
        if (rem >= 0) sum -= src[r * COLS + rem];
      }
    }
    const rv = Math.max(1, Math.round(rad / 2));
    for (let c = 0; c < COLS; c++) {
      let sum = 0;
      for (let r = -rv; r <= rv; r++) if (r >= 0 && r < ROWS) sum += tmp[r * COLS + c];
      for (let r = 0; r < ROWS; r++) {
        dst[r * COLS + c] = sum / (2 * rv + 1);
        const add = r + rv + 1, rem = r - rv;
        if (add < ROWS) sum += tmp[add * COLS + c];
        if (rem >= 0) sum -= tmp[rem * COLS + c];
      }
    }
  }

  const cellScratch = () => new Float32Array(N);
  let cellBuf = null;
  function renderCells(t) {
    // cube -> pyramid -> cube, lingering at both ends
    morph = smooth(0.05, 0.95, 0.5 - 0.5 * Math.cos(TAU * t / PERIOD));
    setView(t);
    buildVertices();
    raster();
    reduce();

    chOut.fill(32); fgOut.fill(0); bgOut.fill(0);
    const hue = accN > 0 ? [accR / accN, accG / accN, accB / accN] : [200, 180, 140];
    if (!cellBuf || cellBuf.length !== N) cellBuf = cellScratch();
    for (let i = 0; i < N; i++) cellBuf[i] = cover[i] > 0 ? cover[i] * (0.4 + 0.6 * cellL[i]) : 0;
    blur(cellBuf, glowA, 7);

    for (let r = 0; r < ROWS; r++) {
      const sy = (r + 0.5) / ROWS - 0.5;
      for (let c = 0; c < COLS; c++) {
        const i = r * COLS + c, sx = (c + 0.5 - COLS / 2) / CPU;
        if (cover[i] > 0.12) {
          const cv = cover[i], L = cellL[i];
          if (cellE[i] > 0.22 && cv > 0.3) {                      // an edge of the solid: a crisp line of glyphs along its direction
            const heavy = cellE[i] > 0.6;
            chOut[i] = (heavy && hash(i, 7) < 0.35 ? '#' : EDGE_CH[cellD[i]]).charCodeAt(0);
            fgOut[i * 3] = clamp(cellR[i] * 1.5 + 60, 0, 255); fgOut[i * 3 + 1] = clamp(cellG[i] * 1.5 + 60, 0, 255); fgOut[i * 3 + 2] = clamp(cellB[i] * 1.5 + 60, 0, 255);
            bgOut[i * 3] = cellR[i] * 0.30; bgOut[i * 3 + 1] = cellG[i] * 0.30; bgOut[i * 3 + 2] = cellB[i] * 0.30;
            continue;
          }
          // face fill: lighter glyphs where it is dimmer, heavier where it is bright, over a tinted background
          if (hash(i, 4) < 0.55) {
            const j = Math.floor(clamp(Math.pow(L, 0.85) * 0.95 + (hash(i, 5) - 0.5) * 0.12, 0, 0.999) * FILL_CH.length);
            chOut[i] = FILL_CH[j].charCodeAt(0);
          }
          fgOut[i * 3] = cellR[i] * 1.15; fgOut[i * 3 + 1] = cellG[i] * 1.15; fgOut[i * 3 + 2] = cellB[i] * 1.15;
          const bgk = 0.26 * smooth(0.12, 0.7, cv);
          bgOut[i * 3] = cellR[i] * bgk; bgOut[i * 3 + 1] = cellG[i] * bgk; bgOut[i * 3 + 2] = cellB[i] * bgk;
          continue;
        }
        const gl = glowA[i];
        if (gl > 0.02 && hash(i, 9) < Math.min(1, gl * 2.2)) {      // halo of faint glyphs, tinted by the solid's average colour
          chOut[i] = pick(GLOW_CH, gl * 2.5 + (hash(i, 5) - 0.5) * 0.4).charCodeAt(0);
          const k = clamp(gl * 3.2, 0, 1) * 0.8;
          fgOut[i * 3] = hue[0] * k; fgOut[i * 3 + 1] = hue[1] * k; fgOut[i * 3 + 2] = hue[2] * k;
        }
        const fy = (sy - 0.40) / 0.06, fx = sx / 0.55, fe = Math.exp(-(fx * fx + fy * fy) * 1.6);   // pool of light on the floor beneath it
        if (fe > 0.05 && hash(i, 13) < fe * 0.8) {
          chOut[i] = pick(FLOOR_CH, fe + (hash(i, 6) - 0.5) * 0.3).charCodeAt(0);
          const k = fe * 0.55;
          fgOut[i * 3] = hue[0] * k; fgOut[i * 3 + 1] = hue[1] * k; fgOut[i * 3 + 2] = hue[2] * k;
        }
      }
    }
    return { ch: chOut, fg: fgOut, bg: bgOut };
  }

  return { FPS, init, renderCells, dims: () => ({ COLS, ROWS, W: COLS * CW, H: ROWS * CH }), morphNow: () => morph };
})();

if (typeof module !== 'undefined') module.exports = Morphing;
