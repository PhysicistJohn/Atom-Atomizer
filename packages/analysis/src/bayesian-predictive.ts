export interface StudentTLikelihoodComponent {
  /** Unique likelihood-component identity within its class/view mixture. */
  id: string;
  /** Canonical corpus scenario that owns this component; legacy one-component models use id. */
  sourceScenarioId?: string;
  /** Deterministic within-scenario population label, not a waveform or protocol claim. */
  modeId?: string;
  /** Number of fitting representatives assigned to this component. */
  fitSampleCount?: number;
  logWeight: number;
  degreesOfFreedom: number;
  dimensions: readonly string[];
  location: readonly number[];
  scale: readonly (readonly number[])[];
}

export interface ClassLikelihoodModel {
  id: string;
  logPrior: number;
  /** Legacy single-population likelihood. New observable models fit each runtime evidence view separately. */
  components?: readonly StudentTLikelihoodComponent[];
  componentsByView?: Readonly<Record<
    'spectrum-only' | 'envelope-untimed' | 'envelope-timed',
    readonly StudentTLikelihoodComponent[]
  >>;
  /** Sorted fixed-model radial scores from generator-separated, view-matched calibration examples. */
  tailCalibrationScoresByView?: Readonly<Record<'spectrum-only' | 'envelope-untimed' | 'envelope-timed', readonly number[]>>;
}

export interface PosteriorCandidate {
  id: string;
  probability: number;
  logLikelihood: number;
  logJoint: number;
}

const validatedComponents = new WeakSet<object>();

/**
 * Validate a fitted component independently of inference caches.
 *
 * Runtime model admission calls this for every generated component so a
 * malformed asset is rejected while the classifier capability is constructed,
 * before any classify request can observe a late numerical failure.
 */
export function assertStudentTLikelihoodComponent(
  component: StudentTLikelihoodComponent,
): void {
  assertValidComponent(component);
}

/** Multivariate Student-t log likelihood under a fixed fitted component, with exact marginalization of absent dimensions. */
export function studentTLogDensity(observation: Readonly<Record<string, number>>, component: StudentTLikelihoodComponent): number {
  validateComponent(component);
  const selected = component.dimensions.map((name, index) => ({ name, index, value: observation[name] }))
    .filter((item): item is { name: string; index: number; value: number } => typeof item.value === 'number' && Number.isFinite(item.value));
  if (!selected.length) return 0;
  const location = selected.map((item) => component.location[item.index]!);
  const scale = selected.map((row) => selected.map((column) => component.scale[row.index]![column.index]!));
  const difference = selected.map((item, index) => item.value - location[index]!);
  const cholesky = choleskyDecomposition(scale);
  const solved = solveLowerTriangular(cholesky, difference);
  const mahalanobis = solved.reduce((sum, value) => sum + value * value, 0);
  const logDeterminant = 2 * cholesky.reduce((sum, row, index) => sum + Math.log(row[index]!), 0);
  const dimensions = selected.length;
  const dof = component.degreesOfFreedom;
  return logGamma((dof + dimensions) / 2)
    - logGamma(dof / 2)
    - 0.5 * (dimensions * Math.log(dof * Math.PI) + logDeterminant)
    - 0.5 * (dof + dimensions) * Math.log1p(mahalanobis / dof);
}

/**
 * Radial survival score under a fixed multivariate Student-t component.
 * It is uniform only for draws from exactly that fixed component before
 * component selection. It does not account for parameter fitting, maximizing
 * across components, or physical-data calibration.
 */
export function studentTModelTailProbability(observation: Readonly<Record<string, number>>, component: StudentTLikelihoodComponent): number {
  validateComponent(component);
  const selected = component.dimensions.map((name, index) => ({ name, index, value: observation[name] }))
    .filter((item): item is { name: string; index: number; value: number } => typeof item.value === 'number' && Number.isFinite(item.value));
  if (!selected.length) return 1;
  const location = selected.map((item) => component.location[item.index]!);
  const scale = selected.map((row) => selected.map((column) => component.scale[row.index]![column.index]!));
  const difference = selected.map((item, index) => item.value - location[index]!);
  const solved = solveLowerTriangular(choleskyDecomposition(scale), difference);
  const mahalanobis = solved.reduce((sum, value) => sum + value * value, 0);
  return regularizedIncompleteBeta(
    component.degreesOfFreedom / (component.degreesOfFreedom + mahalanobis),
    component.degreesOfFreedom / 2,
    selected.length / 2,
  );
}

