import { Colors } from '../../common/util/colors.js';
import { ROArrayArray } from '../../common/util/types.js';
import { assert, objectEquals, TypedArrayBufferView, unreachable } from '../../common/util/util.js';
import { Float16Array } from '../../external/petamoriken/float16/float16.js';

import BinaryStream from './binary_stream.js';
import { kBit } from './constants.js';
import {
  align,
  cartesianProduct,
  clamp,
  correctlyRoundedF16,
  isFiniteF16,
  isSubnormalNumberF16,
  isSubnormalNumberF32,
  isSubnormalNumberF64,
} from './math.js';

/**
 * Encodes a JS `number` into a "normalized" (unorm/snorm) integer representation with `bits` bits.
 * Input must be between -1 and 1 if signed, or 0 and 1 if unsigned.
 *
 * MAINTENANCE_TODO: See if performance of texel_data improves if this function is pre-specialized
 * for a particular `bits`/`signed`.
 */
export function floatAsNormalizedInteger(float: number, bits: number, signed: boolean): number {
  if (signed) {
    assert(float >= -1 && float <= 1, () => `${float} out of bounds of snorm`);
    const max = Math.pow(2, bits - 1) - 1;
    return Math.round(float * max);
  } else {
    assert(float >= 0 && float <= 1, () => `${float} out of bounds of unorm`);
    const max = Math.pow(2, bits) - 1;
    return Math.round(float * max);
  }
}

/**
 * Decodes a JS `number` from a "normalized" (unorm/snorm) integer representation with `bits` bits.
 * Input must be an integer in the range of the specified unorm/snorm type.
 */
export function normalizedIntegerAsFloat(integer: number, bits: number, signed: boolean): number {
  assert(Number.isInteger(integer));
  if (signed) {
    const max = Math.pow(2, bits - 1) - 1;
    assert(integer >= -max - 1 && integer <= max);
    if (integer === -max - 1) {
      integer = -max;
    }
    return integer / max;
  } else {
    const max = Math.pow(2, bits) - 1;
    assert(integer >= 0 && integer <= max);
    return integer / max;
  }
}

/**
 * Compares 2 numbers. Returns true if their absolute value is
 * less than or equal to maxDiff or if they are both NaN or the
 * same sign infinity.
 */
export function numbersApproximatelyEqual(a: number, b: number, maxDiff: number = 0) {
  return (
    (Number.isNaN(a) && Number.isNaN(b)) ||
    (a === Number.POSITIVE_INFINITY && b === Number.POSITIVE_INFINITY) ||
    (a === Number.NEGATIVE_INFINITY && b === Number.NEGATIVE_INFINITY) ||
    Math.abs(a - b) <= maxDiff
  );
}

/**
 * Once-allocated ArrayBuffer/views to avoid overhead of allocation when converting between numeric formats
 *
 * workingData* is shared between multiple functions in this file, so to avoid re-entrancy problems, make sure in
 * functions that use it that they don't call themselves or other functions that use workingData*.
 */
const workingData = new ArrayBuffer(8);
const workingDataU32 = new Uint32Array(workingData);
const workingDataU16 = new Uint16Array(workingData);
const workingDataU8 = new Uint8Array(workingData);
const workingDataF32 = new Float32Array(workingData);
const workingDataF16 = new Float16Array(workingData);
const workingDataI16 = new Int16Array(workingData);
const workingDataI32 = new Int32Array(workingData);
const workingDataI8 = new Int8Array(workingData);
const workingDataF64 = new Float64Array(workingData);
const workingDataI64 = new BigInt64Array(workingData);
const workingDataU64 = new BigUint64Array(workingData);
const workingDataView = new DataView(workingData);

/**
 * Encodes a JS `number` into an IEEE754 floating point number with the specified number of
 * sign, exponent, mantissa bits, and exponent bias.
 * Returns the result as an integer-valued JS `number`.
 *
 * Does not handle clamping, overflow, or denormal inputs.
 * On underflow (result is subnormal), rounds to (signed) zero.
 *
 * MAINTENANCE_TODO: Replace usages of this with numberToFloatBits.
 */
export function float32ToFloatBits(
  n: number,
  signBits: 0 | 1,
  exponentBits: number,
  mantissaBits: number,
  bias: number
): number {
  assert(exponentBits <= 8);
  assert(mantissaBits <= 23);

  if (Number.isNaN(n)) {
    // NaN = all exponent bits true, 1 or more mantissia bits true
    return (((1 << exponentBits) - 1) << mantissaBits) | ((1 << mantissaBits) - 1);
  }

  workingDataView.setFloat32(0, n, true);
  const bits = workingDataView.getUint32(0, true);
  // bits (32): seeeeeeeefffffffffffffffffffffff

  // 0 or 1
  const sign = (bits >> 31) & signBits;

  if (n === 0) {
    if (sign === 1) {
      // Handle negative zero.
      return 1 << (exponentBits + mantissaBits);
    }
    return 0;
  }

  if (signBits === 0) {
    assert(n >= 0);
  }

  if (!Number.isFinite(n)) {
    // Infinity = all exponent bits true, no mantissa bits true
    // plus the sign bit.
    return (
      (((1 << exponentBits) - 1) << mantissaBits) | (n < 0 ? 2 ** (exponentBits + mantissaBits) : 0)
    );
  }

  const mantissaBitsToDiscard = 23 - mantissaBits;

  // >> to remove mantissa, & to remove sign, - 127 to remove bias.
  const exp = ((bits >> 23) & 0xff) - 127;

  // Convert to the new biased exponent.
  const newBiasedExp = bias + exp;
  assert(newBiasedExp < 1 << exponentBits, () => `input number ${n} overflows target type`);

  if (newBiasedExp <= 0) {
    // Result is subnormal or zero. Round to (signed) zero.
    return sign << (exponentBits + mantissaBits);
  } else {
    // Mask only the mantissa, and discard the lower bits.
    const newMantissa = (bits & 0x7fffff) >> mantissaBitsToDiscard;
    return (sign << (exponentBits + mantissaBits)) | (newBiasedExp << mantissaBits) | newMantissa;
  }
}

/**
 * Encodes a JS `number` into an IEEE754 16 bit floating point number.
 * Returns the result as an integer-valued JS `number`.
 *
 * Does not handle clamping, overflow, or denormal inputs.
 * On underflow (result is subnormal), rounds to (signed) zero.
 */
export function float32ToFloat16Bits(n: number) {
  return float32ToFloatBits(n, 1, 5, 10, 15);
}

/**
 * Decodes an IEEE754 16 bit floating point number into a JS `number` and returns.
 */
export function float16BitsToFloat32(float16Bits: number): number {
  return floatBitsToNumber(float16Bits, kFloat16Format);
}

type FloatFormat = { signed: 0 | 1; exponentBits: number; mantissaBits: number; bias: number };

/** FloatFormat defining IEEE754 32-bit float. */
export const kFloat32Format = { signed: 1, exponentBits: 8, mantissaBits: 23, bias: 127 } as const;
/** FloatFormat defining IEEE754 16-bit float. */
export const kFloat16Format = { signed: 1, exponentBits: 5, mantissaBits: 10, bias: 15 } as const;
/** FloatFormat for 9 bit mantissa, 5 bit exponent unsigned float */
export const kUFloat9e5Format = { signed: 0, exponentBits: 5, mantissaBits: 9, bias: 15 } as const;

/** Bitcast u32 (represented as integer Number) to f32 (represented as floating-point Number). */
export function float32BitsToNumber(bits: number): number {
  workingDataU32[0] = bits;
  return workingDataF32[0];
}
/** Bitcast f32 (represented as floating-point Number) to u32 (represented as integer Number). */
export function numberToFloat32Bits(number: number): number {
  workingDataF32[0] = number;
  return workingDataU32[0];
}

/**
 * Decodes an IEEE754 float with the supplied format specification into a JS number.
 *
 * The format MUST be no larger than a 32-bit float.
 */
export function floatBitsToNumber(bits: number, fmt: FloatFormat): number {
  // Pad the provided bits out to f32, then convert to a `number` with the wrong bias.
  // E.g. for f16 to f32:
  // - f16: S    EEEEE MMMMMMMMMM
  //        ^ 000^^^^^ ^^^^^^^^^^0000000000000
  // - f32: S eeeEEEEE MMMMMMMMMMmmmmmmmmmmmmm

  const kNonSignBits = fmt.exponentBits + fmt.mantissaBits;
  const kNonSignBitsMask = (1 << kNonSignBits) - 1;
  const exponentAndMantissaBits = bits & kNonSignBitsMask;
  const exponentMask = ((1 << fmt.exponentBits) - 1) << fmt.mantissaBits;
  const infinityOrNaN = (bits & exponentMask) === exponentMask;
  if (infinityOrNaN) {
    const mantissaMask = (1 << fmt.mantissaBits) - 1;
    const signBit = 2 ** kNonSignBits;
    const isNegative = (bits & signBit) !== 0;
    return bits & mantissaMask
      ? Number.NaN
      : isNegative
      ? Number.NEGATIVE_INFINITY
      : Number.POSITIVE_INFINITY;
  }
  let f32BitsWithWrongBias =
    exponentAndMantissaBits << (kFloat32Format.mantissaBits - fmt.mantissaBits);
  f32BitsWithWrongBias |= (bits << (31 - kNonSignBits)) & 0x8000_0000;
  const numberWithWrongBias = float32BitsToNumber(f32BitsWithWrongBias);
  return numberWithWrongBias * 2 ** (kFloat32Format.bias - fmt.bias);
}

