/**
 * Minimal QR Code encoder for the offline pairing card.
 *
 * Ported to TypeScript/ESM from the encoder vendored by the system package
 * `qrcode-terminal` under /usr/share/nodejs/qrcode-terminal/vendor/QRCode
 * (original: "QRCode for JavaScript", Copyright (c) 2009 Kazuhiko Arase,
 * URL: http://www.d-project.com/, MIT licensed).  Only module syntax and types
 * changed; the encoding algorithm and its tables are unchanged, so a pairing
 * URL yields exactly the same matrix as the reference implementation.
 *
 * "QR Code" is a registered trademark of DENSO WAVE INCORPORATED
 * (http://www.denso-wave.com/qrcode/faqpatent-e.html).
 */

export const QrErrorCorrectLevel = { L: 1, M: 0, Q: 3, H: 2 } as const;
export type QrErrorCorrectLevel = (typeof QrErrorCorrectLevel)[keyof typeof QrErrorCorrectLevel];

export interface QrCode {
  readonly moduleCount: number;
  isDark(row: number, col: number): boolean;
}

const QRMode = {
  MODE_NUMBER: 1 << 0,
  MODE_ALPHA_NUM: 1 << 1,
  MODE_8BIT_BYTE: 1 << 2,
  MODE_KANJI: 1 << 3,
} as const;

const QRMaskPattern = {
  PATTERN000: 0,
  PATTERN001: 1,
  PATTERN010: 2,
  PATTERN011: 3,
  PATTERN100: 4,
  PATTERN101: 5,
  PATTERN110: 6,
  PATTERN111: 7,
} as const;

/* ------------------------------------------------------------------ */
/* GF(256) arithmetic used by the Reed-Solomon error correction.      */
/* ------------------------------------------------------------------ */

const EXP_TABLE: number[] = new Array<number>(256).fill(0);
const LOG_TABLE: number[] = new Array<number>(256).fill(0);
for (let i = 0; i < 8; i++) EXP_TABLE[i] = 1 << i;
for (let i = 8; i < 256; i++) {
  EXP_TABLE[i] = EXP_TABLE[i - 4]! ^ EXP_TABLE[i - 5]! ^ EXP_TABLE[i - 6]! ^ EXP_TABLE[i - 8]!;
}
for (let i = 0; i < 255; i++) LOG_TABLE[EXP_TABLE[i]!] = i;

function glog(n: number): number {
  if (n < 1) throw new Error(`glog(${n})`);
  return LOG_TABLE[n]!;
}

function gexp(n: number): number {
  let value = n;
  while (value < 0) value += 255;
  while (value >= 256) value -= 255;
  return EXP_TABLE[value]!;
}

class QRPolynomial {
  readonly num: number[];

  constructor(num: number[], shift: number) {
    let offset = 0;
    while (offset < num.length && num[offset] === 0) offset++;
    this.num = new Array<number>(num.length - offset + shift).fill(0);
    for (let i = 0; i < num.length - offset; i++) this.num[i] = num[i + offset]!;
  }

  get(index: number): number | undefined {
    return this.num[index];
  }

  getLength(): number {
    return this.num.length;
  }

  multiply(e: QRPolynomial): QRPolynomial {
    const num = new Array<number>(this.getLength() + e.getLength() - 1).fill(0);
    for (let i = 0; i < this.getLength(); i++) {
      for (let j = 0; j < e.getLength(); j++) {
        num[i + j]! ^= gexp(glog(this.get(i)!) + glog(e.get(j)!));
      }
    }
    return new QRPolynomial(num, 0);
  }

  mod(e: QRPolynomial): QRPolynomial {
    if (this.getLength() - e.getLength() < 0) return this;
    const ratio = glog(this.get(0)!) - glog(e.get(0)!);
    const num = this.num.slice();
    for (let x = 0; x < e.getLength(); x++) {
      num[x]! ^= gexp(glog(e.get(x)!) + ratio);
    }
    return new QRPolynomial(num, 0).mod(e);
  }
}

class QRBitBuffer {
  readonly buffer: number[] = [];
  length = 0;

  get(index: number): boolean {
    const bufIndex = Math.floor(index / 8);
    return ((this.buffer[bufIndex]! >>> (7 - (index % 8))) & 1) === 1;
  }