export function mixtureLogLikelihood(observation: Readonly<Record<string, number>>, components: readonly StudentTLikelihoodComponent[]): number {
  if (!components.length) throw new Error('Class likelihood requires at least one component');
  return logSumExp(components.map((component) => component.logWeight + studentTLogDensity(observation, component)));
}

export function posteriorCandidates(observation: Readonly<Record<string, number>>, models: readonly ClassLikelihoodModel[]): readonly PosteriorCandidate[] {
  if (models.length < 2) throw new Error('Bayesian classification requires at least two class models');
  const values = models.map((model) => {
    if (!model.components) {
      throw new Error(`Generic posteriorCandidates requires a single-population component set for ${model.id}`);
    }
    const logLikelihood = mixtureLogLikelihood(observation, model.components);
    return { id: model.id, logLikelihood, logJoint: model.logPrior + logLikelihood };
  });
  const normalization = logSumExp(values.map((value) => value.logJoint));
  const result = values.map((value) => ({ ...value, probability: Math.exp(value.logJoint - normalization) }))
    .sort((left, right) => right.probability - left.probability);
  const total = result.reduce((sum, value) => sum + value.probability, 0);
  if (!Number.isFinite(total) || Math.abs(total - 1) > 1e-9) throw new Error('Bayesian posterior failed to normalize');
  return result;
}

export function logSumExp(values: readonly number[]): number {
  if (!values.length) throw new Error('logSumExp requires values');
  const maximum = Math.max(...values);
  if (maximum === Number.NEGATIVE_INFINITY) return maximum;
  return maximum + Math.log(values.reduce((sum, value) => sum + Math.exp(value - maximum), 0));
}

/** Lanczos approximation, accurate well beyond the positive arguments used by the predictive model. */
export function logGamma(value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error('logGamma requires a finite positive value');
  const coefficients = [
    676.5203681218851,
    -1259.1392167224028,
    771.3234287776531,
    -176.6150291621406,
    12.507343278686905,
    -0.13857109526572012,
    9.984369578019572e-6,
    1.5056327351493116e-7,
  ];
  if (value < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * value)) - logGamma(1 - value);
  let x = 0.9999999999998099;
  const shifted = value - 1;
  for (let index = 0; index < coefficients.length; index++) x += coefficients[index]! / (shifted + index + 1);
  const t = shifted + coefficients.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(x);
}

export function regularizedIncompleteBeta(value: number, left: number, right: number): number {
  if (![value, left, right].every(Number.isFinite) || value < 0 || value > 1 || left <= 0 || right <= 0) throw new Error('Regularized incomplete beta requires x in [0,1] and positive shapes');
  if (value === 0) return 0;
  if (value === 1) return 1;
  const logFront = logGamma(left + right) - logGamma(left) - logGamma(right)
    + left * Math.log(value) + right * Math.log1p(-value);
  const front = Math.exp(logFront);
  if (value < (left + 1) / (left + right + 2)) return front * betaContinuedFraction(left, right, value) / left;
  return 1 - front * betaContinuedFraction(right, left, 1 - value) / right;
}