/**
 * Convert ufloat9e5 bits from rgb9e5ufloat to a JS number
 *
 * The difference between `floatBitsToNumber` and `ufloatBitsToNumber`
 * is that the latter doesn't use an implicit leading bit:
 *
 * floatBitsToNumber      = 2^(exponent - bias) * (1 + mantissa / 2 ^ numMantissaBits)
 * ufloatM9E5BitsToNumber = 2^(exponent - bias) * (mantissa / 2 ^ numMantissaBits)
 *                        = 2^(exponent - bias - numMantissaBits) * mantissa
 */
export function ufloatM9E5BitsToNumber(bits: number, fmt: FloatFormat): number {
  const exponent = bits >> fmt.mantissaBits;
  const mantissaMask = (1 << fmt.mantissaBits) - 1;
  const mantissa = bits & mantissaMask;
  return mantissa * 2 ** (exponent - fmt.bias - fmt.mantissaBits);
}

/**
 * Encodes a JS `number` into an IEEE754 floating point number with the specified format.
 * Returns the result as an integer-valued JS `number`.
 *
 * Does not handle clamping, overflow, or denormal inputs.
 * On underflow (result is subnormal), rounds to (signed) zero.
 */
export function numberToFloatBits(number: number, fmt: FloatFormat): number {
  return float32ToFloatBits(number, fmt.signed, fmt.exponentBits, fmt.mantissaBits, fmt.bias);
}

/**
 * Given a floating point number (as an integer representing its bits), computes how many ULPs it is
 * from zero.
 *
 * Subnormal numbers are skipped, so that 0 is one ULP from the minimum normal number.
 * Subnormal values are flushed to 0.
 * Positive and negative 0 are both considered to be 0 ULPs from 0.
 */
export function floatBitsToNormalULPFromZero(bits: number, fmt: FloatFormat): number {
  const mask_sign = fmt.signed << (fmt.exponentBits + fmt.mantissaBits);
  const mask_expt = ((1 << fmt.exponentBits) - 1) << fmt.mantissaBits;
  const mask_mant = (1 << fmt.mantissaBits) - 1;
  const mask_rest = mask_expt | mask_mant;

  assert(fmt.exponentBits + fmt.mantissaBits <= 31);

  const sign = bits & mask_sign ? -1 : 1;
  const rest = bits & mask_rest;
  const subnormal_or_zero = (bits & mask_expt) === 0;
  const infinity_or_nan = (bits & mask_expt) === mask_expt;
  assert(!infinity_or_nan, 'no ulp representation for infinity/nan');

  // The first normal number is mask_mant+1, so subtract mask_mant to make min_normal - zero = 1ULP.
  const abs_ulp_from_zero = subnormal_or_zero ? 0 : rest - mask_mant;
  return sign * abs_ulp_from_zero;
}

/**
 * Encodes three JS `number` values into RGB9E5, returned as an integer-valued JS `number`.
 *
 * RGB9E5 represents three partial-precision floating-point numbers encoded into a single 32-bit
 * value all sharing the same 5-bit exponent.
 * There is no sign bit, and there is a shared 5-bit biased (15) exponent and a 9-bit
 * mantissa for each channel. The mantissa does NOT have an implicit leading "1.",
 * and instead has an implicit leading "0.".
 *
 * @see https://registry.khronos.org/OpenGL/extensions/EXT/EXT_texture_shared_exponent.txt
 */
export function packRGB9E5UFloat(r: number, g: number, b: number): number {
  const N = 9; // number of mantissa bits
  const Emax = 31; // max exponent
  const B = 15; // exponent bias
  const sharedexp_max = (((1 << N) - 1) / (1 << N)) * 2 ** (Emax - B);
  const red_c = clamp(r, { min: 0, max: sharedexp_max });
  const green_c = clamp(g, { min: 0, max: sharedexp_max });
  const blue_c = clamp(b, { min: 0, max: sharedexp_max });
  const max_c = Math.max(red_c, green_c, blue_c);
  const exp_shared_p = Math.max(-B - 1, Math.floor(Math.log2(max_c))) + 1 + B;
  const max_s = Math.floor(max_c / 2 ** (exp_shared_p - B - N) + 0.5);
  const exp_shared = max_s === 1 << N ? exp_shared_p + 1 : exp_shared_p;
  const scalar = 1 / 2 ** (exp_shared - B - N);
  const red_s = Math.floor(red_c * scalar + 0.5);
  const green_s = Math.floor(green_c * scalar + 0.5);
  const blue_s = Math.floor(blue_c * scalar + 0.5);
  assert(red_s >= 0 && red_s <= 0b111111111);
  assert(green_s >= 0 && green_s <= 0b111111111);
  assert(blue_s >= 0 && blue_s <= 0b111111111);
  assert(exp_shared >= 0 && exp_shared <= 0b11111);
  return ((exp_shared << 27) | (blue_s << 18) | (green_s << 9) | red_s) >>> 0;
}

/**
 * Decodes a RGB9E5 encoded color.
 * @see packRGB9E5UFloat
 */
export function unpackRGB9E5UFloat(encoded: number): { R: number; G: number; B: number } {
  const N = 9; // number of mantissa bits
  const B = 15; // exponent bias
  const red_s = (encoded >>> 0) & 0b111111111;
  const green_s = (encoded >>> 9) & 0b111111111;
  const blue_s = (encoded >>> 18) & 0b111111111;
  const exp_shared = (encoded >>> 27) & 0b11111;
  const exp = Math.pow(2, exp_shared - B - N);
  return {
    R: exp * red_s,
    G: exp * green_s,
    B: exp * blue_s,
  };
}

/**
 * Quantizes two f32s to f16 and then packs them in a u32
 *
 * This should implement the same behaviour as the builtin `pack2x16float` from
 * WGSL.
 *
 * Caller is responsible to ensuring inputs are f32s
 *
 * @param x first f32 to be packed
 * @param y second f32 to be packed
 * @returns an array of possible results for pack2x16float. Elements are either
 *          a number or undefined.
 *          undefined indicates that any value is valid, since the input went
 *          out of bounds.
 */
export function pack2x16float(x: number, y: number): (number | undefined)[] {
  // Generates all possible valid u16 bit fields for a given f32 to f16 conversion.
  // Assumes FTZ for both the f32 and f16 value is allowed.
  const generateU16s = (n: number): readonly number[] => {
    let contains_subnormals = isSubnormalNumberF32(n);
    const n_f16s = correctlyRoundedF16(n);
    contains_subnormals ||= n_f16s.some(isSubnormalNumberF16);

    const n_u16s = n_f16s.map(f16 => {
      workingDataF16[0] = f16;
      return workingDataU16[0];
    });

    const contains_poszero = n_u16s.some(u => u === kBit.f16.positive.zero);
    const contains_negzero = n_u16s.some(u => u === kBit.f16.negative.zero);
    if (!contains_negzero && (contains_poszero || contains_subnormals)) {
      n_u16s.push(kBit.f16.negative.zero);
    }

    if (!contains_poszero && (contains_negzero || contains_subnormals)) {
      n_u16s.push(kBit.f16.positive.zero);
    }

    return n_u16s;
  };

  if (!isFiniteF16(x) || !isFiniteF16(y)) {
    // This indicates any value is valid, so it isn't worth bothering
    // calculating the more restrictive possibilities.
    return [undefined];
  }

  const results = new Array<number>();
  for (const p of cartesianProduct(generateU16s(x), generateU16s(y))) {
    assert(p.length === 2, 'cartesianProduct of 2 arrays returned an entry with not 2 elements');
    workingDataU16[0] = p[0];
    workingDataU16[1] = p[1];
    results.push(workingDataU32[0]);
  }

  return results;
}

/**
 * Converts two normalized f32s to i16s and then packs them in a u32
 *
 * This should implement the same behaviour as the builtin `pack2x16snorm` from
 * WGSL.
 *
 * Caller is responsible to ensuring inputs are normalized f32s
 *
 * @param x first f32 to be packed
 * @param y second f32 to be packed
 * @returns a number that is expected result of pack2x16snorm.
 */
export function pack2x16snorm(x: number, y: number): number {
  // Converts f32 to i16 via the pack2x16snorm formula.
  // FTZ is not explicitly handled, because all subnormals will produce a value
  // between 0 and 1, but significantly away from the edges, so floor goes to 0.
  const generateI16 = (n: number): number => {
    return Math.floor(0.5 + 32767 * Math.min(1, Math.max(-1, n)));
  };

  workingDataI16[0] = generateI16(x);
  workingDataI16[1] = generateI16(y);

  return workingDataU32[0];
}

/**
 * Converts two normalized f32s to u16s and then packs them in a u32
 *
 * This should implement the same behaviour as the builtin `pack2x16unorm` from
 * WGSL.
 *
 * Caller is responsible to ensuring inputs are normalized f32s
 *
 * @param x first f32 to be packed
 * @param y second f32 to be packed
 * @returns an number that is expected result of pack2x16unorm.
 */
export function pack2x16unorm(x: number, y: number): number {
  // Converts f32 to u16 via the pack2x16unorm formula.
  // FTZ is not explicitly handled, because all subnormals will produce a value
  // between 0.5 and much less than 1, so floor goes to 0.
  const generateU16 = (n: number): number => {
    return Math.floor(0.5 + 65535 * Math.min(1, Math.max(0, n)));
  };

  workingDataU16[0] = generateU16(x);
  workingDataU16[1] = generateU16(y);

  return workingDataU32[0];
}

/**
 * Converts four normalized f32s to i8s and then packs them in a u32
 *
 * This should implement the same behaviour as the builtin `pack4x8snorm` from
 * WGSL.
 *
 * Caller is responsible to ensuring inputs are normalized f32s
 *
 * @param vals four f32s to be packed
 * @returns a number that is expected result of pack4x8usorm.
 */