  put(num: number, length: number): void {
    for (let i = 0; i < length; i++) {
      this.putBit(((num >>> (length - i - 1)) & 1) === 1);
    }
  }

  getLengthInBits(): number {
    return this.length;
  }

  putBit(bit: boolean): void {
    const bufIndex = Math.floor(this.length / 8);
    if (this.buffer.length <= bufIndex) this.buffer.push(0);
    if (bit) this.buffer[bufIndex]! |= 0x80 >>> (this.length % 8);
    this.length++;
  }
}

class QR8bitByte {
  readonly mode: number = QRMode.MODE_8BIT_BYTE;
  readonly data: string;

  constructor(data: string) {
    this.data = data;
  }

  getLength(): number {
    return this.data.length;
  }

  write(buffer: QRBitBuffer): void {
    for (let i = 0; i < this.data.length; i++) {
      buffer.put(this.data.charCodeAt(i), 8);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Reed-Solomon block layout per (version, error correction level).   */
/* Row order: L, M, Q, H for versions 1..40.  Triples are              */
/* [blockCount, totalCodewords, dataCodewords].                        */
/* ------------------------------------------------------------------ */

class QRRSBlock {
  readonly totalCount: number;
  readonly dataCount: number;

  constructor(totalCount: number, dataCount: number) {
    this.totalCount = totalCount;
    this.dataCount = dataCount;
  }
}

const RS_BLOCK_TABLE: number[][] = [
	[1, 26, 19],
	[1, 26, 16],
	[1, 26, 13],
	[1, 26, 9],
	
	[1, 44, 34],
	[1, 44, 28],
	[1, 44, 22],
	[1, 44, 16],
	[1, 70, 55],
	[1, 70, 44],
	[2, 35, 17],
	[2, 35, 13],
	[1, 100, 80],
	[2, 50, 32],
	[2, 50, 24],
	[4, 25, 9],
	
	[1, 134, 108],
	[2, 67, 43],
	[2, 33, 15, 2, 34, 16],
	[2, 33, 11, 2, 34, 12],
	
	[2, 86, 68],
	[4, 43, 27],
	[4, 43, 19],
	[4, 43, 15],
	
	[2, 98, 78],
	[4, 49, 31],
	[2, 32, 14, 4, 33, 15],
	[4, 39, 13, 1, 40, 14],
	
	[2, 121, 97],
	[2, 60, 38, 2, 61, 39],
	[4, 40, 18, 2, 41, 19],
	[4, 40, 14, 2, 41, 15],
	
	[2, 146, 116],
	[3, 58, 36, 2, 59, 37],
	[4, 36, 16, 4, 37, 17],
	[4, 36, 12, 4, 37, 13],
	
	[2, 86, 68, 2, 87, 69],
	[4, 69, 43, 1, 70, 44],
	[6, 43, 19, 2, 44, 20],
	[6, 43, 15, 2, 44, 16],
	[4, 101, 81],
	[1, 80, 50, 4, 81, 51],
	[4, 50, 22, 4, 51, 23],
	[3, 36, 12, 8, 37, 13],
	[2, 116, 92, 2, 117, 93],
	[6, 58, 36, 2, 59, 37],
	[4, 46, 20, 6, 47, 21],
	[7, 42, 14, 4, 43, 15],
	[4, 133, 107],
	[8, 59, 37, 1, 60, 38],
	[8, 44, 20, 4, 45, 21],
	[12, 33, 11, 4, 34, 12],
	[3, 145, 115, 1, 146, 116],
	[4, 64, 40, 5, 65, 41],
	[11, 36, 16, 5, 37, 17],
	[11, 36, 12, 5, 37, 13],
	[5, 109, 87, 1, 110, 88],
	[5, 65, 41, 5, 66, 42],
	[5, 54, 24, 7, 55, 25],
	[11, 36, 12],
	[5, 122, 98, 1, 123, 99],
	[7, 73, 45, 3, 74, 46],
	[15, 43, 19, 2, 44, 20],
	[3, 45, 15, 13, 46, 16],
	[1, 135, 107, 5, 136, 108],
	[10, 74, 46, 1, 75, 47],
	[1, 50, 22, 15, 51, 23],
	[2, 42, 14, 17, 43, 15],
	[5, 150, 120, 1, 151, 121],
	[9, 69, 43, 4, 70, 44],
	[17, 50, 22, 1, 51, 23],
	[2, 42, 14, 19, 43, 15],
	[3, 141, 113, 4, 142, 114],
	[3, 70, 44, 11, 71, 45],
	[17, 47, 21, 4, 48, 22],
	[9, 39, 13, 16, 40, 14],
	[3, 135, 107, 5, 136, 108],
	[3, 67, 41, 13, 68, 42],
	[15, 54, 24, 5, 55, 25],
	[15, 43, 15, 10, 44, 16],
	[4, 144, 116, 4, 145, 117],
	[17, 68, 42],
	[17, 50, 22, 6, 51, 23],
	[19, 46, 16, 6, 47, 17],
	[2, 139, 111, 7, 140, 112],
	[17, 74, 46],
	[7, 54, 24, 16, 55, 25],
	[34, 37, 13],
	[4, 151, 121, 5, 152, 122],
	[4, 75, 47, 14, 76, 48],
	[11, 54, 24, 14, 55, 25],
	[16, 45, 15, 14, 46, 16],
	[6, 147, 117, 4, 148, 118],
	[6, 73, 45, 14, 74, 46],
	[11, 54, 24, 16, 55, 25],
	[30, 46, 16, 2, 47, 17],
	[8, 132, 106, 4, 133, 107],
	[8, 75, 47, 13, 76, 48],
	[7, 54, 24, 22, 55, 25],
	[22, 45, 15, 13, 46, 16],
	[10, 142, 114, 2, 143, 115],
	[19, 74, 46, 4, 75, 47],
	[28, 50, 22, 6, 51, 23],
	[33, 46, 16, 4, 47, 17],
	[8, 152, 122, 4, 153, 123],
	[22, 73, 45, 3, 74, 46],
	[8, 53, 23, 26, 54, 24],
	[12, 45, 15, 28, 46, 16],
	[3, 147, 117, 10, 148, 118],
	[3, 73, 45, 23, 74, 46],
	[4, 54, 24, 31, 55, 25],
	[11, 45, 15, 31, 46, 16],
	[7, 146, 116, 7, 147, 117],
	[21, 73, 45, 7, 74, 46],
	[1, 53, 23, 37, 54, 24],
	[19, 45, 15, 26, 46, 16],
	[5, 145, 115, 10, 146, 116],
	[19, 75, 47, 10, 76, 48],
	[15, 54, 24, 25, 55, 25],
	[23, 45, 15, 25, 46, 16],
	[13, 145, 115, 3, 146, 116],
	[2, 74, 46, 29, 75, 47],
	[42, 54, 24, 1, 55, 25],
	[23, 45, 15, 28, 46, 16],
	[17, 145, 115],
	[10, 74, 46, 23, 75, 47],
	[10, 54, 24, 35, 55, 25],
	[19, 45, 15, 35, 46, 16],
	[17, 145, 115, 1, 146, 116],
	[14, 74, 46, 21, 75, 47],
	[29, 54, 24, 19, 55, 25],
	[11, 45, 15, 46, 46, 16],
	[13, 145, 115, 6, 146, 116],
	[14, 74, 46, 23, 75, 47],
	[44, 54, 24, 7, 55, 25],
	[59, 46, 16, 1, 47, 17],
	[12, 151, 121, 7, 152, 122],
	[12, 75, 47, 26, 76, 48],
	[39, 54, 24, 14, 55, 25],
	[22, 45, 15, 41, 46, 16],
	[6, 151, 121, 14, 152, 122],
	[6, 75, 47, 34, 76, 48],
	[46, 54, 24, 10, 55, 25],
	[2, 45, 15, 64, 46, 16],
	[17, 152, 122, 4, 153, 123],
	[29, 74, 46, 14, 75, 47],
	[49, 54, 24, 10, 55, 25],
	[24, 45, 15, 46, 46, 16],
	[4, 152, 122, 18, 153, 123],
	[13, 74, 46, 32, 75, 47],
	[48, 54, 24, 14, 55, 25],
	[42, 45, 15, 32, 46, 16],
	[20, 147, 117, 4, 148, 118],
	[40, 75, 47, 7, 76, 48],
	[43, 54, 24, 22, 55, 25],
	[10, 45, 15, 67, 46, 16],
	[19, 148, 118, 6, 149, 119],
	[18, 75, 47, 31, 76, 48],
	[34, 54, 24, 34, 55, 25],
	[20, 45, 15, 61, 46, 16]
];;

function getRsBlockTable(typeNumber: number, errorCorrectLevel: number): number[] | undefined {
  const row = (typeNumber - 1) * 4;
  switch (errorCorrectLevel) {
    case QrErrorCorrectLevel.L:
      return RS_BLOCK_TABLE[row + 0];
    case QrErrorCorrectLevel.M:
      return RS_BLOCK_TABLE[row + 1];
    case QrErrorCorrectLevel.Q:
      return RS_BLOCK_TABLE[row + 2];
    case QrErrorCorrectLevel.H:
      return RS_BLOCK_TABLE[row + 3];
    default:
      return undefined;
  }
}

function getRSBlocks(typeNumber: number, errorCorrectLevel: number): QRRSBlock[] {
  const rsBlock = getRsBlockTable(typeNumber, errorCorrectLevel);
  if (rsBlock === undefined) {
    throw new Error(`bad rs block @ typeNumber:${typeNumber}/errorCorrectLevel:${errorCorrectLevel}`);
  }
  const list: QRRSBlock[] = [];
  for (let i = 0; i < rsBlock.length / 3; i++) {
    const count = rsBlock[i * 3 + 0]!;
    const totalCount = rsBlock[i * 3 + 1]!;
    const dataCount = rsBlock[i * 3 + 2]!;
    for (let j = 0; j < count; j++) list.push(new QRRSBlock(totalCount, dataCount));
  }
  return list;
}

/* ------------------------------------------------------------------ */
/* Format / version bit patterns, masking and penalty scoring.        */
/* ------------------------------------------------------------------ */

const QRUtil = {
  PATTERN_POSITION_TABLE: [
    [],
    [6, 18],
    [6, 22],
    [6, 26],
    [6, 30],
    [6, 34],
    [6, 22, 38],
    [6, 24, 42],
    [6, 26, 46],
    [6, 28, 50],
    [6, 30, 54],
    [6, 32, 58],
    [6, 34, 62],
    [6, 26, 46, 66],
    [6, 26, 48, 70],
    [6, 26, 50, 74],
    [6, 30, 54, 78],
    [6, 30, 56, 82],
    [6, 30, 58, 86],
    [6, 34, 62, 90],
    [6, 28, 50, 72, 94],
    [6, 26, 50, 74, 98],
    [6, 30, 54, 78, 102],
    [6, 28, 54, 80, 106],
    [6, 32, 58, 84, 110],
    [6, 30, 58, 86, 114],
    [6, 34, 62, 90, 118],
    [6, 26, 50, 74, 98, 122],
    [6, 30, 54, 78, 102, 126],
    [6, 26, 52, 78, 104, 130],
    [6, 30, 56, 82, 108, 134],
    [6, 34, 60, 86, 112, 138],
    [6, 30, 58, 86, 114, 142],
    [6, 34, 62, 90, 118, 146],
    [6, 30, 54, 78, 102, 126, 150],
    [6, 24, 50, 76, 102, 128, 154],
    [6, 28, 54, 80, 106, 132, 158],
    [6, 32, 58, 84, 110, 136, 162],
    [6, 26, 54, 82, 110, 138, 166],
    [6, 30, 58, 86, 114, 142, 170],
  ] as number[][],

  G15: (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | (1 << 0),
  G18: (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | (1 << 0),
  G15_MASK: (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1),

  getBCHTypeInfo(data: number): number {
    let d = data << 10;
    while (QRUtil.getBCHDigit(d) - QRUtil.getBCHDigit(QRUtil.G15) >= 0) {
      d ^= QRUtil.G15 << (QRUtil.getBCHDigit(d) - QRUtil.getBCHDigit(QRUtil.G15));
    }
    return ((data << 10) | d) ^ QRUtil.G15_MASK;
  },

  getBCHTypeNumber(data: number): number {
    let d = data << 12;
    while (QRUtil.getBCHDigit(d) - QRUtil.getBCHDigit(QRUtil.G18) >= 0) {
      d ^= QRUtil.G18 << (QRUtil.getBCHDigit(d) - QRUtil.getBCHDigit(QRUtil.G18));
    }
    return (data << 12) | d;
  },

  getBCHDigit(data: number): number {
    let digit = 0;
    let value = data;
    while (value !== 0) {
      digit++;
      value >>>= 1;
    }
    return digit;
  },

  getPatternPosition(typeNumber: number): number[] {
    return QRUtil.PATTERN_POSITION_TABLE[typeNumber - 1]!;
  },

  getMask(maskPattern: number, i: number, j: number): boolean {
    switch (maskPattern) {
      case QRMaskPattern.PATTERN000:
        return (i + j) % 2 === 0;
      case QRMaskPattern.PATTERN001:
        return i % 2 === 0;
      case QRMaskPattern.PATTERN010:
        return j % 3 === 0;
      case QRMaskPattern.PATTERN011:
        return (i + j) % 3 === 0;
      case QRMaskPattern.PATTERN100:
        return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0;
      case QRMaskPattern.PATTERN101:
        return ((i * j) % 2) + ((i * j) % 3) === 0;
      case QRMaskPattern.PATTERN110:
        return (((i * j) % 2) + ((i * j) % 3)) % 2 === 0;
      case QRMaskPattern.PATTERN111:
        return (((i * j) % 3) + ((i + j) % 2)) % 2 === 0;
      default:
        throw new Error(`bad maskPattern:${maskPattern}`);
    }
  },

  getErrorCorrectPolynomial(errorCorrectLength: number): QRPolynomial {
    let a = new QRPolynomial([1], 0);
    for (let i = 0; i < errorCorrectLength; i++) {
      a = a.multiply(new QRPolynomial([1, gexp(i)], 0));
    }
    return a;
  },

  getLengthInBits(mode: number, type: number): number {
    if (type >= 1 && type < 10) {
      switch (mode) {
        case QRMode.MODE_NUMBER:
          return 10;
        case QRMode.MODE_ALPHA_NUM:
          return 9;
        case QRMode.MODE_8BIT_BYTE:
          return 8;
        case QRMode.MODE_KANJI:
          return 8;
        default:
          throw new Error(`mode:${mode}`);
      }
    }
    if (type < 27) {
      switch (mode) {
        case QRMode.MODE_NUMBER:
          return 12;
        case QRMode.MODE_ALPHA_NUM:
          return 11;
        case QRMode.MODE_8BIT_BYTE:
          return 16;
        case QRMode.MODE_KANJI:
          return 10;
        default:
          throw new Error(`mode:${mode}`);
      }
    }
    if (type < 41) {
      switch (mode) {
        case QRMode.MODE_NUMBER:
          return 14;
        case QRMode.MODE_ALPHA_NUM:
          return 13;
        case QRMode.MODE_8BIT_BYTE:
          return 16;
        case QRMode.MODE_KANJI:
          return 12;
        default:
          throw new Error(`mode:${mode}`);
      }
    }
    throw new Error(`type:${type}`);
  },

  getLostPoint(qrCode: QrCode): number {
    const moduleCount = qrCode.moduleCount;
    let lostPoint = 0;

    // LEVEL1: adjacent same-colour modules.
    for (let row = 0; row < moduleCount; row++) {
      for (let col = 0; col < moduleCount; col++) {
        let sameCount = 0;
        const dark = qrCode.isDark(row, col);
        for (let r = -1; r <= 1; r++) {
          if (row + r < 0 || moduleCount <= row + r) continue;
          for (let c = -1; c <= 1; c++) {
            if (col + c < 0 || moduleCount <= col + c) continue;
            if (r === 0 && c === 0) continue;
            if (dark === qrCode.isDark(row + r, col + c)) sameCount++;
          }
        }
        if (sameCount > 5) lostPoint += 3 + sameCount - 5;
      }
    }

    // LEVEL2: 2x2 blocks.
    for (let row = 0; row < moduleCount - 1; row++) {
      for (let col = 0; col < moduleCount - 1; col++) {
        let count = 0;
        if (qrCode.isDark(row, col)) count++;
        if (qrCode.isDark(row + 1, col)) count++;
        if (qrCode.isDark(row, col + 1)) count++;
        if (qrCode.isDark(row + 1, col + 1)) count++;
        if (count === 0 || count === 4) lostPoint += 3;
      }
    }

    // LEVEL3: finder-like runs.
    for (let row = 0; row < moduleCount; row++) {
      for (let col = 0; col < moduleCount - 6; col++) {
        if (
          qrCode.isDark(row, col) &&
          !qrCode.isDark(row, col + 1) &&
          qrCode.isDark(row, col + 2) &&
          qrCode.isDark(row, col + 3) &&
          qrCode.isDark(row, col + 4) &&
          !qrCode.isDark(row, col + 5) &&
          qrCode.isDark(row, col + 6)
        ) {
          lostPoint += 40;
        }
      }
    }
    for (let col = 0; col < moduleCount; col++) {
      for (let row = 0; row < moduleCount - 6; row++) {
        if (
          qrCode.isDark(row, col) &&
          !qrCode.isDark(row + 1, col) &&
          qrCode.isDark(row + 2, col) &&
          qrCode.isDark(row + 3, col) &&
          qrCode.isDark(row + 4, col) &&
          !qrCode.isDark(row + 5, col) &&
          qrCode.isDark(row + 6, col)
        ) {
          lostPoint += 40;
        }
      }
    }

    // LEVEL4: dark module ratio.
    let darkCount = 0;
    for (let col = 0; col < moduleCount; col++) {
      for (let row = 0; row < moduleCount; row++) {
        if (qrCode.isDark(row, col)) darkCount++;
      }
    }
    const ratio = Math.abs((100 * darkCount) / moduleCount / moduleCount - 50) / 5;
    lostPoint += ratio * 10;
    return lostPoint;
  },
};

/* ------------------------------------------------------------------ */
/* Encoder.                                                           */
/* ------------------------------------------------------------------ */

const PAD0 = 0xec;
const PAD1 = 0x11;

function createData(typeNumber: number, errorCorrectLevel: number, dataList: QR8bitByte[]): number[] {
  const rsBlocks = getRSBlocks(typeNumber, errorCorrectLevel);
  const buffer = new QRBitBuffer();
  for (const data of dataList) {
    buffer.put(data.mode, 4);
    buffer.put(data.getLength(), QRUtil.getLengthInBits(data.mode, typeNumber));
    data.write(buffer);
  }
  let totalDataCount = 0;
  for (const block of rsBlocks) totalDataCount += block.dataCount;
  if (buffer.getLengthInBits() > totalDataCount * 8) {
    throw new Error(`code length overflow. (${buffer.getLengthInBits()}>${totalDataCount * 8})`);
  }
  if (buffer.getLengthInBits() + 4 <= totalDataCount * 8) buffer.put(0, 4);
  while (buffer.getLengthInBits() % 8 !== 0) buffer.putBit(false);
  for (;;) {
    if (buffer.getLengthInBits() >= totalDataCount * 8) break;
    buffer.put(PAD0, 8);
    if (buffer.getLengthInBits() >= totalDataCount * 8) break;
    buffer.put(PAD1, 8);
  }
  return createBytes(buffer, rsBlocks);
}

function createBytes(buffer: QRBitBuffer, rsBlocks: QRRSBlock[]): number[] {
  let offset = 0;
  let maxDcCount = 0;
  let maxEcCount = 0;
  const dcdata: number[][] = new Array<number[]>(rsBlocks.length);
  const ecdata: number[][] = new Array<number[]>(rsBlocks.length);

  for (let r = 0; r < rsBlocks.length; r++) {
    const block = rsBlocks[r]!;
    const dcCount = block.dataCount;
    const ecCount = block.totalCount - dcCount;
    maxDcCount = Math.max(maxDcCount, dcCount);
    maxEcCount = Math.max(maxEcCount, ecCount);
    dcdata[r] = new Array<number>(dcCount).fill(0);
    for (let i = 0; i < dcCount; i++) dcdata[r]![i] = 0xff & (buffer.buffer[i + offset] ?? 0);
    offset += dcCount;

    const rsPoly = QRUtil.getErrorCorrectPolynomial(ecCount);
    const rawPoly = new QRPolynomial(dcdata[r]!, rsPoly.getLength() - 1);
    const modPoly = rawPoly.mod(rsPoly);
    ecdata[r] = new Array<number>(rsPoly.getLength() - 1).fill(0);
    for (let x = 0; x < ecdata[r]!.length; x++) {
      const modIndex = x + modPoly.getLength() - ecdata[r]!.length;
      ecdata[r]![x] = modIndex >= 0 ? modPoly.get(modIndex) ?? 0 : 0;
    }
  }

  let totalCodeCount = 0;
  for (const block of rsBlocks) totalCodeCount += block.totalCount;
  const data = new Array<number>(totalCodeCount).fill(0);
  let index = 0;
  for (let z = 0; z < maxDcCount; z++) {
    for (let s = 0; s < rsBlocks.length; s++) {
      if (z < dcdata[s]!.length) data[index++] = dcdata[s]![z]!;
    }
  }
  for (let x = 0; x < maxEcCount; x++) {
    for (let s = 0; s < rsBlocks.length; s++) {
      if (x < ecdata[s]!.length) data[index++] = ecdata[s]![x]!;
    }
  }
  return data;
}

export class QRCode implements QrCode {
  typeNumber: number;
  errorCorrectLevel: number;
  private modules: (boolean | null)[][] | null = null;
  private moduleCountValue = 0;
  private dataCache: number[] | null = null;
  private readonly dataList: QR8bitByte[] = [];

  constructor(typeNumber: number, errorCorrectLevel: number) {
    this.typeNumber = typeNumber;
    this.errorCorrectLevel = errorCorrectLevel;
  }

  get moduleCount(): number {
    return this.moduleCountValue;
  }

  addData(data: string): void {
    this.dataList.push(new QR8bitByte(data));
    this.dataCache = null;
  }

  isDark(row: number, col: number): boolean {
    if (row < 0 || this.moduleCountValue <= row || col < 0 || this.moduleCountValue <= col) {
      throw new Error(`${row},${col}`);
    }
    return this.modules![row]![col] === true;
  }

  make(): void {
    if (this.typeNumber < 1) {
      let typeNumber = 1;
      for (; typeNumber < 40; typeNumber++) {
        const rsBlocks = getRSBlocks(typeNumber, this.errorCorrectLevel);
        const buffer = new QRBitBuffer();
        let totalDataCount = 0;
        for (const block of rsBlocks) totalDataCount += block.dataCount;
        for (const data of this.dataList) {
          buffer.put(data.mode, 4);
          buffer.put(data.getLength(), QRUtil.getLengthInBits(data.mode, typeNumber));
          data.write(buffer);
        }
        if (buffer.getLengthInBits() <= totalDataCount * 8) break;
      }
      this.typeNumber = typeNumber;
    }
    this.makeImpl(false, this.getBestMaskPattern());
  }

  private setModule(row: number, col: number, value: boolean): void {
    this.modules![row]![col] = value;
  }

  private makeImpl(test: boolean, maskPattern: number): void {
    this.moduleCountValue = this.typeNumber * 4 + 17;
    this.modules = Array.from({ length: this.moduleCountValue }, () =>
      new Array<boolean | null>(this.moduleCountValue).fill(null),
    );

    this.setupPositionProbePattern(0, 0);
    this.setupPositionProbePattern(this.moduleCountValue - 7, 0);
    this.setupPositionProbePattern(0, this.moduleCountValue - 7);
    this.setupPositionAdjustPattern();
    this.setupTimingPattern();
    this.setupTypeInfo(test, maskPattern);

    if (this.typeNumber >= 7) this.setupTypeNumber(test);

    if (this.dataCache === null) {
      this.dataCache = createData(this.typeNumber, this.errorCorrectLevel, this.dataList);
    }
    this.mapData(this.dataCache, maskPattern);
  }

  private setupPositionProbePattern(row: number, col: number): void {
    for (let r = -1; r <= 7; r++) {
      if (row + r <= -1 || this.moduleCountValue <= row + r) continue;
      for (let c = -1; c <= 7; c++) {
        if (col + c <= -1 || this.moduleCountValue <= col + c) continue;
        const dark =
          (0 <= r && r <= 6 && (c === 0 || c === 6)) ||
          (0 <= c && c <= 6 && (r === 0 || r === 6)) ||
          (2 <= r && r <= 4 && 2 <= c && c <= 4);
        this.setModule(row + r, col + c, dark);
      }
    }
  }

  private getBestMaskPattern(): number {
    let minLostPoint = 0;
    let pattern = 0;
    for (let i = 0; i < 8; i++) {
      this.makeImpl(true, i);
      const lostPoint = QRUtil.getLostPoint(this);
      if (i === 0 || minLostPoint > lostPoint) {
        minLostPoint = lostPoint;
        pattern = i;
      }
    }
    return pattern;
  }

  private setupTimingPattern(): void {
    for (let r = 8; r < this.moduleCountValue - 8; r++) {
      if (this.modules![r]![6] !== null) continue;
      this.setModule(r, 6, r % 2 === 0);
    }
    for (let c = 8; c < this.moduleCountValue - 8; c++) {
      if (this.modules![6]![c] !== null) continue;
      this.setModule(6, c, c % 2 === 0);
    }
  }

  private setupPositionAdjustPattern(): void {
    const pos = QRUtil.getPatternPosition(this.typeNumber);
    for (const row of pos) {
      for (const col of pos) {
        if (this.modules![row]![col] !== null) continue;
        for (let r = -2; r <= 2; r++) {
          for (let c = -2; c <= 2; c++) {
            const dark = Math.abs(r) === 2 || Math.abs(c) === 2 || (r === 0 && c === 0);
            this.setModule(row + r, col + c, dark);
          }
        }
      }
    }
  }

  private setupTypeNumber(test: boolean): void {
    const bits = QRUtil.getBCHTypeNumber(this.typeNumber);
    for (let i = 0; i < 18; i++) {
      const mod = !test && ((bits >> i) & 1) === 1;
      this.setModule(Math.floor(i / 3), (i % 3) + this.moduleCountValue - 8 - 3, mod);
    }
    for (let x = 0; x < 18; x++) {
      const mod = !test && ((bits >> x) & 1) === 1;
      this.setModule((x % 3) + this.moduleCountValue - 8 - 3, Math.floor(x / 3), mod);
    }
  }

  private setupTypeInfo(test: boolean, maskPattern: number): void {
    const data = (this.errorCorrectLevel << 3) | maskPattern;
    const bits = QRUtil.getBCHTypeInfo(data);

    // vertical
    for (let v = 0; v < 15; v++) {
      const mod = !test && ((bits >> v) & 1) === 1;
      if (v < 6) this.setModule(v, 8, mod);
      else if (v < 8) this.setModule(v + 1, 8, mod);
      else this.setModule(this.moduleCountValue - 15 + v, 8, mod);
    }

    // horizontal
    for (let h = 0; h < 15; h++) {
      const mod = !test && ((bits >> h) & 1) === 1;
      if (h < 8) this.setModule(8, this.moduleCountValue - h - 1, mod);
      else if (h < 9) this.setModule(8, 15 - h - 1 + 1, mod);
      else this.setModule(8, 15 - h - 1, mod);
    }

    // fixed module
    this.setModule(this.moduleCountValue - 8, 8, !test);
  }

  private mapData(data: number[], maskPattern: number): void {
    let inc = -1;
    let row = this.moduleCountValue - 1;
    let bitIndex = 7;
    let byteIndex = 0;

    for (let col = this.moduleCountValue - 1; col > 0; col -= 2) {
      if (col === 6) col--;
      for (;;) {
        for (let c = 0; c < 2; c++) {
          if (this.modules![row]![col - c] === null) {
            let dark = byteIndex < data.length ? ((data[byteIndex]! >>> bitIndex) & 1) === 1 : false;
            if (QRUtil.getMask(maskPattern, row, col - c)) dark = !dark;
            this.setModule(row, col - c, dark);
            bitIndex--;
            if (bitIndex === -1) {
              byteIndex++;
              bitIndex = 7;
            }
          }
        }
        row += inc;
        if (row < 0 || this.moduleCountValue <= row) {
          row -= inc;
          inc = -inc;
          break;
        }
      }
    }
  }
}

/**
 * Encode `text` and return the module matrix (`true` = dark module).
 * Error correction defaults to level M, which comfortably fits a pairing URL
 * (roughly 70 bytes) into a version 5 symbol.
 */
export function createQrMatrix(
  text: string,
  errorCorrectLevel: number = QrErrorCorrectLevel.M,
): boolean[][] {
  const qr = new QRCode(-1, errorCorrectLevel);
  qr.addData(text);
  qr.make();
  const count = qr.moduleCount;
  return Array.from({ length: count }, (_, row) =>
    Array.from({ length: count }, (_, col) => qr.isDark(row, col)),
  );
}
