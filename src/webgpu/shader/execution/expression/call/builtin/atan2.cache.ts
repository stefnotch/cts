import { FP } from '../../../../../util/floating_point.js';
import { linearRange } from '../../../../../util/math.js';
import { makeCaseCache } from '../../case_cache.js';

// Cases: [f32|f16]_[non_]const
const cases = (['f32', 'f16'] as const)
  .flatMap(kind =>
    ([true, false] as const).map(nonConst => ({
      [`${kind}_${nonConst ? 'non_const' : 'const'}`]: () => {
        // Using sparse range since there are N^2 cases being generated, and also including extra values
        // around 0, where there is a discontinuity that implementations may behave badly at.
        const numeric_range = [
          ...FP[kind].sparseScalarRange(),
          ...linearRange(FP[kind].constants().negative.max, FP[kind].constants().positive.min, 10),
        ];
        return FP[kind].generateScalarPairToIntervalCases(
          numeric_range,
          numeric_range,
          nonConst ? 'unfiltered' : 'finite',
          FP[kind].atan2Interval
        );
      },
    }))
  )
  .reduce((a, b) => ({ ...a, ...b }), {});

export const d = makeCaseCache('atan2', cases);