export function pack4x8snorm(...vals: [number, number, number, number]): number {
  // Converts f32 to u8 via the pack4x8snorm formula.
  // FTZ is not explicitly handled, because all subnormals will produce a value
  // between 0 and 1, so floor goes to 0.
  const generateI8 = (n: number): number => {
    return Math.floor(0.5 + 127 * Math.min(1, Math.max(-1, n)));
  };

  for (const idx in vals) {
    workingDataI8[idx] = generateI8(vals[idx]);
  }

  return workingDataU32[0];
}

/**
 * Converts four normalized f32s to u8s and then packs them in a u32
 *
 * This should implement the same behaviour as the builtin `pack4x8unorm` from
 * WGSL.
 *
 * Caller is responsible to ensuring inputs are normalized f32s
 *
 * @param vals four f32s to be packed
 * @returns a number that is expected result of pack4x8unorm.
 */
export function pack4x8unorm(...vals: [number, number, number, number]): number {
  // Converts f32 to u8 via the pack4x8unorm formula.
  // FTZ is not explicitly handled, because all subnormals will produce a value
  // between 0.5 and much less than 1, so floor goes to 0.
  const generateU8 = (n: number): number => {
    return Math.floor(0.5 + 255 * Math.min(1, Math.max(0, n)));
  };

  for (const idx in vals) {
    workingDataU8[idx] = generateU8(vals[idx]);
  }

  return workingDataU32[0];
}

/**
 * Asserts that a number is within the representable (inclusive) of the integer type with the
 * specified number of bits and signedness.
 *
 * MAINTENANCE_TODO: Assert isInteger? Then this function "asserts that a number is representable"
 * by the type.
 */
export function assertInIntegerRange(n: number, bits: number, signed: boolean): void {
  if (signed) {
    const min = -Math.pow(2, bits - 1);
    const max = Math.pow(2, bits - 1) - 1;
    assert(n >= min && n <= max);
  } else {
    const max = Math.pow(2, bits) - 1;
    assert(n >= 0 && n <= max);
  }
}

/**
 * Converts a linear value into a "gamma"-encoded value using the sRGB-clamped transfer function.
 */
export function gammaCompress(n: number): number {
  n = n <= 0.0031308 ? (323 * n) / 25 : (211 * Math.pow(n, 5 / 12) - 11) / 200;
  return clamp(n, { min: 0, max: 1 });
}

/**
 * Converts a "gamma"-encoded value into a linear value using the sRGB-clamped transfer function.
 */
export function gammaDecompress(n: number): number {
  n = n <= 0.04045 ? (n * 25) / 323 : Math.pow((200 * n + 11) / 211, 12 / 5);
  return clamp(n, { min: 0, max: 1 });
}

/** Converts a 32-bit float value to a 32-bit unsigned integer value */
export function float32ToUint32(f32: number): number {
  workingDataF32[0] = f32;
  return workingDataU32[0];
}

/** Converts a 32-bit unsigned integer value to a 32-bit float value */
export function uint32ToFloat32(u32: number): number {
  workingDataU32[0] = u32;
  return workingDataF32[0];
}

/** Converts a 32-bit float value to a 32-bit signed integer value */
export function float32ToInt32(f32: number): number {
  workingDataF32[0] = f32;
  return workingDataI32[0];
}

/** Converts a 32-bit unsigned integer value to a 32-bit signed integer value */
export function uint32ToInt32(u32: number): number {
  workingDataU32[0] = u32;
  return workingDataI32[0];
}

/** Converts a 16-bit float value to a 16-bit unsigned integer value */
export function float16ToUint16(f16: number): number {
  workingDataF16[0] = f16;
  return workingDataU16[0];
}

/** Converts a 16-bit unsigned integer value to a 16-bit float value */
export function uint16ToFloat16(u16: number): number {
  workingDataU16[0] = u16;
  return workingDataF16[0];
}

/** Converts a 16-bit float value to a 16-bit signed integer value */
export function float16ToInt16(f16: number): number {
  workingDataF16[0] = f16;
  return workingDataI16[0];
}

/** A type of number representable by Scalar. */
export type ScalarKind =
  | 'abstract-float'
  | 'f64'
  | 'f32'
  | 'f16'
  | 'u32'
  | 'u16'
  | 'u8'
  | 'abstract-int'
  | 'i32'
  | 'i16'
  | 'i8'
  | 'bool';

/** ScalarType describes the type of WGSL Scalar. */
export class ScalarType {
  readonly kind: ScalarKind; // The named type
  readonly _size: number; // In bytes
  readonly read: (buf: Uint8Array, offset: number) => ScalarValue; // reads a scalar from a buffer

  constructor(
    kind: ScalarKind,
    size: number,
    read: (buf: Uint8Array, offset: number) => ScalarValue
  ) {
    this.kind = kind;
    this._size = size;
    this.read = read;
  }

  public toString(): string {
    return this.kind;
  }

  public get size(): number {
    return this._size;
  }

  public get alignment(): number {
    return this._size;
  }

  /** Constructs a ScalarValue of this type with `value` */
  public create(value: number | bigint): ScalarValue {
    switch (typeof value) {
      case 'number':
        switch (this.kind) {
          case 'abstract-float':
            return abstractFloat(value);
          case 'abstract-int':
            return abstractInt(BigInt(value));
          case 'f64':
            return f64(value);
          case 'f32':
            return f32(value);
          case 'f16':
            return f16(value);
          case 'u32':
            return u32(value);
          case 'u16':
            return u16(value);
          case 'u8':
            return u8(value);
          case 'i32':
            return i32(value);
          case 'i16':
            return i16(value);
          case 'i8':
            return i8(value);
          case 'bool':
            return bool(value !== 0);
        }
        break;
      case 'bigint':
        switch (this.kind) {
          case 'abstract-int':
            return abstractInt(value);
          case 'bool':
            return bool(value !== 0n);
        }
        break;
    }
    unreachable(`Scalar<${this.kind}>.create() does not support ${typeof value}`);
  }
}

/** VectorType describes the type of WGSL Vector. */
export class VectorType {
  readonly width: number; // Number of elements in the vector
  readonly elementType: ScalarType; // Element type

  // Maps a string representation of a vector type to vector type.
  private static instances = new Map<string, VectorType>();

  static create(width: number, elementType: ScalarType): VectorType {
    const key = `${elementType.toString()} ${width}}`;
    let ty = this.instances.get(key);
    if (ty !== undefined) {
      return ty;
    }
    ty = new VectorType(width, elementType);
    this.instances.set(key, ty);
    return ty;
  }

  constructor(width: number, elementType: ScalarType) {
    this.width = width;
    this.elementType = elementType;
  }

  /**
   * @returns a vector constructed from the values read from the buffer at the
   * given byte offset
   */
  public read(buf: Uint8Array, offset: number): VectorValue {
    const elements: Array<ScalarValue> = [];
    for (let i = 0; i < this.width; i++) {
      elements[i] = this.elementType.read(buf, offset);
      offset += this.elementType.size;
    }
    return new VectorValue(elements);
  }

  public toString(): string {
    return `vec${this.width}<${this.elementType}>`;
  }

  public get size(): number {
    return this.elementType.size * this.width;
  }

  public get alignment(): number {
    return VectorType.alignmentOf(this.width, this.elementType);
  }

  public static alignmentOf(width: number, elementType: ScalarType) {
    return elementType.size * (width === 3 ? 4 : width);
  }

  /** Constructs a Vector of this type with the given values */
  public create(value: (number | bigint) | readonly (number | bigint)[]): VectorValue {
    if (value instanceof Array) {
      assert(value.length === this.width);
    } else {
      value = Array(this.width).fill(value);
    }
    return new VectorValue(value.map(v => this.elementType.create(v)));
  }
}

/** MatrixType describes the type of WGSL Matrix. */
export class MatrixType {
  readonly cols: number; // Number of columns in the Matrix
  readonly rows: number; // Number of elements per column in the Matrix
  readonly elementType: ScalarType; // Element type

  // Maps a string representation of a Matrix type to Matrix type.
  private static instances = new Map<string, MatrixType>();

  static create(cols: number, rows: number, elementType: ScalarType): MatrixType {
    const key = `${elementType.toString()} ${cols} ${rows}`;
    let ty = this.instances.get(key);
    if (ty !== undefined) {
      return ty;
    }
    ty = new MatrixType(cols, rows, elementType);
    this.instances.set(key, ty);
    return ty;
  }

  constructor(cols: number, rows: number, elementType: ScalarType) {
    this.cols = cols;
    this.rows = rows;
    assert(
      elementType.kind === 'f32' ||
        elementType.kind === 'f16' ||
        elementType.kind === 'abstract-float',
      "MatrixType can only have elementType of 'f32' or 'f16' or 'abstract-float'"
    );
    this.elementType = elementType;
  }

  /**
   * @returns a Matrix constructed from the values read from the buffer at the
   * given byte offset
   */
  public read(buf: Uint8Array, offset: number): MatrixValue {
    const elements: ScalarValue[][] = [...Array(this.cols)].map(_ => [...Array(this.rows)]);
    for (let c = 0; c < this.cols; c++) {
      for (let r = 0; r < this.rows; r++) {
        elements[c][r] = this.elementType.read(buf, offset);
        offset += this.elementType.size;
      }

      // vec3 have one padding element, so need to skip in matrices
      if (this.rows === 3) {
        offset += this.elementType.size;
      }
    }
    return new MatrixValue(elements);
  }

  public toString(): string {
    return `mat${this.cols}x${this.rows}<${this.elementType}>`;
  }

  public get size(): number {
    return VectorType.alignmentOf(this.rows, this.elementType) * this.cols;
  }

  public get alignment(): number {
    return VectorType.alignmentOf(this.rows, this.elementType);
  }

