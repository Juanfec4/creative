// MT19937 with the two seeding schemes the Python version relies on:
//   numpy RandomState(int)  -> initGenrand(seed)
//   random.Random(int)      -> initByArray([seed])
// Verified bit-identical against numpy 2.5.4 and CPython.
(function (root) {
  class MT {
    constructor() {
      this.mt = new Uint32Array(624);
      this.i = 625;
    }

    initGenrand(s) {
      const mt = this.mt;
      mt[0] = s >>> 0;
      for (let i = 1; i < 624; i++) {
        const p = mt[i - 1] ^ (mt[i - 1] >>> 30);
        mt[i] = (Math.imul(1812433253, p) + i) >>> 0;
      }
      this.i = 624;
      return this;
    }

    initByArray(key) {
      this.initGenrand(19650218);
      const mt = this.mt;
      let i = 1, j = 0;
      for (let k = Math.max(624, key.length); k; k--) {
        const p = mt[i - 1] ^ (mt[i - 1] >>> 30);
        mt[i] = ((mt[i] ^ Math.imul(p, 1664525)) + key[j] + j) >>> 0;
        i++; j++;
        if (i >= 624) { mt[0] = mt[623]; i = 1; }
        if (j >= key.length) j = 0;
      }
      for (let k = 623; k; k--) {
        const p = mt[i - 1] ^ (mt[i - 1] >>> 30);
        mt[i] = ((mt[i] ^ Math.imul(p, 1566083941)) - i) >>> 0;
        i++;
        if (i >= 624) { mt[0] = mt[623]; i = 1; }
      }
      mt[0] = 0x80000000;
      this.i = 624;
      return this;
    }

    u32() {
      const mt = this.mt;
      if (this.i >= 624) {
        let k = 0, y;
        for (; k < 227; k++) {
          y = (mt[k] & 0x80000000) | (mt[k + 1] & 0x7fffffff);
          mt[k] = mt[k + 397] ^ (y >>> 1) ^ ((y & 1) ? 0x9908b0df : 0);
        }
        for (; k < 623; k++) {
          y = (mt[k] & 0x80000000) | (mt[k + 1] & 0x7fffffff);
          mt[k] = mt[k - 227] ^ (y >>> 1) ^ ((y & 1) ? 0x9908b0df : 0);
        }
        y = (mt[623] & 0x80000000) | (mt[0] & 0x7fffffff);
        mt[623] = mt[396] ^ (y >>> 1) ^ ((y & 1) ? 0x9908b0df : 0);
        this.i = 0;
      }
      let y = mt[this.i++];
      y ^= y >>> 11;
      y ^= (y << 7) & 0x9d2c5680;
      y ^= (y << 15) & 0xefc60000;
      y ^= y >>> 18;
      return y >>> 0;
    }

    // [0,1) double, 53 bits: shared by numpy rand() and Python random()
    random() {
      const a = this.u32() >>> 5, b = this.u32() >>> 6;
      return (a * 67108864 + b) / 9007199254740992;
    }

    uniform(a, b) {
      return a + (b - a) * this.random();
    }

    // Python's random.choice((-1, 1)): _randbelow(2) draws 2 bits and rejects >= 2
    choice2(a, b) {
      let r;
      do { r = this.u32() >>> 30; } while (r >= 2);
      return r === 0 ? a : b;
    }
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { MT };
  else root.RNG = { MT };
})(typeof window !== 'undefined' ? window : globalThis);
