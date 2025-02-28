import { getIsBuildingDataCache } from '../../common/framework/data_cache.js';
import { Colors } from '../../common/util/colors.js';
import { assert, unreachable } from '../../common/util/util.js';
import {
  deserializeExpectation,
  serializeExpectation,
} from '../shader/execution/expression/case_cache.js';
import { Expectation, toComparator } from '../shader/execution/expression/expectation.js';

import BinaryStream from './binary_stream.js';
import {
  isFloatValue,
  isScalarValue,
  MatrixValue,
  ScalarValue,
  Value,
  VectorValue,
} from './conversion.js';
import { FPInterval } from './floating_point.js';

/** Comparison describes the result of a Comparator function. */
export interface Comparison {
  matched: boolean; // True if the two values were considered a match
  got: string; // The string representation of the 'got' value (possibly with markup)
  expected: string; // The string representation of the 'expected' value (possibly with markup)
}

// All Comparators must be serializable to be used in the CaseCache.
// New Comparators should add a new entry to SerializableComparatorKind and
// define functionality in serialize/deserializeComparator as needed.
//
// 'value' and 'packed' are internal framework Comparators that exist, so that
// the whole Case type hierarchy doesn't need to be split into Serializable vs
// non-Serializable paths. Passing them into the CaseCache will cause a runtime
// error.
// 'value' and 'packed' should never be used in .spec.ts files.
//
export type SerializableComparatorKind = 'anyOf' | 'skipUndefined' | 'alwaysPass';
type InternalComparatorKind = 'value' | 'packed';
export type ComparatorKind = SerializableComparatorKind | InternalComparatorKind;
export type ComparatorImpl = (got: Value) => Comparison;

/** Comparator is a function that compares whether the provided value matches an expectation. */
export interface Comparator {
  compare: ComparatorImpl;
  kind: ComparatorKind;
  data?: Expectation | Expectation[] | string;
}

/** SerializedComparator is an enum of all the possible serialized comparator types. */
enum SerializedComparatorKind {
  AnyOf,
  SkipUndefined,
  AlwaysPass,
}

/** serializeComparatorKind() serializes a ComparatorKind to a BinaryStream */
function serializeComparatorKind(s: BinaryStream, value: ComparatorKind) {
  switch (value) {
    case 'anyOf':
      return s.writeU8(SerializedComparatorKind.AnyOf);
    case 'skipUndefined':
      return s.writeU8(SerializedComparatorKind.SkipUndefined);
    case 'alwaysPass':
      return s.writeU8(SerializedComparatorKind.AlwaysPass);
  }
}

/** deserializeComparatorKind() deserializes a ComparatorKind from a BinaryStream */
function deserializeComparatorKind(s: BinaryStream): ComparatorKind {
  const kind = s.readU8();
  switch (kind) {
    case SerializedComparatorKind.AnyOf:
      return 'anyOf';
    case SerializedComparatorKind.SkipUndefined:
      return 'skipUndefined';
    case SerializedComparatorKind.AlwaysPass:
      return 'alwaysPass';
    default:
      unreachable(`invalid serialized ComparatorKind: ${kind}`);
  }
}

/**
 * compares 'got' Value  to 'expected' Value, returning the Comparison information.
 * @param got the Value obtained from the test
 * @param expected the expected Value
 * @returns the comparison results
 */
// NOTE: This function does not use objectEquals, since that does not handle FP
// specific corners cases correctly, i.e. that f64/f32/f16 are all considered
// the same type for this comparison.
function compareValue(got: Value, expected: Value): Comparison {
  {
    // Check types
    const gTy = got.type;
    const eTy = expected.type;
    const bothFloatTypes = isFloatValue(got) && isFloatValue(expected);
    if (gTy !== eTy && !bothFloatTypes) {
      return {
        matched: false,
        got: `${Colors.red(gTy.toString())}(${got})`,
        expected: `${Colors.red(eTy.toString())}(${expected})`,
      };
    }
  }

  if (isScalarValue(got)) {
    const g = got;
    const e = expected as ScalarValue;
    const isFloat = g.type.kind === 'f64' || g.type.kind === 'f32' || g.type.kind === 'f16';
    const matched =
      (isFloat && (g.value as number) === (e.value as number)) || (!isFloat && g.value === e.value);
    return {
      matched,
      got: g.toString(),
      expected: matched ? Colors.green(e.toString()) : Colors.red(e.toString()),
    };
  }

  if (got instanceof VectorValue) {
    const e = expected as VectorValue;
    const gLen = got.elements.length;
    const eLen = e.elements.length;
    let matched = gLen === eLen;
    if (matched) {
      // Iterating and calling compare instead of just using objectEquals to use the FP specific logic from above
      matched = got.elements.every((_, i) => {
        return compare(got.elements[i], e.elements[i]).matched;
      });
    }

    return {
      matched,
      got: `${got.toString()}`,
      expected: matched ? Colors.green(e.toString()) : Colors.red(e.toString()),
    };
  }

  if (got instanceof MatrixValue) {
    const e = expected as MatrixValue;
    const gCols = got.type.cols;
    const eCols = e.type.cols;
    const gRows = got.type.rows;
    const eRows = e.type.rows;
    let matched = gCols === eCols && gRows === eRows;
    if (matched) {
      // Iterating and calling compare instead of just using objectEquals to use the FP specific logic from above
      matched = got.elements.every((c, i) => {
        return c.every((_, j) => {
          return compare(got.elements[i][j], e.elements[i][j]).matched;
        });
      });
    }

    return {
      matched,
      got: `${got.toString()}`,
      expected: matched ? Colors.green(e.toString()) : Colors.red(e.toString()),
    };
  }

  throw new Error(`unhandled type '${typeof got}`);
}