  /** Constructs a Matrix of this type with the given values */
  public create(value: (number | bigint) | readonly (number | bigint)[]): MatrixValue {
    if (value instanceof Array) {
      assert(value.length === this.cols * this.rows);
    } else {
      value = Array(this.cols * this.rows).fill(value);
    }
    const columns: (number | bigint)[][] = [];
    for (let i = 0; i < this.cols; i++) {
      const start = i * this.rows;
      columns.push(value.slice(start, start + this.rows));
    }
    return new MatrixValue(columns.map(c => c.map(v => this.elementType.create(v))));
  }
}

/** ArrayType describes the type of WGSL Array. */
export class ArrayType {
  readonly count: number; // Number of elements in the array
  readonly elementType: Type; // Element type

  // Maps a string representation of a array type to array type.
  private static instances = new Map<string, ArrayType>();

  static create(count: number, elementType: Type): ArrayType {
    const key = `${elementType.toString()} ${count}`;
    let ty = this.instances.get(key);
    if (ty !== undefined) {
      return ty;
    }
    ty = new ArrayType(count, elementType);
    this.instances.set(key, ty);
    return ty;
  }

  constructor(count: number, elementType: Type) {
    this.count = count;
    this.elementType = elementType;
  }

  /**
   * @returns a array constructed from the values read from the buffer at the
   * given byte offset
   */
  public read(buf: Uint8Array, offset: number): ArrayValue {
    const elements: Array<Value> = [];

    for (let i = 0; i < this.count; i++) {
      elements[i] = this.elementType.read(buf, offset);
      offset += this.stride;
    }
    return new ArrayValue(elements);
  }

  public toString(): string {
    return `array<${this.elementType}, ${this.count}>`;
  }

  public get stride(): number {
    return align(this.elementType.size, this.elementType.alignment);
  }

  public get size(): number {
    return this.stride * this.count;
  }

  public get alignment(): number {
    return this.elementType.alignment;
  }
}

/** ArrayElementType infers the element type of the indexable type A */
type ArrayElementType<A> = A extends { [index: number]: infer T } ? T : never;

/** Copy bytes from `buf` at `offset` into the working data, then read it out using `workingDataOut` */
function valueFromBytes<A extends TypedArrayBufferView>(
  workingDataOut: A,
  buf: Uint8Array,
  offset: number
): ArrayElementType<A> {
  for (let i = 0; i < workingDataOut.BYTES_PER_ELEMENT; ++i) {
    workingDataU8[i] = buf[offset + i];
  }
  return workingDataOut[0] as ArrayElementType<A>;
}

const abstractIntType = new ScalarType('abstract-int', 8, (buf: Uint8Array, offset: number) =>
  abstractInt(valueFromBytes(workingDataI64, buf, offset))
);
const i32Type = new ScalarType('i32', 4, (buf: Uint8Array, offset: number) =>
  i32(valueFromBytes(workingDataI32, buf, offset))
);
const u32Type = new ScalarType('u32', 4, (buf: Uint8Array, offset: number) =>
  u32(valueFromBytes(workingDataU32, buf, offset))
);
const i16Type = new ScalarType('i16', 2, (buf: Uint8Array, offset: number) =>
  i16(valueFromBytes(workingDataI16, buf, offset))
);
const u16Type = new ScalarType('u16', 2, (buf: Uint8Array, offset: number) =>
  u16(valueFromBytes(workingDataU16, buf, offset))
);
const i8Type = new ScalarType('i8', 1, (buf: Uint8Array, offset: number) =>
  i8(valueFromBytes(workingDataI8, buf, offset))
);
const u8Type = new ScalarType('u8', 1, (buf: Uint8Array, offset: number) =>
  u8(valueFromBytes(workingDataU8, buf, offset))
);
const abstractFloatType = new ScalarType('abstract-float', 8, (buf: Uint8Array, offset: number) =>
  abstractFloat(valueFromBytes(workingDataF64, buf, offset))
);
const f64Type = new ScalarType('f64', 8, (buf: Uint8Array, offset: number) =>
  f64(valueFromBytes(workingDataF64, buf, offset))
);
const f32Type = new ScalarType('f32', 4, (buf: Uint8Array, offset: number) =>
  f32(valueFromBytes(workingDataF32, buf, offset))
);
const f16Type = new ScalarType('f16', 2, (buf: Uint8Array, offset: number) =>
  f16Bits(valueFromBytes(workingDataU16, buf, offset))
);
const boolType = new ScalarType('bool', 4, (buf: Uint8Array, offset: number) =>
  bool(valueFromBytes(workingDataU32, buf, offset) !== 0)
);

/** Type is a ScalarType, VectorType, MatrixType or ArrayType. */
export type Type = ScalarType | VectorType | MatrixType | ArrayType;

/** Type holds pre-declared Types along with helper constructor functions. */
export const Type = {
  abstractInt: abstractIntType,
  'abstract-int': abstractIntType,
  i32: i32Type,
  u32: u32Type,
  i16: i16Type,
  u16: u16Type,
  i8: i8Type,
  u8: u8Type,

  abstractFloat: abstractFloatType,
  'abstract-float': abstractFloatType,
  f64: f64Type,
  f32: f32Type,
  f16: f16Type,

  bool: boolType,

  vec: (width: number, elementType: ScalarType) => VectorType.create(width, elementType),

  vec2i: VectorType.create(2, i32Type),
  vec2u: VectorType.create(2, u32Type),
  vec2f: VectorType.create(2, f32Type),
  vec2h: VectorType.create(2, f16Type),
  vec3i: VectorType.create(3, i32Type),
  vec3u: VectorType.create(3, u32Type),
  vec3f: VectorType.create(3, f32Type),
  vec3h: VectorType.create(3, f16Type),
  vec4i: VectorType.create(4, i32Type),
  vec4u: VectorType.create(4, u32Type),
  vec4f: VectorType.create(4, f32Type),
  vec4h: VectorType.create(4, f16Type),

  mat: (cols: number, rows: number, elementType: ScalarType) =>
    MatrixType.create(cols, rows, elementType),

  mat2x2f: MatrixType.create(2, 2, f32Type),
  mat2x2h: MatrixType.create(2, 2, f16Type),
  mat3x2f: MatrixType.create(3, 2, f32Type),
  mat3x2h: MatrixType.create(3, 2, f16Type),
  mat4x2f: MatrixType.create(4, 2, f32Type),
  mat4x2h: MatrixType.create(4, 2, f16Type),
  mat2x3f: MatrixType.create(2, 3, f32Type),
  mat2x3h: MatrixType.create(2, 3, f16Type),
  mat3x3f: MatrixType.create(3, 3, f32Type),
  mat3x3h: MatrixType.create(3, 3, f16Type),
  mat4x3f: MatrixType.create(4, 3, f32Type),
  mat4x3h: MatrixType.create(4, 3, f16Type),
  mat2x4f: MatrixType.create(2, 4, f32Type),
  mat2x4h: MatrixType.create(2, 4, f16Type),
  mat3x4f: MatrixType.create(3, 4, f32Type),
  mat3x4h: MatrixType.create(3, 4, f16Type),
  mat4x4f: MatrixType.create(4, 4, f32Type),
  mat4x4h: MatrixType.create(4, 4, f16Type),

  array: (count: number, elementType: Type) => ArrayType.create(count, elementType),
};

/** @returns the ScalarType from the ScalarKind */
export function scalarType(kind: ScalarKind): ScalarType {
  switch (kind) {
    case 'abstract-float':
      return Type.abstractFloat;
    case 'f64':
      return Type.f64;
    case 'f32':
      return Type.f32;
    case 'f16':
      return Type.f16;
    case 'u32':
      return Type.u32;
    case 'u16':
      return Type.u16;
    case 'u8':
      return Type.u8;
    case 'abstract-int':
      return Type.abstractInt;
    case 'i32':
      return Type.i32;
    case 'i16':
      return Type.i16;
    case 'i8':
      return Type.i8;
    case 'bool':
      return Type.bool;
  }
}

/** @returns the number of scalar (element) types of the given Type */
export function numElementsOf(ty: Type): number {
  if (ty instanceof ScalarType) {
    return 1;
  }
  if (ty instanceof VectorType) {
    return ty.width;
  }
  if (ty instanceof MatrixType) {
    return ty.cols * ty.rows;
  }
  if (ty instanceof ArrayType) {
    return ty.count;
  }
  throw new Error(`unhandled type ${ty}`);
}

/** @returns the scalar elements of the given Value */
export function elementsOf(value: Value): Value[] {
  if (isScalarValue(value)) {
    return [value];
  }
  if (value instanceof VectorValue) {
    return value.elements;
  }
  if (value instanceof MatrixValue) {
    return value.elements.flat();
  }
  if (value instanceof ArrayValue) {
    return value.elements;
  }
  throw new Error(`unhandled value ${value}`);
}

/** @returns the scalar elements of the given Value */
export function scalarElementsOf(value: Value): ScalarValue[] {
  if (isScalarValue(value)) {
    return [value];
  }
  if (value instanceof VectorValue) {
    return value.elements;
  }
  if (value instanceof MatrixValue) {
    return value.elements.flat();
  }
  if (value instanceof ArrayValue) {
    return value.elements.map(els => scalarElementsOf(els)).flat();
  }
  throw new Error(`unhandled value ${value}`);
}

/** @returns the inner element type of the given type */
export function elementTypeOf(t: Type) {
  if (t instanceof ScalarType) {
    return t;
  }
  return t.elementType;
}

/** @returns the scalar (element) type of the given Type */
export function scalarTypeOf(ty: Type): ScalarType {
  if (ty instanceof ScalarType) {
    return ty;
  }
  if (ty instanceof VectorType) {
    return ty.elementType;
  }
  if (ty instanceof MatrixType) {
    return ty.elementType;
  }
  if (ty instanceof ArrayType) {
    return scalarTypeOf(ty.elementType);
  }
  throw new Error(`unhandled type ${ty}`);
}