function betaContinuedFraction(left: number, right: number, value: number): number {
  const maximumIterations = 300;
  const epsilon = 3e-14;
  const minimum = 1e-300;
  const combined = left + right;
  const leftPlusOne = left + 1;
  const leftMinusOne = left - 1;
  let c = 1;
  let d = 1 - combined * value / leftPlusOne;
  if (Math.abs(d) < minimum) d = minimum;
  d = 1 / d;
  let result = d;
  for (let iteration = 1; iteration <= maximumIterations; iteration++) {
    const even = 2 * iteration;
    let coefficient = iteration * (right - iteration) * value / ((leftMinusOne + even) * (left + even));
    d = 1 + coefficient * d;
    if (Math.abs(d) < minimum) d = minimum;
    c = 1 + coefficient / c;
    if (Math.abs(c) < minimum) c = minimum;
    d = 1 / d;
    result *= d * c;
    coefficient = -(left + iteration) * (combined + iteration) * value / ((left + even) * (leftPlusOne + even));
    d = 1 + coefficient * d;
    if (Math.abs(d) < minimum) d = minimum;
    c = 1 + coefficient / c;
    if (Math.abs(c) < minimum) c = minimum;
    d = 1 / d;
    const delta = d * c;
    result *= delta;
    if (Math.abs(delta - 1) < epsilon) return result;
  }
  throw new Error('Regularized incomplete beta failed to converge');
}

function choleskyDecomposition(matrix: readonly (readonly number[])[]): number[][] {
  if (!matrix.length || matrix.some((row) => row.length !== matrix.length)) throw new Error('Predictive scale must be a non-empty square matrix');
  const result = Array.from({ length: matrix.length }, () => Array<number>(matrix.length).fill(0));
  for (let row = 0; row < matrix.length; row++) {
    for (let column = 0; column <= row; column++) {
      let value = matrix[row]![column]!;
      for (let index = 0; index < column; index++) value -= result[row]![index]! * result[column]![index]!;
      if (row === column) {
        if (!Number.isFinite(value) || value <= 1e-12) throw new Error('Predictive scale matrix is not positive definite');
        result[row]![column] = Math.sqrt(value);
      } else {
        result[row]![column] = value / result[column]![column]!;
      }
    }
  }
  return result;
}

function solveLowerTriangular(matrix: readonly (readonly number[])[], right: readonly number[]): number[] {
  const result = Array<number>(right.length).fill(0);
  for (let row = 0; row < matrix.length; row++) {
    let value = right[row]!;
    for (let column = 0; column < row; column++) value -= matrix[row]![column]! * result[column]!;
    result[row] = value / matrix[row]![row]!;
  }
  return result;
}

function validateComponent(component: StudentTLikelihoodComponent): void {
  if (validatedComponents.has(component)) return;
  assertValidComponent(component);
  validatedComponents.add(component);
}

function assertValidComponent(component: StudentTLikelihoodComponent): void {
  if (!component.id || !Number.isFinite(component.logWeight)) throw new Error('Predictive component identity/weight is invalid');
  if (component.sourceScenarioId !== undefined && component.sourceScenarioId.trim().length === 0) throw new Error('Predictive component source scenario identity is invalid');
  if (component.modeId !== undefined && component.modeId.trim().length === 0) throw new Error('Predictive component mode identity is invalid');
  if (component.fitSampleCount !== undefined
    && (!Number.isSafeInteger(component.fitSampleCount) || component.fitSampleCount <= 0)) {
    throw new Error('Predictive component fit sample count is invalid');
  }
  if (!Number.isFinite(component.degreesOfFreedom) || component.degreesOfFreedom <= 0) throw new Error('Predictive degrees of freedom must be positive');
  if (!component.dimensions.length || component.location.length !== component.dimensions.length || component.scale.length !== component.dimensions.length) throw new Error('Predictive component dimensions are inconsistent');
  if (new Set(component.dimensions).size !== component.dimensions.length) throw new Error('Predictive component contains duplicate dimensions');
  if (component.location.some((value) => !Number.isFinite(value))) throw new Error('Predictive component location must be finite');
  for (let row = 0; row < component.scale.length; row++) {
    if (component.scale[row]!.length !== component.dimensions.length || component.scale[row]!.some((value) => !Number.isFinite(value))) throw new Error('Predictive component scale must be finite and square');
    for (let column = 0; column < component.scale.length; column++) if (Math.abs(component.scale[row]![column]! - component.scale[column]![row]!) > 1e-8) throw new Error('Predictive component scale must be symmetric');
  }
  choleskyDecomposition(component.scale);
}