/**
 * Tests it a 'got' Value is contained in 'expected' interval, returning the Comparison information.
 * @param got the Value obtained from the test
 * @param expected the expected FPInterval
 * @returns the comparison results
 */
function compareInterval(got: Value, expected: FPInterval): Comparison {
  {
    // Check type
    const gTy = got.type;
    if (!isFloatValue(got)) {
      return {
        matched: false,
        got: `${Colors.red(gTy.toString())}(${got})`,
        expected: `floating point value`,
      };
    }
  }

  if (isScalarValue(got)) {
    const g = got.value as number;
    const matched = expected.contains(g);
    return {
      matched,
      got: g.toString(),
      expected: matched ? Colors.green(expected.toString()) : Colors.red(expected.toString()),
    };
  }

  // Vector results are currently not handled
  throw new Error(`unhandled type '${typeof got}`);
}

/**
 * Tests it a 'got' Value is contained in 'expected' vector, returning the Comparison information.
 * @param got the Value obtained from the test, is expected to be a Vector
 * @param expected the expected array of FPIntervals, one for each element of the vector
 * @returns the comparison results
 */
function compareVector(got: Value, expected: FPInterval[]): Comparison {
  // Check got type
  if (!(got instanceof VectorValue)) {
    return {
      matched: false,
      got: `${Colors.red((typeof got).toString())}(${got})`,
      expected: `Vector`,
    };
  }

  // Check element type
  {
    const gTy = got.type.elementType;
    if (!isFloatValue(got.elements[0])) {
      return {
        matched: false,
        got: `${Colors.red(gTy.toString())}(${got})`,
        expected: `floating point elements`,
      };
    }
  }

  if (got.elements.length !== expected.length) {
    return {
      matched: false,
      got: `Vector of ${got.elements.length} elements`,
      expected: `${expected.length} elements`,
    };
  }

  const results = got.elements.map((_, idx) => {
    const g = got.elements[idx].value as number;
    return { match: expected[idx].contains(g), index: idx };
  });

  const failures = results.filter(v => !v.match).map(v => v.index);
  if (failures.length !== 0) {
    const expected_string = expected.map((v, idx) =>
      idx in failures ? Colors.red(`[${v}]`) : Colors.green(`[${v}]`)
    );
    return {
      matched: false,
      got: `[${got.elements}]`,
      expected: `[${expected_string}]`,
    };
  }

  return {
    matched: true,
    got: `[${got.elements}]`,
    expected: `[${Colors.green(expected.toString())}]`,
  };
}

// Utility to get arround not being able to nest `` blocks
function convertArrayToString<T>(m: T[]): string {
  return `[${m.join(',')}]`;
}

/**
 * Tests it a 'got' Value is contained in 'expected' matrix, returning the Comparison information.
 * @param got the Value obtained from the test, is expected to be a Matrix
 * @param expected the expected array of array of FPIntervals, representing a column-major matrix
 * @returns the comparison results
 */
function compareMatrix(got: Value, expected: FPInterval[][]): Comparison {
  // Check got type
  if (!(got instanceof MatrixValue)) {
    return {
      matched: false,
      got: `${Colors.red((typeof got).toString())}(${got})`,
      expected: `Matrix`,
    };
  }

  // Check element type
  {
    const gTy = got.type.elementType;
    if (!isFloatValue(got.elements[0][0])) {
      return {
        matched: false,
        got: `${Colors.red(gTy.toString())}(${got})`,
        expected: `floating point elements`,
      };
    }
  }

  // Check matrix dimensions
  {
    const gCols = got.elements.length;
    const gRows = got.elements[0].length;
    const eCols = expected.length;
    const eRows = expected[0].length;

    if (gCols !== eCols || gRows !== eRows) {
      assert(false);
      return {
        matched: false,
        got: `Matrix of ${gCols}x${gRows} elements`,
        expected: `Matrix of ${eCols}x${eRows} elements`,
      };
    }
  }

  // Check that got values fall in expected intervals
  let matched = true;
  const expected_strings: string[][] = [...Array(got.elements.length)].map(_ => [
    ...Array(got.elements[0].length),
  ]);

  got.elements.forEach((c, i) => {
    c.forEach((r, j) => {
      const g = r.value as number;
      if (expected[i][j].contains(g)) {
        expected_strings[i][j] = Colors.green(`[${expected[i][j]}]`);
      } else {
        matched = false;
        expected_strings[i][j] = Colors.red(`[${expected[i][j]}]`);
      }
    });
  });

  return {
    matched,
    got: convertArrayToString(got.elements.map(convertArrayToString)),
    expected: convertArrayToString(expected_strings.map(convertArrayToString)),
  };
}