function hex(sizeInBytes: number, bitsLow: number, bitsHigh?: number) {
  let hex = '';
  workingDataU32[0] = bitsLow;
  if (bitsHigh !== undefined) {
    workingDataU32[1] = bitsHigh;
  }
  for (let i = 0; i < sizeInBytes; ++i) {
    hex = workingDataU8[i].toString(16).padStart(2, '0') + hex;
  }
  return `0x${hex}`;
}

function withPoint(x: number) {
  const str = `${x}`;
  return str.indexOf('.') > 0 || str.indexOf('e') > 0 ? str : `${str}.0`;
}

/** Class that encapsulates a single abstract-int value. */
export class AbstractIntValue {
  readonly value: bigint; // The abstract-integer value
  readonly bitsLow: number; // The low 32 bits of the abstract-integer value.
  readonly bitsHigh: number; // The high 32 bits of the abstract-integer value.
  readonly type = Type.abstractInt; // The type of the value.

  public constructor(value: bigint, bitsLow: number, bitsHigh: number) {
    this.value = value;
    this.bitsLow = bitsLow;
    this.bitsHigh = bitsHigh;
  }

  /**
   * Copies the scalar value to the buffer at the provided byte offset.
   * @param buffer the destination buffer
   * @param offset the offset in buffer, in units of `buffer`
   */
  public copyTo(buffer: TypedArrayBufferView, offset: number) {
    workingDataU32[0] = this.bitsLow;
    workingDataU32[1] = this.bitsHigh;
    for (let i = 0; i < 8; i++) {
      buffer[offset + i] = workingDataU8[i];
    }
  }

  /** @returns the WGSL representation of this scalar value */
  public wgsl(): string {
    // WGSL parses negative numbers as a negated positive.
    // This means '-9223372036854775808' parses as `-' & '9223372036854775808', so must be written as
    // '(-9223372036854775807 - 1)' in WGSL, because '9223372036854775808' is not a valid AbstractInt.
    if (this.value === -9223372036854775808n) {
      return `(-9223372036854775807 - 1)`;
    }
    return `${this.value}`;
  }

  public toString(): string {
    return `${Colors.bold(this.value.toString())} (${hex(8, this.bitsLow, this.bitsHigh)})`;
  }
}

/** Class that encapsulates a single abstract-float value. */
export class AbstractFloatValue {
  readonly value: number; // The f32 value
  readonly bitsLow: number; // The low 32 bits of the abstract-float value.
  readonly bitsHigh: number; // The high 32 bits of the abstract-float value.
  readonly type = Type.abstractFloat; // The type of the value.

  public constructor(value: number, bitsLow: number, bitsHigh: number) {
    this.value = value;
    this.bitsLow = bitsLow;
    this.bitsHigh = bitsHigh;
  }

  /**
   * Copies the scalar value to the buffer at the provided byte offset.
   * @param buffer the destination buffer
   * @param offset the offset in buffer, in units of `buffer`
   */
  public copyTo(buffer: TypedArrayBufferView, offset: number) {
    workingDataU32[0] = this.bitsLow;
    workingDataU32[1] = this.bitsHigh;
    for (let i = 0; i < 8; i++) {
      buffer[offset + i] = workingDataU8[i];
    }
  }

  /** @returns the WGSL representation of this scalar value */
  public wgsl(): string {
    return `${withPoint(this.value)}`;
  }

  public toString(): string {
    switch (this.value) {
      case Infinity:
      case -Infinity:
        return Colors.bold(this.value.toString());
      default: {
        let str = this.value.toString();
        str = str.indexOf('.') > 0 || str.indexOf('e') > 0 ? str : `${str}.0`;
        return isSubnormalNumberF64(this.value.valueOf())
          ? `${Colors.bold(str)} (${hex(8, this.bitsLow, this.bitsHigh)} subnormal)`
          : `${Colors.bold(str)} (${hex(8, this.bitsLow, this.bitsHigh)})`;
      }
    }
  }
}

/** Class that encapsulates a single i32 value. */
export class I32Value {
  readonly value: number; // The i32 value
  readonly bits: number; // The i32 value, bitcast to a 32-bit integer.
  readonly type = Type.i32; // The type of the value.

  public constructor(value: number, bits: number) {
    this.value = value;
    this.bits = bits;
  }

  /**
   * Copies the scalar value to the buffer at the provided byte offset.
   * @param buffer the destination buffer
   * @param offset the offset in buffer, in units of `buffer`
   */
  public copyTo(buffer: TypedArrayBufferView, offset: number) {
    workingDataU32[0] = this.bits;
    for (let i = 0; i < 4; i++) {
      buffer[offset + i] = workingDataU8[i];
    }
  }

  /** @returns the WGSL representation of this scalar value */
  public wgsl(): string {
    return `i32(${this.value})`;
  }

  public toString(): string {
    return `${Colors.bold(this.value.toString())} (${hex(4, this.bits)})`;
  }
}

/** Class that encapsulates a single u32 value. */
export class U32Value {
  readonly value: number; // The u32 value
  readonly type = Type.u32; // The type of the value.

  public constructor(value: number) {
    this.value = value;
  }

  /**
   * Copies the scalar value to the buffer at the provided byte offset.
   * @param buffer the destination buffer
   * @param offset the offset in buffer, in units of `buffer`
   */
  public copyTo(buffer: TypedArrayBufferView, offset: number) {
    workingDataU32[0] = this.value;
    for (let i = 0; i < 4; i++) {
      buffer[offset + i] = workingDataU8[i];
    }
  }

  /** @returns the WGSL representation of this scalar value */
  public wgsl(): string {
    return `${this.value}u`;
  }

  public toString(): string {
    return `${Colors.bold(this.value.toString())} (${hex(4, this.value)})`;
  }
}

/**
 * Class that encapsulates a single i16 value.
 * @note type does not exist in WGSL yet
 */
export class I16Value {
  readonly value: number; // The i16 value
  readonly bits: number; // The i16 value, bitcast to a 16-bit integer.
  readonly type = Type.i16; // The type of the value.

  public constructor(value: number, bits: number) {
    this.value = value;
    this.bits = bits;
  }

  /**
   * Copies the scalar value to the buffer at the provided byte offset.
   * @param buffer the destination buffer
   * @param offset the offset in buffer, in units of `buffer`
   */
  public copyTo(buffer: TypedArrayBufferView, offset: number) {
    workingDataU16[0] = this.bits;
    for (let i = 0; i < 4; i++) {
      buffer[offset + i] = workingDataU8[i];
    }
  }

  /** @returns the WGSL representation of this scalar value */
  public wgsl(): string {
    return `i16(${this.value})`;
  }

  public toString(): string {
    return `${Colors.bold(this.value.toString())} (${hex(2, this.bits)})`;
  }
}

/**
 * Class that encapsulates a single u16 value.
 * @note type does not exist in WGSL yet
 */
export class U16Value {
  readonly value: number; // The u16 value
  readonly type = Type.u16; // The type of the value.

  public constructor(value: number) {
    this.value = value;
  }

  /**
   * Copies the scalar value to the buffer at the provided byte offset.
   * @param buffer the destination buffer
   * @param offset the offset in buffer, in units of `buffer`
   */
  public copyTo(buffer: TypedArrayBufferView, offset: number) {
    workingDataU16[0] = this.value;
    for (let i = 0; i < 2; i++) {
      buffer[offset + i] = workingDataU8[i];
    }
  }

  /** @returns the WGSL representation of this scalar value */
  public wgsl(): string {
    assert(false, 'u16 is not a WGSL type');
    return `u16(${this.value})`;
  }

  public toString(): string {
    return `${Colors.bold(this.value.toString())} (${hex(2, this.value)})`;
  }
}

/**
 * Class that encapsulates a single i8 value.
 * @note type does not exist in WGSL yet
 */
export class I8Value {
  readonly value: number; // The i8 value
  readonly bits: number; // The i8 value, bitcast to a 8-bit integer.
  readonly type = Type.i8; // The type of the value.

  public constructor(value: number, bits: number) {
    this.value = value;
    this.bits = bits;
  }

  /**
   * Copies the scalar value to the buffer at the provided byte offset.
   * @param buffer the destination buffer
   * @param offset the offset in buffer, in units of `buffer`
   */
  public copyTo(buffer: TypedArrayBufferView, offset: number) {
    workingDataU8[0] = this.bits;
    for (let i = 0; i < 4; i++) {
      buffer[offset + i] = workingDataU8[i];
    }
  }

  /** @returns the WGSL representation of this scalar value */
  public wgsl(): string {
    return `i8(${this.value})`;
  }

  public toString(): string {
    return `${Colors.bold(this.value.toString())} (${hex(2, this.bits)})`;
  }
}

/**
 * Class that encapsulates a single u8 value.
 * @note type does not exist in WGSL yet
 */
export class U8Value {
  readonly value: number; // The u8 value
  readonly type = Type.u8; // The type of the value.

  public constructor(value: number) {
    this.value = value;
  }

  /**
   * Copies the scalar value to the buffer at the provided byte offset.
   * @param buffer the destination buffer
   * @param offset the offset in buffer, in units of `buffer`
   */
  public copyTo(buffer: TypedArrayBufferView, offset: number) {
    workingDataU8[0] = this.value;
    for (let i = 0; i < 2; i++) {
      buffer[offset + i] = workingDataU8[i];
    }
  }

  /** @returns the WGSL representation of this scalar value */
  public wgsl(): string {
    assert(false, 'u8 is not a WGSL type');
    return `u8(${this.value})`;
  }

  public toString(): string {
    return `${Colors.bold(this.value.toString())} (${hex(2, this.value)})`;
  }
}

/**
 * Class that encapsulates a single f64 value
 * @note type does not exist in WGSL yet
 */
