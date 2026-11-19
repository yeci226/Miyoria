// A QR Code encoder for the room link shown on the stream. Hand-written because the overlay has no
// dependencies beyond the contracts and none can be added. It covers only what the link needs: byte
// mode (UTF-8), error correction level M, versions 1 to 10 (up to 213 bytes). It follows ISO 18004
// the way Project Nayuki's reference encoder does, mask choice included, and the tests check it
// module for module against uqr (a port of that encoder).

const MAX_VERSION = 10;
/** Error correction codewords per block at level M, by version (index 0 unused). */
const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
/** Error correction blocks at level M, by version (index 0 unused). */
const BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
/** Format bits of level M (the two bits put in front of the mask number). */
const ECC_FORMAT_BITS = 0;
/** Penalty weights of the mask evaluation. */
const N1 = 3;
const N2 = 3;
const N3 = 40;
const N4 = 10;

/** The module matrix (true = dark) without quiet zone, or null when the text is too long. */
export function qrMatrix(text: string): boolean[][] | null {
  const bytes = new TextEncoder().encode(text);
  let version = 0;
  for (let v = 1; v <= MAX_VERSION; v++) {
    const countBits = v < 10 ? 8 : 16;
    if (bytes.length < 2 ** countBits && 4 + countBits + bytes.length * 8 <= dataCodewords(v) * 8) {
      version = v;
      break;
    }
  }
  if (version === 0) return null;
  const qr = new Grid(version);
  qr.drawFunctionPatterns();
  qr.drawCodewords(addEccAndInterleave(dataBits(bytes, version), version));
  let best = 0;
  let bestPenalty = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask++) {
    qr.applyMask(mask);
    qr.drawFormatBits(mask);
    const penalty = qr.penalty();
    if (penalty < bestPenalty) {
      best = mask;
      bestPenalty = penalty;
    }
    qr.applyMask(mask);
  }
  qr.applyMask(best);
  qr.drawFormatBits(best);
  return qr.rows();
}

/**
 * An SVG path of the dark modules, one rectangle per horizontal run, offset by a light border of
 * `border` modules; `size` is the side of the whole code with the border, for the viewBox.
 */
export function qrSvgPath(matrix: boolean[][], border = 4): { size: number; d: string } {
  const parts: string[] = [];
  matrix.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (!row[x]) {
        x++;
        continue;
      }
      const start = x;
      while (row[x]) x++;
      parts.push(`M${start + border} ${y + border}h${x - start}v1h-${x - start}z`);
    }
  });
  return { size: matrix.length + border * 2, d: parts.join("") };
}

/** Modules left for data and error correction once the function patterns are drawn. */
function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    result -= (25 * align - 10) * align - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function dataCodewords(version: number): number {
  return (
    Math.floor(rawDataModules(version) / 8) - (ECC_PER_BLOCK[version] ?? 0) * (BLOCKS[version] ?? 0)
  );
}

/** The byte segment with terminator and padding, as data codewords. */
function dataBits(bytes: Uint8Array, version: number): number[] {
  const capacity = dataCodewords(version) * 8;
  const bits: number[] = [];
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, capacity - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | (bits[i + j] ?? 0);
    codewords.push(byte);
  }
  return codewords;
}

/** Splits the data into blocks, appends each block's error correction and interleaves them. */
function addEccAndInterleave(data: number[], version: number): number[] {
  const blockCount = BLOCKS[version] ?? 1;
  const eccLength = ECC_PER_BLOCK[version] ?? 0;
  const raw = Math.floor(rawDataModules(version) / 8);
  const shortBlocks = blockCount - (raw % blockCount);
  const shortLength = Math.floor(raw / blockCount);
  const divisor = rsDivisor(eccLength);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < blockCount; i++) {
    const block = data.slice(k, k + shortLength - eccLength + (i < shortBlocks ? 0 : 1));
    k += block.length;
    const ecc = rsRemainder(block, divisor);
    if (i < shortBlocks) block.push(0);
    blocks.push(block.concat(ecc));
  }
  const result: number[] = [];
  for (let i = 0; i <= shortLength; i++) {
    blocks.forEach((block, j) => {
      // The placeholder byte of a short block is skipped.
      if (i !== shortLength - eccLength || j >= shortBlocks) result.push(block[i] ?? 0);
    });
  }
  return result;
}

/** Multiplication in GF(256) modulo x^8 + x^4 + x^3 + x^2 + 1. */
function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

/** Coefficients of the Reed-Solomon generator polynomial of the given degree, highest first. */
function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j] ?? 0, root) ^ (j + 1 < degree ? (result[j + 1] ?? 0) : 0);
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ (result.shift() ?? 0);
    result.push(0);
    divisor.forEach((coef, i) => {
      result[i] = (result[i] ?? 0) ^ gfMul(coef, factor);
    });
  }
  return result;
}

function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

/** The module matrix being built: dark modules and which modules belong to function patterns. */
class Grid {
  readonly size: number;
  private readonly dark: Uint8Array;
  private readonly fixed: Uint8Array;

  constructor(readonly version: number) {
    this.size = version * 4 + 17;
    this.dark = new Uint8Array(this.size * this.size);
    this.fixed = new Uint8Array(this.size * this.size);
  }

  isDark(x: number, y: number): boolean {
    return this.dark[y * this.size + x] === 1;
  }

  private setFunction(x: number, y: number, dark: boolean): void {
    this.dark[y * this.size + x] = dark ? 1 : 0;
    this.fixed[y * this.size + x] = 1;
  }