/**
 * compare() compares 'got' to 'expected', returning the Comparison information.
 * @param got the result obtained from the test
 * @param expected the expected result
 * @returns the comparison results
 */
export function compare(
  got: Value,
  expected: Value | FPInterval | FPInterval[] | FPInterval[][]
): Comparison {
  if (expected instanceof Array) {
    if (expected[0] instanceof Array) {
      expected = expected as FPInterval[][];
      return compareMatrix(got, expected);
    } else {
      expected = expected as FPInterval[];
      return compareVector(got, expected);
    }
  }

  if (expected instanceof FPInterval) {
    return compareInterval(got, expected);
  }

  return compareValue(got, expected);
}

/** @returns a Comparator that checks whether a test value matches any of the provided options */
export function anyOf(...expectations: Expectation[]): Comparator {
  const c: Comparator = {
    compare: (got: Value) => {
      const failed = new Set<string>();
      for (const e of expectations) {
        const cmp = toComparator(e).compare(got);
        if (cmp.matched) {
          return cmp;
        }
        failed.add(cmp.expected);
      }
      return { matched: false, got: got.toString(), expected: [...failed].join(' or ') };
    },
    kind: 'anyOf',
  };

  if (getIsBuildingDataCache()) {
    // If there's an active DataCache, and it supports storing, then append the
    // Expectations to the result, so it can be serialized.
    c.data = expectations;
  }
  return c;
}

/** @returns a Comparator that skips the test if the expectation is undefined */
export function skipUndefined(expectation: Expectation | undefined): Comparator {
  const c: Comparator = {
    compare: (got: Value) => {
      if (expectation !== undefined) {
        return toComparator(expectation).compare(got);
      }
      return { matched: true, got: got.toString(), expected: `Treating 'undefined' as Any` };
    },
    kind: 'skipUndefined',
  };

  if (expectation !== undefined && getIsBuildingDataCache()) {
    // If there's an active DataCache, and it supports storing, then append the
    // Expectation to the result, so it can be serialized.
    c.data = expectation;
  }
  return c;
}

/**
 * @returns a Comparator that always passes, used to test situations where the
 * result of computation doesn't matter, but the fact it finishes is being
 * tested.
 */
export function alwaysPass(msg: string = 'always pass'): Comparator {
  const c: Comparator = {
    compare: (got: Value) => {
      return { matched: true, got: got.toString(), expected: msg };
    },
    kind: 'alwaysPass',
  };

  if (getIsBuildingDataCache()) {
    // If there's an active DataCache, and it supports storing, then append the
    // message string to the result, so it can be serialized.
    c.data = msg;
  }
  return c;
}

/** serializeComparator() serializes a Comparator to a BinaryStream */
export function serializeComparator(s: BinaryStream, c: Comparator) {
  serializeComparatorKind(s, c.kind);
  switch (c.kind) {
    case 'anyOf':
      s.writeArray(c.data as Expectation[], serializeExpectation);
      return;
    case 'skipUndefined':
      s.writeCond(c.data !== undefined, {
        if_true: () => {
          // defined data
          serializeExpectation(s, c.data as Expectation);
        },
        if_false: () => {
          // undefined data
        },
      });
      return;
    case 'alwaysPass': {
      s.writeString(c.data as string);
      return;
    }
    case 'value':
    case 'packed': {
      unreachable(`Serializing '${c.kind}' comparators is not allowed (${c})`);
      break;
    }
  }
  unreachable(`Unable serialize comparator '${c}'`);
}

/** deserializeComparator() deserializes a Comparator from a BinaryStream */
export function deserializeComparator(s: BinaryStream): Comparator {
  const kind = deserializeComparatorKind(s);
  switch (kind) {
    case 'anyOf':
      return anyOf(...s.readArray(deserializeExpectation));
    case 'skipUndefined':
      return s.readCond({
        if_true: () => {
          // defined data
          return skipUndefined(deserializeExpectation(s));
        },
        if_false: () => {
          // undefined data
          return skipUndefined(undefined);
        },
      });
    case 'alwaysPass':
      return alwaysPass(s.readString());
  }
  unreachable(`Unable deserialize comparator '${s}'`);
}