export class F64Value {
  readonly value: number; // The f32 value
  readonly bitsLow: number; // The low 32 bits of the abstract-float value.
  readonly bitsHigh: number; // The high 32 bits of the abstract-float value.
  readonly type = Type.f64; // The type of the value.

  public constructor(value: number, bitsLow: number, bitsHigh: number) {
    this.value = value;
    this.bitsLow = bitsLow;
    this.bitsHigh = bitsHigh;
  }

  /**
   * Copies the scalar value to the buffer at the provided byte offset.
   * @param buffer the destination buffer
   * @param offset the offset in buffer, in units of `buffer`
   */
  public copyTo(buffer: TypedArrayBufferView, offset: number) {
    workingDataU32[0] = this.bitsLow;
    workingDataU32[1] = this.bitsHigh;
    for (let i = 0; i < 8; i++) {
      buffer[offset + i] = workingDataU8[i];
    }
  }

  /** @returns the WGSL representation of this scalar value */
  public wgsl(): string {
    assert(false, 'f64 is not a WGSL type');
    return `${withPoint(this.value)}`;
  }

  public toString(): string {
    switch (this.value) {
      case Infinity:
      case -Infinity:
        return Colors.bold(this.value.toString());
      default: {
        let str = this.value.toString();
        str = str.indexOf('.') > 0 || str.indexOf('e') > 0 ? str : `${str}.0`;
        return isSubnormalNumberF64(this.value.valueOf())
          ? `${Colors.bold(str)} (${hex(8, this.bitsLow, this.bitsHigh)} subnormal)`
          : `${Colors.bold(str)} (${hex(8, this.bitsLow, this.bitsHigh)})`;
      }
    }
  }
}

/** Class that encapsulates a single f32 value. */
export class F32Value {
  readonly value: number; // The f32 value
  readonly bits: number; // The f32 value, bitcast to a 32-bit integer.
  readonly type = Type.f32; // The type of the value.

  public constructor(value: number, bits: number) {
    this.value = value;
    this.bits = bits;
  }

  /**
   * Copies the scalar value to the buffer at the provided byte offset.
   * @param buffer the destination buffer
   * @param offset the offset in buffer, in units of `buffer`
   */
  public copyTo(buffer: TypedArrayBufferView, offset: number) {
    workingDataU32[0] = this.bits;
    for (let i = 0; i < 4; i++) {
      buffer[offset + i] = workingDataU8[i];
    }
  }

  /** @returns the WGSL representation of this scalar value */
  public wgsl(): string {
    return `${withPoint(this.value)}f`;
  }

  public toString(): string {
    switch (this.value) {
      case Infinity:
      case -Infinity:
        return Colors.bold(this.value.toString());
      default: {
        let str = this.value.toString();
        str = str.indexOf('.') > 0 || str.indexOf('e') > 0 ? str : `${str}.0`;
        return isSubnormalNumberF32(this.value.valueOf())
          ? `${Colors.bold(str)} (${hex(4, this.bits)} subnormal)`
          : `${Colors.bold(str)} (${hex(4, this.bits)})`;
      }
    }
  }
}

/** Class that encapsulates a single f16 value. */
export class F16Value {
  readonly value: number; // The f16 value
  readonly bits: number; // The f16 value, bitcast to a 16-bit integer.
  readonly type = Type.f16; // The type of the value.

  public constructor(value: number, bits: number) {
    this.value = value;
    this.bits = bits;
  }

  /**
   * Copies the scalar value to the buffer at the provided byte offset.
   * @param buffer the destination buffer
   * @param offset the offset in buffer, in units of `buffer`
   */
  public copyTo(buffer: TypedArrayBufferView, offset: number) {
    workingDataU16[0] = this.bits;
    for (let i = 0; i < 2; i++) {
      buffer[offset + i] = workingDataU8[i];
    }
  }

  /** @returns the WGSL representation of this scalar value */
  public wgsl(): string {
    return `${withPoint(this.value)}h`;
  }

  public toString(): string {
    switch (this.value) {
      case Infinity:
      case -Infinity:
        return Colors.bold(this.value.toString());
      default: {
        let str = this.value.toString();
        str = str.indexOf('.') > 0 || str.indexOf('e') > 0 ? str : `${str}.0`;
        return isSubnormalNumberF16(this.value.valueOf())
          ? `${Colors.bold(str)} (${hex(2, this.bits)} subnormal)`
          : `${Colors.bold(str)} (${hex(2, this.bits)})`;
      }
    }
  }
}
/** Class that encapsulates a single bool value. */
export class BoolValue {
  readonly value: boolean; // The bool value
  readonly type = Type.bool; // The type of the value.

  public constructor(value: boolean) {
    this.value = value;
  }

  /**
   * Copies the scalar value to the buffer at the provided byte offset.
   * @param buffer the destination buffer
   * @param offset the offset in buffer, in units of `buffer`
   */
  public copyTo(buffer: TypedArrayBufferView, offset: number) {
    buffer[offset] = this.value ? 1 : 0;
  }

  /** @returns the WGSL representation of this scalar value */
  public wgsl(): string {
    return this.value.toString();
  }

  public toString(): string {
    return Colors.bold(this.value.toString());
  }
}

/** Scalar represents all the scalar value types */
export type ScalarValue =
  | AbstractIntValue
  | AbstractFloatValue
  | I32Value
  | U32Value
  | I16Value
  | U16Value
  | I8Value
  | U8Value
  | F64Value
  | F32Value
  | F16Value
  | BoolValue;

export interface ScalarBuilder<T> {
  (value: T): ScalarValue;
}

export function isScalarValue(value: object): value is ScalarValue {
  return (
    value instanceof AbstractIntValue ||
    value instanceof AbstractFloatValue ||
    value instanceof I32Value ||
    value instanceof U32Value ||
    value instanceof I16Value ||
    value instanceof U16Value ||
    value instanceof I8Value ||
    value instanceof U8Value ||
    value instanceof F64Value ||
    value instanceof F32Value ||
    value instanceof F16Value ||
    value instanceof BoolValue
  );
}

/** Create an AbstractInt from a numeric value, a JS `bigint`. */
export function abstractInt(value: bigint) {
  workingDataI64[0] = value;
  return new AbstractIntValue(workingDataI64[0], workingDataU32[0], workingDataU32[1]);
}

/** Create an AbstractInt from a bit representation, a uint64 represented as a JS `bigint`. */
export function abstractIntBits(value: bigint) {
  workingDataU64[0] = value;
  return new AbstractIntValue(workingDataI64[0], workingDataU32[0], workingDataU32[1]);
}

/** Create an AbstractFloat from a numeric value, a JS `number`. */
export function abstractFloat(value: number) {
  workingDataF64[0] = value;
  return new AbstractFloatValue(workingDataF64[0], workingDataU32[0], workingDataU32[1]);
}

/** Create an i32 from a numeric value, a JS `number`. */
export function i32(value: number) {
  workingDataI32[0] = value;
  return new I32Value(workingDataI32[0], workingDataU32[0]);
}

/** Create an i32 from a bit representation, a uint32 represented as a JS `number`. */
export function i32Bits(bits: number) {
  workingDataU32[0] = bits;
  return new I32Value(workingDataI32[0], workingDataU32[0]);
}

/** Create a u32 from a numeric value, a JS `number`. */
export function u32(value: number) {
  workingDataU32[0] = value;
  return new U32Value(workingDataU32[0]);
}

/** Create a u32 from a bit representation, a uint32 represented as a JS `number`. */
export function u32Bits(bits: number) {
  workingDataU32[0] = bits;
  return new U32Value(workingDataU32[0]);
}

/** Create an i16 from a numeric value, a JS `number`. */
export function i16(value: number) {
  workingDataI16[0] = value;
  return new I16Value(workingDataI16[0], workingDataU16[0]);
}

/** Create a u16 from a numeric value, a JS `number`. */
export function u16(value: number) {
  workingDataU16[0] = value;
  return new U16Value(workingDataU16[0]);
}

/** Create an i8 from a numeric value, a JS `number`. */
export function i8(value: number) {
  workingDataI8[0] = value;
  return new I8Value(workingDataI8[0], workingDataU8[0]);
}

/** Create a u8 from a numeric value, a JS `number`. */
export function u8(value: number) {
  workingDataU8[0] = value;
  return new U8Value(workingDataU8[0]);
}

/** Create an f64 from a numeric value, a JS `number`. */
export function f64(value: number) {
  workingDataF64[0] = value;
  return new F64Value(workingDataF64[0], workingDataU32[0], workingDataU32[1]);
}

/** Create an f32 from a numeric value, a JS `number`. */
export function f32(value: number) {
  workingDataF32[0] = value;
  return new F32Value(workingDataF32[0], workingDataU32[0]);
}

/** Create an f32 from a bit representation, a uint32 represented as a JS `number`. */
export function f32Bits(bits: number) {
  workingDataU32[0] = bits;
  return new F32Value(workingDataF32[0], workingDataU32[0]);
}

/** Create an f16 from a numeric value, a JS `number`. */
export function f16(value: number) {
  workingDataF16[0] = value;
  return new F16Value(value, workingDataU16[0]);
}

/** Create an f16 from a bit representation, a uint16 represented as a JS `number`. */
export function f16Bits(bits: number) {
  workingDataU16[0] = bits;
  return new F16Value(workingDataF16[0], workingDataU16[0]);
}

/** Create a boolean value. */
export function bool(value: boolean): ScalarValue {
  return new BoolValue(value);
}

/** A 'true' literal value */
export const True = bool(true);

/** A 'false' literal value */
export const False = bool(false);

/**
 * Class that encapsulates a vector value.
 */
export class VectorValue {
  readonly elements: Array<ScalarValue>;
  readonly type: VectorType;

