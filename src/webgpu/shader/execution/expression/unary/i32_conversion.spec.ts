export const description = `
Execution Tests for the i32 conversion operations
`;

import { makeTestGroup } from '../../../../../common/framework/test_group.js';
import { GPUTest } from '../../../../gpu_test.js';
import { Type } from '../../../../util/conversion.js';
import { ShaderBuilder, allInputSources, run } from '../expression.js';

import { d } from './i32_conversion.cache.js';
import { unary } from './unary.js';

export const g = makeTestGroup(GPUTest);

/** Generate a ShaderBuilder based on how the test case is to be vectorized */
function vectorizeToExpression(vectorize: undefined | 2 | 3 | 4): ShaderBuilder {
  return vectorize === undefined ? unary('i32') : unary(`vec${vectorize}<i32>`);
}

g.test('bool')
  .specURL('https://www.w3.org/TR/WGSL/#value-constructor-builtin-function')
  .desc(
    `
i32(e), where e is a bool

The result is 1u if e is true and 0u otherwise
`
  )
  .params(u =>
    u.combine('inputSource', allInputSources).combine('vectorize', [undefined, 2, 3, 4] as const)
  )
  .fn(async t => {
    const cases = await d.get('bool');
    await run(t, vectorizeToExpression(t.params.vectorize), [Type.bool], Type.i32, t.params, cases);
  });

g.test('u32')
  .specURL('https://www.w3.org/TR/WGSL/#bool-builtin')
  .desc(
    `
i32(e), where e is a u32

Reinterpretation of bits
`
  )
  .params(u =>
    u.combine('inputSource', allInputSources).combine('vectorize', [undefined, 2, 3, 4] as const)
  )
  .fn(async t => {
    const cases = await d.get('u32');
    await run(t, vectorizeToExpression(t.params.vectorize), [Type.u32], Type.i32, t.params, cases);
  });

g.test('i32')
  .specURL('https://www.w3.org/TR/WGSL/#value-constructor-builtin-function')
  .desc(
    `
i32(e), where e is a i32

Identity operation
`
  )
  .params(u =>
    u.combine('inputSource', allInputSources).combine('vectorize', [undefined, 2, 3, 4] as const)
  )
  .fn(async t => {
    const cases = await d.get('i32');
    await run(t, vectorizeToExpression(t.params.vectorize), [Type.i32], Type.i32, t.params, cases);
  });

g.test('f32')
  .specURL('https://www.w3.org/TR/WGSL/#value-constructor-builtin-function')
  .desc(
    `
i32(e), where e is a f32

e is converted to i32, rounding towards zero
`
  )
  .params(u =>
    u.combine('inputSource', allInputSources).combine('vectorize', [undefined, 2, 3, 4] as const)
  )
  .fn(async t => {
    const cases = await d.get('f32');
    await run(t, vectorizeToExpression(t.params.vectorize), [Type.f32], Type.i32, t.params, cases);
  });

g.test('f16')
  .specURL('https://www.w3.org/TR/WGSL/#value-constructor-builtin-function')
  .desc(
    `
i32(e), where e is a f16

e is converted to u32, rounding towards zero
`
  )
  .params(u =>
    u.combine('inputSource', allInputSources).combine('vectorize', [undefined, 2, 3, 4] as const)
  )
  .beforeAllSubcases(t => {
    t.selectDeviceOrSkipTestCase('shader-f16');
  })
  .fn(async t => {
    const cases = await d.get('f16');
    await run(t, vectorizeToExpression(t.params.vectorize), [Type.f16], Type.i32, t.params, cases);
  });