  drawFunctionPatterns(): void {
    const size = this.size;
    for (let i = 0; i < size; i++) {
      this.setFunction(6, i, i % 2 === 0);
      this.setFunction(i, 6, i % 2 === 0);
    }
    this.drawFinder(3, 3);
    this.drawFinder(size - 4, 3);
    this.drawFinder(3, size - 4);
    const positions = this.alignmentPositions();
    const last = positions.length - 1;
    positions.forEach((py, i) => {
      positions.forEach((px, j) => {
        // The three corners taken by finder patterns get none.
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            this.setFunction(px + dx, py + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
          }
        }
      });
    });
    this.drawFormatBits(0);
    this.drawVersion();
  }

  /** A finder pattern with its separator, clipped at the edges. */
  private drawFinder(x: number, y: number): void {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) {
          this.setFunction(xx, yy, dist !== 2 && dist !== 4);
        }
      }
    }
  }

  private alignmentPositions(): number[] {
    if (this.version === 1) return [];
    const count = Math.floor(this.version / 7) + 2;
    const step = Math.floor((this.version * 8 + count * 3 + 5) / (count * 4 - 4)) * 2;
    const result = [6];
    for (let pos = this.size - 7; result.length < count; pos -= step) result.splice(1, 0, pos);
    return result;
  }

  /** Both copies of the format information: level and mask, BCH-protected and masked. */
  drawFormatBits(mask: number): void {
    const data = (ECC_FORMAT_BITS << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i: number) => ((bits >>> i) & 1) === 1;
    const size = this.size;
    for (let i = 0; i <= 5; i++) this.setFunction(8, i, bit(i));
    this.setFunction(8, 7, bit(6));
    this.setFunction(8, 8, bit(7));
    this.setFunction(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.setFunction(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.setFunction(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.setFunction(8, size - 15 + i, bit(i));
    // The dark module.
    this.setFunction(8, size - 8, true);
  }

  /** Both copies of the version information, versions 7 and up. */
  private drawVersion(): void {
    if (this.version < 7) return;
    let rem = this.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (this.version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.setFunction(a, b, dark);
      this.setFunction(b, a, dark);
    }
  }

  /** Places the codewords in the zigzag order, two columns at a time from the bottom right. */
  drawCodewords(codewords: number[]): void {
    const size = this.size;
    const total = codewords.length * 8;
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      const upward = ((right + 1) & 2) === 0;
      for (let vert = 0; vert < size; vert++) {
        const y = upward ? size - 1 - vert : vert;
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const at = y * size + x;
          if (this.fixed[at] === 0 && i < total) {
            this.dark[at] = ((codewords[i >>> 3] ?? 0) >>> (7 - (i & 7))) & 1;
            i++;
          }
        }
      }
    }
  }

  /** XORs a mask over the data modules; applying it twice undoes it. */
  applyMask(mask: number): void {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        const at = y * this.size + x;
        if (this.fixed[at] === 0 && maskBit(mask, x, y)) this.dark[at] = (this.dark[at] ?? 0) ^ 1;
      }
    }
  }

  /** The standard penalty of the matrix: runs, 2x2 blocks, finder-like patterns, dark balance. */
  penalty(): number {
    const size = this.size;
    let result = 0;
    for (let line = 0; line < size; line++) {
      result += this.linePenalty((i) => this.isDark(i, line));
      result += this.linePenalty((i) => this.isDark(line, i));
    }
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const c = this.isDark(x, y);
        const same =
          c === this.isDark(x + 1, y) &&
          c === this.isDark(x, y + 1) &&
          c === this.isDark(x + 1, y + 1);
        if (same) result += N2;
      }
    }
    let dark = 0;
    for (const m of this.dark) dark += m;
    const total = size * size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    return result + k * N4;
  }

  /** Penalty of one row or column: long runs and 1:1:3:1:1 patterns with light space beside them. */
  private linePenalty(at: (i: number) => boolean): number {
    const size = this.size;
    let result = 0;
    let runColor = false;
    let run = 0;
    const history = [0, 0, 0, 0, 0, 0, 0];
    const addHistory = (length: number) => {
      // The light border counts towards the first run.
      const first = history[0] === 0 ? length + size : length;
      history.pop();
      history.unshift(first);
    };
    const countPatterns = (): number => {
      const [h0 = 0, n = 0, h2 = 0, h3 = 0, h4 = 0, h5 = 0, h6 = 0] = history;
      const core = n > 0 && h2 === n && h3 === n * 3 && h4 === n && h5 === n;
      return (core && h0 >= n * 4 && h6 >= n ? 1 : 0) + (core && h6 >= n * 4 && h0 >= n ? 1 : 0);
    };
    for (let i = 0; i < size; i++) {
      const color = at(i);
      if (color === runColor) {
        run++;
        if (run === 5) result += N1;
        else if (run > 5) result++;
      } else {
        addHistory(run);
        if (!runColor) result += countPatterns() * N3;
        runColor = color;
        run = 1;
      }
    }
    // Ends the line with the light border.
    if (runColor) {
      addHistory(run);
      run = 0;
    }
    addHistory(run + size);
    return result + countPatterns() * N3;
  }

  rows(): boolean[][] {
    return Array.from({ length: this.size }, (_, y) =>
      Array.from({ length: this.size }, (_, x) => this.isDark(x, y)),
    );
  }
}