  public constructor(elements: Array<ScalarValue>) {
    if (elements.length < 2 || elements.length > 4) {
      throw new Error(`vector element count must be between 2 and 4, got ${elements.length}`);
    }
    for (let i = 1; i < elements.length; i++) {
      const a = elements[0].type;
      const b = elements[i].type;
      if (a !== b) {
        throw new Error(
          `cannot mix vector element types. Found elements with types '${a}' and '${b}'`
        );
      }
    }
    this.elements = elements;
    this.type = VectorType.create(elements.length, elements[0].type);
  }

  /**
   * Copies the vector value to the Uint8Array buffer at the provided byte offset.
   * @param buffer the destination buffer
   * @param offset the byte offset within buffer
   */
  public copyTo(buffer: Uint8Array, offset: number) {
    for (const element of this.elements) {
      element.copyTo(buffer, offset);
      offset += this.type.elementType.size;
    }
  }

  /**
   * @returns the WGSL representation of this vector value
   */
  public wgsl(): string {
    const els = this.elements.map(v => v.wgsl()).join(', ');
    return `vec${this.type.width}(${els})`;
  }

  public toString(): string {
    return `${this.type}(${this.elements.map(e => e.toString()).join(', ')})`;
  }

  public get x() {
    assert(0 < this.elements.length);
    return this.elements[0];
  }

  public get y() {
    assert(1 < this.elements.length);
    return this.elements[1];
  }

  public get z() {
    assert(2 < this.elements.length);
    return this.elements[2];
  }

  public get w() {
    assert(3 < this.elements.length);
    return this.elements[3];
  }
}

/** Helper for constructing a new two-element vector with the provided values */
export function vec2(x: ScalarValue, y: ScalarValue) {
  return new VectorValue([x, y]);
}

/** Helper for constructing a new three-element vector with the provided values */
export function vec3(x: ScalarValue, y: ScalarValue, z: ScalarValue) {
  return new VectorValue([x, y, z]);
}

/** Helper for constructing a new four-element vector with the provided values */
export function vec4(x: ScalarValue, y: ScalarValue, z: ScalarValue, w: ScalarValue) {
  return new VectorValue([x, y, z, w]);
}

/**
 * Helper for constructing Vectors from arrays of numbers
 *
 * @param v array of numbers to be converted, must contain 2, 3 or 4 elements
 * @param op function to convert from number to Scalar, e.g. 'f32`
 */
export function toVector(v: readonly number[], op: (n: number) => ScalarValue): VectorValue {
  switch (v.length) {
    case 2:
      return vec2(op(v[0]), op(v[1]));
    case 3:
      return vec3(op(v[0]), op(v[1]), op(v[2]));
    case 4:
      return vec4(op(v[0]), op(v[1]), op(v[2]), op(v[3]));
  }
  unreachable(`input to 'toVector' must contain 2, 3, or 4 elements`);
}

/**
 * Class that encapsulates a Matrix value.
 */
export class MatrixValue {
  readonly elements: ScalarValue[][];
  readonly type: MatrixType;

  public constructor(elements: Array<Array<ScalarValue>>) {
    const num_cols = elements.length;
    if (num_cols < 2 || num_cols > 4) {
      throw new Error(`matrix cols count must be between 2 and 4, got ${num_cols}`);
    }

    const num_rows = elements[0].length;
    if (!elements.every(c => c.length === num_rows)) {
      throw new Error(`cannot mix matrix column lengths`);
    }

    if (num_rows < 2 || num_rows > 4) {
      throw new Error(`matrix rows count must be between 2 and 4, got ${num_rows}`);
    }

    const elem_type = elements[0][0].type;
    if (!elements.every(c => c.every(r => objectEquals(r.type, elem_type)))) {
      throw new Error(`cannot mix matrix element types`);
    }

    this.elements = elements;
    this.type = MatrixType.create(num_cols, num_rows, elem_type);
  }

  /**
   * Copies the matrix value to the Uint8Array buffer at the provided byte offset.
   * @param buffer the destination buffer
   * @param offset the byte offset within buffer
   */
  public copyTo(buffer: Uint8Array, offset: number) {
    for (let i = 0; i < this.type.cols; i++) {
      for (let j = 0; j < this.type.rows; j++) {
        this.elements[i][j].copyTo(buffer, offset);
        offset += this.type.elementType.size;
      }

      // vec3 have one padding element, so need to skip in matrices
      if (this.type.rows === 3) {
        offset += this.type.elementType.size;
      }
    }
  }

  /**
   * @returns the WGSL representation of this matrix value
   */
  public wgsl(): string {
    const els = this.elements.flatMap(c => c.map(r => r.wgsl())).join(', ');
    return `mat${this.type.cols}x${this.type.rows}(${els})`;
  }

  public toString(): string {
    return `${this.type}(${this.elements.map(c => c.join(', ')).join(', ')})`;
  }
}

/**
 * Class that encapsulates an Array value.
 */
export class ArrayValue {
  readonly elements: Value[];
  readonly type: ArrayType;

  public constructor(elements: Array<Value>) {
    const elem_type = elements[0].type;
    if (!elements.every(c => elements.every(r => objectEquals(r.type, elem_type)))) {
      throw new Error(`cannot mix array element types`);
    }

    this.elements = elements;
    this.type = ArrayType.create(elements.length, elem_type);
  }

  /**
   * Copies the array value to the Uint8Array buffer at the provided byte offset.
   * @param buffer the destination buffer
   * @param offset the byte offset within buffer
   */
  public copyTo(buffer: Uint8Array, offset: number) {
    for (const element of this.elements) {
      element.copyTo(buffer, offset);
      offset += this.type.elementType.size;
    }
  }

  /**
   * @returns the WGSL representation of this array value
   */
  public wgsl(): string {
    const els = this.elements.map(r => r.wgsl()).join(', ');
    return isAbstractType(this.type.elementType) ? `array(${els})` : `${this.type}(${els})`;
  }

  public toString(): string {
    return this.wgsl();
  }
}

/** Helper for constructing an ArrayValue with the provided values */
export function array(...elements: Value[]) {
  return new ArrayValue(elements);
}

/**
 * Helper for constructing Matrices from arrays of numbers
 *
 * @param m array of array of numbers to be converted, all Array of number must
 *          be of the same length. All Arrays must have 2, 3, or 4 elements.
 * @param op function to convert from number to Scalar, e.g. 'f32`
 */
export function toMatrix(m: ROArrayArray<number>, op: (n: number) => ScalarValue): MatrixValue {
  const cols = m.length;
  const rows = m[0].length;
  const elements: ScalarValue[][] = [...Array<ScalarValue[]>(cols)].map(_ => [
    ...Array<ScalarValue>(rows),
  ]);
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      elements[i][j] = op(m[i][j]);
    }
  }

  return new MatrixValue(elements);
}

/** Value is a Scalar, Vector, Matrix or Array value. */
export type Value = ScalarValue | VectorValue | MatrixValue | ArrayValue;

export type SerializedScalarValue = {
  kind: 'scalar';
  type: ScalarKind;
  value: boolean | number;
};

export type SerializedVectorValue = {
  kind: 'vector';
  type: ScalarKind;
  value: boolean[] | readonly number[];
};

export type SerializedMatrixValue = {
  kind: 'matrix';
  type: ScalarKind;
  value: ROArrayArray<number>;
};

enum SerializedScalarKind {
  AbstractFloat,
  F64,
  F32,
  F16,
  U32,
  U16,
  U8,
  I32,
  I16,
  I8,
  Bool,
  AbstractInt,
}

/** serializeScalarKind() serializes a ScalarKind to a BinaryStream */
function serializeScalarKind(s: BinaryStream, v: ScalarKind) {
  switch (v) {
    case 'abstract-float':
      s.writeU8(SerializedScalarKind.AbstractFloat);
      return;
    case 'f64':
      s.writeU8(SerializedScalarKind.F64);
      return;
    case 'f32':
      s.writeU8(SerializedScalarKind.F32);
      return;
    case 'f16':
      s.writeU8(SerializedScalarKind.F16);
      return;
    case 'u32':
      s.writeU8(SerializedScalarKind.U32);
      return;
    case 'u16':
      s.writeU8(SerializedScalarKind.U16);
      return;
    case 'u8':
      s.writeU8(SerializedScalarKind.U8);
      return;
    case 'abstract-int':
      s.writeU8(SerializedScalarKind.AbstractInt);
      return;
    case 'i32':
      s.writeU8(SerializedScalarKind.I32);
      return;
    case 'i16':
      s.writeU8(SerializedScalarKind.I16);
      return;
    case 'i8':
      s.writeU8(SerializedScalarKind.I8);
      return;
    case 'bool':
      s.writeU8(SerializedScalarKind.Bool);
      return;
  }
  unreachable(`Do not know what to write scalar kind = ${v}`);
}

/** deserializeScalarKind() deserializes a ScalarKind from a BinaryStream */
function deserializeScalarKind(s: BinaryStream): ScalarKind {
  const kind = s.readU8();
  switch (kind) {
    case SerializedScalarKind.AbstractFloat:
      return 'abstract-float';
    case SerializedScalarKind.F64:
      return 'f64';
    case SerializedScalarKind.F32:
      return 'f32';
    case SerializedScalarKind.F16:
      return 'f16';
    case SerializedScalarKind.U32:
      return 'u32';
    case SerializedScalarKind.U16:
      return 'u16';
    case SerializedScalarKind.U8:
      return 'u8';
    case SerializedScalarKind.AbstractInt:
      return 'abstract-int';
    case SerializedScalarKind.I32:
      return 'i32';
    case SerializedScalarKind.I16:
      return 'i16';
    case SerializedScalarKind.I8:
      return 'i8';
    case SerializedScalarKind.Bool:
      return 'bool';
    default:
      unreachable(`invalid serialized ScalarKind: ${kind}`);
  }
}

