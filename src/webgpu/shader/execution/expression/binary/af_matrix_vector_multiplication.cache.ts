import { FP } from '../../../../util/floating_point.js';
import { sparseMatrixF64Range, sparseVectorF64Range } from '../../../../util/math.js';
import { selectNCases } from '../case.js';
import { makeCaseCache } from '../case_cache.js';

// Cases: matCxR_vecC
const mat_vec_cases = ([2, 3, 4] as const)
  .flatMap(cols =>
    ([2, 3, 4] as const).map(rows => ({
      [`mat${cols}x${rows}_vec${cols}`]: () => {
        return selectNCases(
          'binary/af_matrix_vector_multiplication_mat_vec',
          50,
          FP.abstract.generateMatrixVectorToVectorCases(
            sparseMatrixF64Range(cols, rows),
            sparseVectorF64Range(cols),
            'finite',
            FP.abstract.multiplicationMatrixVectorInterval
          )
        );
      },
    }))
  )
  .reduce((a, b) => ({ ...a, ...b }), {});

// Cases: vecR_matCxR
const vec_mat_cases = ([2, 3, 4] as const)
  .flatMap(rows =>
    ([2, 3, 4] as const).map(cols => ({
      [`vec${rows}_mat${cols}x${rows}`]: () => {
        return selectNCases(
          'binary/af_matrix_vector_multiplication_vec_mat',
          50,
          FP.abstract.generateVectorMatrixToVectorCases(
            sparseVectorF64Range(rows),
            sparseMatrixF64Range(cols, rows),
            'finite',
            FP.abstract.multiplicationVectorMatrixInterval
          )
        );
      },
    }))
  )
  .reduce((a, b) => ({ ...a, ...b }), {});

export const d = makeCaseCache('binary/af_matrix_vector_multiplication', {
  ...mat_vec_cases,
  ...vec_mat_cases,
});