enum SerializedValueKind {
  Scalar,
  Vector,
  Matrix,
}

/** serializeValue() serializes a Value to a BinaryStream */
export function serializeValue(s: BinaryStream, v: Value) {
  const serializeScalar = (scalar: ScalarValue, kind: ScalarKind) => {
    switch (typeof scalar.value) {
      case 'number':
        switch (kind) {
          case 'abstract-float':
            s.writeF64(scalar.value);
            return;
          case 'f64':
            s.writeF64(scalar.value);
            return;
          case 'f32':
            s.writeF32(scalar.value);
            return;
          case 'f16':
            s.writeF16(scalar.value);
            return;
          case 'u32':
            s.writeU32(scalar.value);
            return;
          case 'u16':
            s.writeU16(scalar.value);
            return;
          case 'u8':
            s.writeU8(scalar.value);
            return;
          case 'i32':
            s.writeI32(scalar.value);
            return;
          case 'i16':
            s.writeI16(scalar.value);
            return;
          case 'i8':
            s.writeI8(scalar.value);
            return;
        }
        break;
      case 'bigint':
        switch (kind) {
          case 'abstract-int':
            s.writeI64(scalar.value);
            return;
        }
        break;
      case 'boolean':
        switch (kind) {
          case 'bool':
            s.writeBool(scalar.value);
            return;
        }
        break;
    }
  };

  if (isScalarValue(v)) {
    s.writeU8(SerializedValueKind.Scalar);
    serializeScalarKind(s, v.type.kind);
    serializeScalar(v, v.type.kind);
    return;
  }
  if (v instanceof VectorValue) {
    s.writeU8(SerializedValueKind.Vector);
    serializeScalarKind(s, v.type.elementType.kind);
    s.writeU8(v.type.width);
    for (const element of v.elements) {
      serializeScalar(element, v.type.elementType.kind);
    }
    return;
  }
  if (v instanceof MatrixValue) {
    s.writeU8(SerializedValueKind.Matrix);
    serializeScalarKind(s, v.type.elementType.kind);
    s.writeU8(v.type.cols);
    s.writeU8(v.type.rows);
    for (const column of v.elements) {
      for (const element of column) {
        serializeScalar(element, v.type.elementType.kind);
      }
    }
    return;
  }

  unreachable(`unhandled value type: ${v}`);
}

/** deserializeValue() deserializes a Value from a BinaryStream */
export function deserializeValue(s: BinaryStream): Value {
  const deserializeScalar = (kind: ScalarKind) => {
    switch (kind) {
      case 'abstract-float':
        return abstractFloat(s.readF64());
      case 'f64':
        return f64(s.readF64());
      case 'f32':
        return f32(s.readF32());
      case 'f16':
        return f16(s.readF16());
      case 'u32':
        return u32(s.readU32());
      case 'u16':
        return u16(s.readU16());
      case 'u8':
        return u8(s.readU8());
      case 'abstract-int':
        return abstractInt(s.readI64());
      case 'i32':
        return i32(s.readI32());
      case 'i16':
        return i16(s.readI16());
      case 'i8':
        return i8(s.readI8());
      case 'bool':
        return bool(s.readBool());
    }
  };
  const valueKind = s.readU8();
  const scalarKind = deserializeScalarKind(s);
  switch (valueKind) {
    case SerializedValueKind.Scalar:
      return deserializeScalar(scalarKind);
    case SerializedValueKind.Vector: {
      const width = s.readU8();
      const scalars = new Array<ScalarValue>(width);
      for (let i = 0; i < width; i++) {
        scalars[i] = deserializeScalar(scalarKind);
      }
      return new VectorValue(scalars);
    }
    case SerializedValueKind.Matrix: {
      const numCols = s.readU8();
      const numRows = s.readU8();
      const columns = new Array<ScalarValue[]>(numCols);
      for (let c = 0; c < numCols; c++) {
        columns[c] = new Array<ScalarValue>(numRows);
        for (let i = 0; i < numRows; i++) {
          columns[c][i] = deserializeScalar(scalarKind);
        }
      }
      return new MatrixValue(columns);
    }
    default:
      unreachable(`invalid serialized value kind: ${valueKind}`);
  }
}

/** @returns if the Value is a float scalar type */
export function isFloatValue(v: Value): boolean {
  return isFloatType(v.type);
}

/**
 * @returns if `ty` is an abstract numeric type.
 * @note this does not consider composite types.
 * Use elementType() if you want to test the element type.
 */
export function isAbstractType(ty: Type): boolean {
  if (ty instanceof ScalarType) {
    return ty.kind === 'abstract-float' || ty.kind === 'abstract-int';
  }
  return false;
}

/**
 * @returns if `ty` is a floating point type.
 * @note this does not consider composite types.
 * Use elementType() if you want to test the element type.
 */
export function isFloatType(ty: Type): boolean {
  if (ty instanceof ScalarType) {
    return (
      ty.kind === 'abstract-float' || ty.kind === 'f64' || ty.kind === 'f32' || ty.kind === 'f16'
    );
  }
  return false;
}

/** @returns true if an argument of type 'src' can be used for a parameter of type 'dst' */
export function isConvertible(src: Type, dst: Type) {
  if (src === dst) {
    return true;
  }

  const widthOf = (ty: Type) => {
    return ty instanceof VectorType ? ty.width : 1;
  };

  if (widthOf(src) !== widthOf(dst)) {
    return false;
  }

  const elSrc = scalarTypeOf(src);
  const elDst = scalarTypeOf(dst);

  switch (elSrc.kind) {
    case 'abstract-float':
      switch (elDst.kind) {
        case 'abstract-float':
        case 'f16':
        case 'f32':
        case 'f64':
          return true;
        default:
          return false;
      }
    case 'abstract-int':
      switch (elDst.kind) {
        case 'abstract-int':
        case 'abstract-float':
        case 'f16':
        case 'f32':
        case 'f64':
        case 'u16':
        case 'u32':
        case 'u8':
        case 'i16':
        case 'i32':
        case 'i8':
          return true;
        default:
          return false;
      }
    default:
      return false;
  }
}

/// All floating-point scalar types
const kFloatScalars = [Type.abstractFloat, Type.f32, Type.f16] as const;

/// All floating-point vec2 types
const kFloatVec2 = [Type.vec(2, Type.abstractFloat), Type.vec2f, Type.vec2h] as const;

/// All floating-point vec3 types
const kFloatVec3 = [Type.vec(3, Type.abstractFloat), Type.vec3f, Type.vec3h] as const;

/// All floating-point vec4 types
const kFloatVec4 = [Type.vec(4, Type.abstractFloat), Type.vec4f, Type.vec4h] as const;

/// All f16 floating-point scalar and vector types
export const kConcreteF16ScalarsAndVectors = [
  Type.f16,
  Type.vec2h,
  Type.vec3h,
  Type.vec4h,
] as const;

/// All floating-point scalar and vector types
export const kFloatScalarsAndVectors = [
  ...kFloatScalars,
  ...kFloatVec2,
  ...kFloatVec3,
  ...kFloatVec4,
] as const;

// Abstract and concrete integer types are not grouped into an 'all' type,
// because for many validation tests there is a valid conversion of
// AbstractInt -> AbstractFloat, but not one for the concrete integers. Thus, an
// AbstractInt literal will be a potentially valid input, whereas the concrete
// integers will not be. For many tests the pattern is to have separate fixtures
// for the things that might be valid and those that are never valid.

/// All concrete integer scalar and vector types
export const kConcreteIntegerScalarsAndVectors = [
  Type.i32,
  Type.vec2i,
  Type.vec3i,
  Type.vec4i,
  Type.u32,
  Type.vec2u,
  Type.vec3u,
  Type.vec4u,
] as const;

/// All signed integer scalar and vector types
export const kConcreteSignedIntegerScalarsAndVectors = [
  Type.i32,
  Type.vec2i,
  Type.vec3i,
  Type.vec4i,
] as const;

/// All unsigned integer scalar and vector types
export const kConcreteUnsignedIntegerScalarsAndVectors = [
  Type.u32,
  Type.vec2u,
  Type.vec3u,
  Type.vec4u,
] as const;

/// All types which are convertable to floating-point scalar types.
export const kConvertableToFloatScalar = [Type.abstractInt, ...kFloatScalars] as const;

/// All types which are convertable to floating-point vector 2 types.
export const kConvertableToFloatVec2 = [Type.vec(2, Type.abstractInt), ...kFloatVec2] as const;

/// All types which are convertable to floating-point vector 3 types.
export const kConvertableToFloatVec3 = [Type.vec(3, Type.abstractInt), ...kFloatVec3] as const;

/// All types which are convertable to floating-point vector 4 types.
export const kConvertableToFloatVec4 = [Type.vec(4, Type.abstractInt), ...kFloatVec4] as const;

/// All types which are convertable to floating-point scalar or vector types.
export const kConvertableToFloatScalarsAndVectors = [
  Type.abstractInt,
  Type.vec(2, Type.abstractInt),
  Type.vec(3, Type.abstractInt),
  Type.vec(4, Type.abstractInt),
  ...kFloatScalarsAndVectors,
] as const;

/// All the numeric scalar and vector types.
export const kAllNumericScalarsAndVectors = [
  ...kConvertableToFloatScalarsAndVectors,
  ...kConcreteIntegerScalarsAndVectors,
] as const;

/// All the scalar and vector types.
export const kAllScalarsAndVectors = [
  Type.bool,
  Type.vec(2, Type.bool),
  Type.vec(3, Type.bool),
  Type.vec(4, Type.bool),
  ...kAllNumericScalarsAndVectors,
] as const;
