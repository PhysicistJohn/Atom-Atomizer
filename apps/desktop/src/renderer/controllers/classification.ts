import {
  signalDetectionConfigSchema,
  zeroSpanConfigSchema,
  projectDetectedPowerTuneHz,
  type DetectedSignal,
  type SignalDetectionConfig,
  type Sweep,
  type WaveformClassification,
} from '@tinysa/contracts';
import { BAYESIAN_OBSERVABLE_ZERO_SPAN_GEOMETRY, type ClassificationCaptureTargetProjection, type WaveformEvidence } from '@tinysa/analysis';
import {
  resolveVisibleClassificationTargetSelection,
  visibleClassificationTargetProjectionAdmission,
  type ClassificationTargetSelection,
} from '../classification-target-selection.js';
import {
  exactClassificationEvidenceSweeps,
  selectVisibleClassificationRepresentative,
} from '../classification-work-admission.js';
import { reconcileDetectedPowerConfiguration } from '../instrument-configuration.js';
import { captureReceiptRepresentativeMatches, classificationWorkRevision } from './classification-helpers.js';
import {
  errorMessage,
  type AutomaticClassificationDrainState,
  type AutomaticClassificationOperationRecord,
  type AutomaticDetectedPowerStaging,
  type ClassificationExecutionRecord,
  type ClassificationWork,
  type DirectClassificationTaskRecord,
  type FrozenAutomaticClassificationSnapshot,
  type RendererKernel,
} from './kernel.js';

export class ClassificationController {
  constructor(private readonly k: RendererKernel) {}

  admitClassificationWork(work: ClassificationWork, options: { drainedFromQueue?: boolean } = {}): void {
    const k = this.k;
    if (work.requests.length === 0) return;
    // One active (or scheduled) inference plus one replaceable newest work
    // item is the complete queue. Every underlying sweep has already entered
    // history/tracking; superseding only avoids publishing obsolete derived
    // results and prevents unbounded Promise/worker-message growth.
    if (k.classificationTask.current) {
      k.pendingClassificationWork.current = work;
      return;
    }
    const abortController = new AbortController();
    const task = this.processClassificationWorkAfterPaint(work, abortController.signal, options.drainedFromQueue === true);
    k.classificationTask.current = task;
    k.classificationTaskWork.current = work;
    k.classificationTaskAbortController.current = abortController;
    void task.finally(() => this.finishClassificationTask(task));
  }

  async processClassificationWorkAfterPaint(
    work: ClassificationWork,
    signal: AbortSignal,
    drainedFromQueue = false,
  ): Promise<ClassificationExecutionRecord> {
    const k = this.k;
    // A fresh admission yields one macrotask so paint/input work runs before
    // inference. A queued item drained by the previous task's completion has
    // already waited at least that long; a second hop here (combined with the
    // store's scheduler-batched notifications) lands every subsequent sweep's
    // classification one event-loop window late — a sustained one-sweep lag
    // in continuous mode.
    if (!drainedFromQueue) await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    if (signal.aborted) {
      return { work, status: 'failed', error: errorMessage(signal.reason) };
    }
    if (!this.classificationWorkLifecycleIsCurrent(work)) {
      const failure = new Error('Classification evidence revision was superseded before inference');
      this.failClassificationExecution(work, failure);
      return { work, status: 'failed', error: failure.message };
    }
    try {
      const results = await this.waitForClassificationSource(
        Promise.all(work.requests.map(({ detection, evidence }) =>
          k.requireClassifierRuntime().classifier.classify(detection, evidence, signal))),
        signal,
      );
      this.publishClassificationResults(work, results);
      return { work, status: 'ready', results };
    } catch (value) {
      // The spectrum/detection evidence remains valid when the optional model
      // worker is unavailable or rejects an observation. Keep acquisition
      // running, clear the stale projection, and make the capability-local
      // failure visible.
      if (!signal.aborted && this.classificationWorkLifecycleIsCurrent(work)) {
        this.failClassificationExecution(work, value);
        k.set({ classifications: [] });
        k.set({ error: `Bayesian classification unavailable: ${errorMessage(value)}` });
      }
      return { work, status: 'failed', error: errorMessage(value) };
    }
  }

  finishClassificationTask(task: Promise<ClassificationExecutionRecord>): void {
    const k = this.k;
    if (k.classificationTask.current !== task) return;
    k.classificationTask.current = undefined;
    k.classificationTaskWork.current = undefined;
    k.classificationTaskAbortController.current = undefined;
    const pending = k.pendingClassificationWork.current;
    k.pendingClassificationWork.current = undefined;
    if (pending) this.admitClassificationWork(pending, { drainedFromQueue: true });
  }

  classificationWorkIsCurrent(work: ClassificationWork): boolean {
    return this.classificationWorkLifecycleIsCurrent(work)
      && this.classificationWorkTargetIsCurrent(work)
      && (work.ownership !== undefined || work.sequence === this.k.analysisSequence.current);
  }

  classificationWorkLifecycleIsCurrent(work: ClassificationWork): boolean {
    if (!this.k.rendererMounted.current) return false;
    return work.ownership ? this.k.acquisition.isCurrentContinuousOwnership(work.ownership) : true;
  }

  classificationWorkTargetIsCurrent(work: ClassificationWork): boolean {
    const k = this.k;
    const currentSweep = k.state.sweep;
    if (!currentSweep) return false;
    const selection = resolveVisibleClassificationTargetSelection(
      k.state.detections,
      currentSweep,
      k.state.explicitClassificationId,
    );
    return selection.origin === work.target.selectionOrigin
      && selection.detectionId === work.target.projectedRepresentativeId
      && (selection.rawTargetId ?? selection.detectionId) === work.target.rawTargetId;
  }

  stageClassificationExecution(work: ClassificationWork): void {
    this.k.classificationExecution.current = { work, status: 'inference-pending' };
  }

  completeClassificationExecution(
    work: ClassificationWork,
    results: readonly WaveformClassification[],
  ): void {
    if (this.k.classificationExecution.current?.work.revision !== work.revision) return;
    this.k.classificationExecution.current = { work, status: 'ready', results };
  }

  failClassificationExecution(work: ClassificationWork, value: unknown): void {
    if (this.k.classificationExecution.current?.work.revision !== work.revision) return;
    this.k.classificationExecution.current = {
      work,
      status: 'failed',
      error: errorMessage(value),
    };
  }

  publishClassificationResults(
    work: ClassificationWork,
    results: readonly WaveformClassification[],
  ): void {
    const k = this.k;
    if (!this.classificationWorkLifecycleIsCurrent(work)
      || !this.classificationWorkTargetIsCurrent(work)) return;
    if (!work.ownership) {
      if (work.sequence === k.analysisSequence.current) {
        this.completeClassificationExecution(work, results);
        k.set({ classifications: k.agent.classificationResultsBoundToWork(work, results) });
      }
      return;
    }
    if (k.pinnedAutomaticClassificationRevisions.current.has(work.revision)) {
      const currentSweep = k.state.sweep;
      if (!currentSweep
        || currentSweep.id !== work.visibleSweep.id
        || currentSweep.sequence !== work.visibleSweep.sequence
        || work.sequence !== k.analysisSequence.current) return;
    }
    if (work.sequence <= k.lastPublishedClassificationSequence.current) return;
    const currentId = this.currentSelectedClassificationRepresentative()?.id;
    const requestIds = new Set(work.requests.map(({ detection }) => detection.id));
    const admitted = results.filter((result) =>
      requestIds.has(result.detectionId) && result.detectionId === currentId);
    if (admitted.length === 0) return;
    k.lastPublishedClassificationSequence.current = work.sequence;
    this.completeClassificationExecution(work, admitted);
    k.set({ classifications: k.agent.classificationResultsBoundToWork(work, admitted) });
  }

  currentSelectedClassificationRepresentative(): DetectedSignal | undefined {
    const k = this.k;
    const visibleSweep = k.state.sweep;
    if (!visibleSweep) return undefined;
    return selectVisibleClassificationRepresentative(
      k.state.detections,
      visibleSweep,
      k.state.explicitClassificationId,
    )?.detection;
  }

  clearClassificationCapture(): void {
    const k = this.k;
    k.zeroCaptureReceiptRef.current = undefined;
    k.zeroCaptureSpectrumSweepIdsRef.current = undefined;
    k.set({ zeroCapture: undefined, envelope: undefined });
  }

  sameClassificationSelectionIdentity(
    left: ClassificationTargetSelection,
    right: ClassificationTargetSelection,
  ): boolean {
    return left.origin === right.origin
      && left.detectionId === right.detectionId
      && (left.rawTargetId ?? left.detectionId)
        === (right.rawTargetId ?? right.detectionId);
  }

  supersedeClassificationSelectionIfChanged(
    previous: ClassificationTargetSelection,
    next: ClassificationTargetSelection,
  ): void {
    if (!this.sameClassificationSelectionIdentity(previous, next)) {
      this.k.classificationSelectionRevision.current++;
    }
  }

  classificationSelectionStillOwns(
    revision: number,
    expected: ClassificationTargetSelection,
  ): boolean {
    const k = this.k;
    if (k.classificationSelectionRevision.current !== revision) return false;
    const current = resolveVisibleClassificationTargetSelection(
      k.state.detections,
      k.state.sweep,
      k.state.explicitClassificationId,
    );
    return this.sameClassificationSelectionIdentity(current, expected);
  }

  stageClassificationCandidate(detectionId: string | undefined): number | undefined {
    const k = this.k;
    const changed = detectionId !== k.stagedClassificationTargetIdRef.current;
    k.stagedClassificationTargetIdRef.current = detectionId;
    if (changed) {
      this.clearClassificationCapture();
      // Classifier output is owned by the selected target, not merely by a
      // still-visible detection ID. Never show or republish the prior target's
      // result while the next selected-target evidence revision is pending.
      k.set({ classifications: [] });
    }
    if (!detectionId) return undefined;
    const detection = k.state.detections.find((candidate) => candidate.id === detectionId);
    const capability = k.state.instrument.session?.capabilities.acquisitions
      .find((candidate) => candidate.kind === 'detected-power-timeseries');
    if (!detection || capability?.kind !== 'detected-power-timeseries') return undefined;
    const frequencyHz = projectDetectedPowerTuneHz(detection.peakHz, capability.centerFrequencyHz);
    k.measurement.updateZeroSpanConfiguration((current) => reconcileDetectedPowerConfiguration(
      capability,
      zeroSpanConfigSchema.parse({
        ...current,
        ...BAYESIAN_OBSERVABLE_ZERO_SPAN_GEOMETRY,
        frequencyHz,
      }),
    ));
    return frequencyHz;
  }

  safelyStageClassificationCandidate(detectionId: string | undefined): {
    readonly centerHz?: number;
    readonly failure?: string;
  } {
    try {
      const centerHz = this.stageClassificationCandidate(detectionId);
      this.k.set({ detectedPowerTargetStagingFailure: undefined });
      return centerHz === undefined ? {} : { centerHz };
    } catch (value) {
      const failure = errorMessage(value);
      this.k.set({ detectedPowerTargetStagingFailure: failure });
      return { failure };
    }
  }

  selectClassificationCandidate(detectionId: string | undefined): {
    readonly centerHz?: number;
    readonly failure?: string;
  } {
    const k = this.k;
    const currentDetections = k.state.detections;
    const previousSelection = resolveVisibleClassificationTargetSelection(
      currentDetections,
      k.state.sweep,
      k.state.explicitClassificationId,
    );
    const selection = resolveVisibleClassificationTargetSelection(
      currentDetections,
      k.state.sweep,
      detectionId,
    );
    const selectionConditionChanged = !this.sameClassificationSelectionIdentity(
      previousSelection,
      selection,
    );
    this.supersedeClassificationSelectionIfChanged(previousSelection, selection);
    k.set({ explicitClassificationId: selection.explicitDetectionId });
    const staged = this.safelyStageClassificationCandidate(
      selection.rawTargetId ?? selection.detectionId,
    );
    // Automatic rank-zero and operator-preferred capture are different
    // statistical conditions even when they tune the same physical row.
    if (selectionConditionChanged) {
      if (k.state.zeroCapture || k.zeroCaptureReceiptRef.current) {
        this.clearClassificationCapture();
      }
      k.set({ classifications: [] });
    }
    return staged;
  }

  freezeAutomaticClassificationSnapshot(): FrozenAutomaticClassificationSnapshot {
    const k = this.k;
    const visibleSweep = k.state.sweep;
    const detections = [...k.state.detections];
    const rankingAdmission = visibleClassificationTargetProjectionAdmission(
      detections,
      visibleSweep,
    );
    return {
      ...(visibleSweep ? { visibleSweep } : {}),
      detections,
      history: [...k.state.history],
      analysisSequence: k.analysisSequence.current,
      rankingAdmission,
      projections: rankingAdmission.projections,
    };
  }

  freezeAutomaticDetectedPowerStaging(
    winner: ClassificationCaptureTargetProjection | undefined,
    stagedCenterHz: number | undefined,
    stagingFailure?: string,
  ): AutomaticDetectedPowerStaging {
    const k = this.k;
    if (!winner) {
      return {
        status: 'not-requested',
        reason: 'no-ranked-target',
        centerHz: null,
        configuration: null,
      };
    }
    if (stagedCenterHz !== undefined) {
      return {
        status: 'staged',
        centerHz: stagedCenterHz,
        configuration: structuredClone(k.state.zeroConfig),
      };
    }
    const capability = k.state.instrument.session?.capabilities.acquisitions
      .find((candidate) => candidate.kind === 'detected-power-timeseries');
    return {
      status: 'unavailable',
      reason: capability?.kind === 'detected-power-timeseries'
        ? 'target-not-stageable'
        : 'detected-power-capability-unavailable',
      ...(stagingFailure ? { error: stagingFailure } : {}),
      centerHz: null,
      configuration: null,
    };
  }

  async executeFrozenAutomaticClassification(
    work: ClassificationWork,
    signal?: AbortSignal,
  ): Promise<ClassificationExecutionRecord> {
    const k = this.k;
    try {
      signal?.throwIfAborted();
      const results = await this.waitForClassificationSource(
        Promise.all(work.requests.map(({ detection, evidence }) =>
          k.requireClassifierRuntime().classifier.classify(detection, evidence, signal))),
        signal,
      );
      return { work, status: 'ready', results };
    } catch (value) {
      return { work, status: 'failed', error: errorMessage(value) };
    }
  }

  waitForClassificationSource<T>(
    source: Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!signal) return source;
    try { signal.throwIfAborted(); }
    catch (value) { return Promise.reject(value); }
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (settle: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abort);
        settle();
      };
      const abort = () => finish(() => reject(
        signal.reason ?? new DOMException('The operation was aborted', 'AbortError'),
      ));
      signal.addEventListener('abort', abort, { once: true });
      void source.then(
        (value) => finish(() => resolve(value)),
        (reason) => finish(() => reject(reason)),
      );
    });
  }

  retireClassificationOperations(reason: string): void {
    const k = this.k;
    k.lastAutomaticClassificationOperation.current = undefined;
    k.classificationExecution.current = undefined;
    k.pendingClassificationWork.current = undefined;
    const taskAbortController = k.classificationTaskAbortController.current;
    if (taskAbortController && !taskAbortController.signal.aborted) {
      taskAbortController.abort(new Error(reason));
    }
    const direct = k.directClassificationTask.current;
    if (direct && !direct.abortController.signal.aborted) {
      direct.abortController.abort(new Error(reason));
    }
    k.automaticClassificationDrainGeneration.current++;
    const drain = k.automaticClassificationDrain.current;
    if (drain && !drain.abortController.signal.aborted) {
      drain.abortController.abort(new Error(reason));
    }
  }

  settleAutomaticClassificationOperation(
    operation: AutomaticClassificationOperationRecord,
    outcome: ClassificationExecutionRecord,
  ): void {
    const k = this.k;
    operation.execution = outcome;
    if (k.lastAutomaticClassificationOperation.current !== operation) return;
    const work = operation.work;
    if (!work) return;
    if (outcome.status === 'ready' && outcome.results) {
      if (k.classificationExecution.current?.work.revision === work.revision) {
        this.completeClassificationExecution(work, outcome.results);
      }
      // A pinned operation is independently pollable, but it may affect the
      // visible cards only while its exact sweep and selection still own UI.
      if (this.classificationWorkIsCurrent(work)) {
        k.set({ classifications: k.agent.classificationResultsBoundToWork(work, outcome.results) });
      }
    } else if (outcome.status === 'failed'
      && k.classificationExecution.current?.work.revision === work.revision) {
      this.failClassificationExecution(work, outcome.error ?? 'Bayesian classification failed');
    }
  }

  exactInFlightClassificationPromise(
    work: ClassificationWork,
  ): Promise<ClassificationExecutionRecord> | undefined {
    const k = this.k;
    if (k.classificationTaskWork.current?.revision === work.revision) {
      return k.classificationTask.current;
    }
    const direct = k.directClassificationTask.current;
    return direct?.work.revision === work.revision ? direct.promise : undefined;
  }

  async executePinnedAutomaticClassification(
    operation: AutomaticClassificationOperationRecord,
    signal: AbortSignal,
    preferredSource?: Promise<ClassificationExecutionRecord>,
  ): Promise<ClassificationExecutionRecord> {
    const k = this.k;
    const work = operation.work;
    if (!work) throw new Error('Automatic classification operation omitted frozen work');
    k.pinnedAutomaticClassificationRevisions.current.set(
      work.revision,
      (k.pinnedAutomaticClassificationRevisions.current.get(work.revision) ?? 0) + 1,
    );
    try {
      let outcome: ClassificationExecutionRecord;
      try {
        const source = preferredSource ?? this.exactInFlightClassificationPromise(work);
        outcome = source
          ? await this.waitForClassificationSource(source, signal)
          : await this.executeFrozenAutomaticClassification(work, signal);
      } catch (value) {
        outcome = { work, status: 'failed', error: errorMessage(value) };
      }
      // The normal classification lane may reject before inference when its
      // renderer lifecycle is superseded. Retry from the frozen evidence only
      // while this exact Auto operation remains the pollable owner. Stop does
      // not clear that owner; a newer Auto, device change, or span invalidation
      // does, and therefore must never trigger hidden work afterward.
      if (outcome.status === 'failed'
        && outcome.error === 'Classification evidence revision was superseded before inference'
        && !signal.aborted
        && k.lastAutomaticClassificationOperation.current === operation) {
        return this.executeFrozenAutomaticClassification(work, signal);
      }
      return outcome;
    } finally {
      const remaining = (k.pinnedAutomaticClassificationRevisions.current.get(work.revision) ?? 1) - 1;
      if (remaining > 0) k.pinnedAutomaticClassificationRevisions.current.set(work.revision, remaining);
      else k.pinnedAutomaticClassificationRevisions.current.delete(work.revision);
    }
  }

  startAutomaticClassificationDrain(
    operation: AutomaticClassificationOperationRecord,
    preferredSource?: Promise<ClassificationExecutionRecord>,
  ): Promise<ClassificationExecutionRecord> {
    const k = this.k;
    const state: AutomaticClassificationDrainState = {
      generation: k.automaticClassificationDrainGeneration.current,
      abortController: new AbortController(),
      activeOperation: operation,
    };
    const promise = (async (): Promise<ClassificationExecutionRecord> => {
      let activeOperation = operation;
      let source = preferredSource;
      let precedingOutcome: ClassificationExecutionRecord | undefined;
      while (true) {
        state.activeOperation = activeOperation;
        const activeWork = activeOperation.work;
        if (!activeWork) {
          throw new Error('Automatic classification drain omitted frozen work');
        }
        const outcome = precedingOutcome?.work.revision === activeWork.revision
          ? { ...precedingOutcome, work: activeWork }
          : await this.executePinnedAutomaticClassification(
            activeOperation,
            state.abortController.signal,
            source,
          );
        if (state.generation !== k.automaticClassificationDrainGeneration.current
          || state.abortController.signal.aborted) {
          // Invalidation aborts the active source but retains this one drain
          // slot until the abort settles. A synchronous post-invalidation
          // Auto can attach one replaceable latest operation to the same
          // promise; rotate its generation/controller only after the retired
          // work has released the slot. With no replacement, cleanup clears
          // the drain before the next browser event can start another one.
          const replacement = k.lastAutomaticClassificationOperation.current;
          if (!replacement?.work
            || replacement.execution?.status !== 'inference-pending'
            || replacement.promise !== state.promise) return outcome;
          activeOperation = replacement;
          state.generation = k.automaticClassificationDrainGeneration.current;
          state.abortController = new AbortController();
          source = replacement.preferredSource;
          precedingOutcome = undefined;
          continue;
        }
        this.settleAutomaticClassificationOperation(activeOperation, outcome);

        const latest = k.lastAutomaticClassificationOperation.current;
        if (!latest?.work
          || latest === activeOperation
          || latest.execution?.status !== 'inference-pending'
          || latest.promise !== state.promise) return outcome;
        activeOperation = latest;
        source = latest.preferredSource;
        precedingOutcome = outcome;
      }
    })();
    state.promise = promise;
    k.automaticClassificationDrain.current = state;
    operation.promise = promise;
    void promise.then(
      () => {
        if (k.automaticClassificationDrain.current === state) {
          k.automaticClassificationDrain.current = undefined;
        }
      },
      () => {
        if (k.automaticClassificationDrain.current === state) {
          k.automaticClassificationDrain.current = undefined;
        }
      },
    );
    return promise;
  }

  async selectAutomaticClassificationCandidate() {
    const k = this.k;
    // Freeze every authority input before changing selection. No awaited work
    // is allowed to move the visible target/rank window under this operation.
    const snapshot = this.freezeAutomaticClassificationSnapshot();
    const supersededOperation = k.lastAutomaticClassificationOperation.current;
    const winner = snapshot.projections[0];
    const previousSelection = resolveVisibleClassificationTargetSelection(
      snapshot.detections,
      snapshot.visibleSweep,
      k.state.explicitClassificationId,
    );
    const automaticSelection: ClassificationTargetSelection = {
      ...(winner ? {
        detectionId: winner.projectedRepresentative.id,
        ...(winner.rawTarget.id === winner.projectedRepresentative.id
          ? {}
          : { rawTargetId: winner.rawTarget.id }),
      } : {}),
      origin: 'automatic',
    };
    const priorWasExplicit = k.state.explicitClassificationId !== undefined;
    const hadSelectionConditionedCapture = k.state.zeroCapture !== undefined
      || k.zeroCaptureReceiptRef.current !== undefined;
    if (priorWasExplicit
      && this.sameClassificationSelectionIdentity(previousSelection, automaticSelection)) {
      // The explicit intent ref itself owns an operator-conditioned capture,
      // even if a newly invalid rank can no longer resolve that ID.
      k.classificationSelectionRevision.current++;
    } else {
      this.supersedeClassificationSelectionIfChanged(
        previousSelection,
        automaticSelection,
      );
    }
    k.set({ explicitClassificationId: undefined });
    // Detected-power tuning is an optional capability-local projection. A
    // range/lattice rejection must not suppress valid spectrum inference.
    const stagedDetectedPower = this.safelyStageClassificationCandidate(
      winner?.rawTarget.id,
    );
    // This exact staging object is part of the operation receipt. Never read
    // the staged zero config again after inference yields to another UI action.
    const detectedPowerStaging = this.freezeAutomaticDetectedPowerStaging(
      winner,
      stagedDetectedPower.centerHz,
      stagedDetectedPower.failure,
    );
    // A preferred-target receipt is a different statistical condition from
    // automatic rank zero even when both project to the same raw tune owner.
    if (priorWasExplicit) {
      if (hadSelectionConditionedCapture) this.clearClassificationCapture();
      k.set({ classifications: [] });
    }

    const operation: AutomaticClassificationOperationRecord = {
      operationId: ++k.automaticClassificationOperationSequence.current,
      snapshot,
      selection: automaticSelection,
      detectedPowerStaging,
    };
    // A newer Auto action is the only operation allowed to supersede this
    // poll target. Ordinary sweeps, stops, and manual retargets cannot.
    k.lastAutomaticClassificationOperation.current = operation;
    if (snapshot.visibleSweep && winner
      && snapshot.rankingAdmission.status === 'ready') {
      const evidenceSweeps = exactClassificationEvidenceSweeps(
        winner.projectedRepresentative,
        snapshot.history,
      );
      if (evidenceSweeps && evidenceSweeps.length > 0) {
        const evidence = this.classificationEvidenceForDetection(
          winner.projectedRepresentative,
          evidenceSweeps,
        );
        const work: ClassificationWork = {
          revision: classificationWorkRevision(
            snapshot.analysisSequence,
            snapshot.visibleSweep,
            automaticSelection,
            evidence,
          ),
          sequence: snapshot.analysisSequence,
          visibleSweep: {
            id: snapshot.visibleSweep.id,
            sequence: snapshot.visibleSweep.sequence,
            capturedAt: snapshot.visibleSweep.capturedAt,
          },
          target: {
            projectedRepresentativeId: winner.projectedRepresentative.id,
            rawTargetId: winner.rawTarget.id,
            selectionOrigin: 'automatic',
          },
          requests: [{ detection: winner.projectedRepresentative, evidence }],
        };
        operation.work = work;
        const activeAutomaticOperation = k.automaticClassificationDrain.current?.activeOperation;
        const reusableAutomaticOperation = [
          supersededOperation,
          activeAutomaticOperation,
        ].find((candidate) => candidate?.work?.revision === work.revision
          && (candidate.execution?.status === 'inference-pending'
            || candidate.execution?.status === 'ready'));
        if (reusableAutomaticOperation) {
          // Repeated Auto on the exact frozen revision reuses one receipt and
          // one promise. If it selects the currently active root, any queued
          // different revision is atomically discarded rather than chained.
          k.lastAutomaticClassificationOperation.current = reusableAutomaticOperation;
          if (reusableAutomaticOperation.execution?.status === 'ready'
            && reusableAutomaticOperation.execution.results) {
            k.set({ classifications: k.agent.classificationResultsBoundToWork(
              reusableAutomaticOperation.work!,
              reusableAutomaticOperation.execution.results,
            ) });
          }
          return k.agent.agentAutomaticClassificationSelection(
            reusableAutomaticOperation.snapshot,
            reusableAutomaticOperation.detectedPowerStaging,
            reusableAutomaticOperation.execution,
          );
        }
        const currentExecution = k.classificationExecution.current;
        if (currentExecution?.work.revision === work.revision
          && currentExecution.status === 'ready'
          && currentExecution.results) {
          operation.execution = currentExecution;
          k.set({ classifications: currentExecution.results.filter((result) =>
            k.agent.agentClassificationResultBinding(currentExecution.work, result).bound) });
        } else {
          this.stageClassificationExecution(work);
          operation.execution = { work, status: 'inference-pending' };
          if (k.classifierRuntime.current?.status !== 'unavailable') {
            const existingDrain = k.automaticClassificationDrain.current;
            const canAwaitWithoutBlockingAnotherLane = !k.continuousRequested.current
              && !k.classificationTask.current
              && !k.directClassificationTask.current
              && !existingDrain;
            if (k.pendingClassificationWork.current?.revision === work.revision) {
              k.pendingClassificationWork.current = undefined;
            }
            const exactSource = this.exactInFlightClassificationPromise(work);
            const existingDrainPromise = existingDrain?.promise;
            if (existingDrainPromise && exactSource) {
              // The one replaceable latest operation retains its exact
              // normal/direct receipt even if that task settles before the
              // unrelated active Auto root releases the drain. Dropping this
              // source would cause a second inference for the same revision.
              operation.preferredSource = exactSource;
            }
            const promise = existingDrainPromise ?? this.startAutomaticClassificationDrain(
              operation,
              exactSource,
            );
            if (existingDrainPromise) operation.promise = existingDrainPromise;
            if (canAwaitWithoutBlockingAnotherLane) {
              await promise;
            }
          }
        }
      }
    }
    return k.agent.agentAutomaticClassificationSelection(
      snapshot,
      detectedPowerStaging,
      operation.execution,
    );
  }

  classificationEvidenceForDetection(
    detection: DetectedSignal,
    sweeps: readonly Sweep[],
  ): WaveformEvidence {
    const k = this.k;
    const capture = k.state.zeroCapture;
    const receipt = k.zeroCaptureReceiptRef.current;
    const spectrumSweepIds = k.zeroCaptureSpectrumSweepIdsRef.current;
    if (!capture
      || !receipt
      || !spectrumSweepIds
      || receipt.selection.projectedRepresentativeId !== detection.id
      || !captureReceiptRepresentativeMatches(receipt, detection)) {
      return { sweeps };
    }
    return {
      sweeps,
      zeroSpan: capture,
      zeroSpanSpectrumSweepIds: spectrumSweepIds,
      detectedPowerCaptureReceipt: receipt,
    };
  }

  drainPendingClassificationWorkIfIdle(): void {
    const k = this.k;
    if (k.classificationTask.current || k.directClassificationTask.current) return;
    const pending = k.pendingClassificationWork.current;
    k.pendingClassificationWork.current = undefined;
    if (pending) this.admitClassificationWork(pending, { drainedFromQueue: true });
  }

  registerDirectClassificationTask(
    work: ClassificationWork,
    promise: Promise<ClassificationExecutionRecord>,
    abortController: AbortController,
  ): DirectClassificationTaskRecord {
    const record = { work, promise, abortController } satisfies DirectClassificationTaskRecord;
    this.k.directClassificationTask.current = record;
    void promise.then(
      () => this.finishDirectClassificationTask(record),
      () => this.finishDirectClassificationTask(record),
    );
    return record;
  }

  finishDirectClassificationTask(record: DirectClassificationTaskRecord): void {
    if (this.k.directClassificationTask.current !== record) return;
    this.k.directClassificationTask.current = undefined;
    this.drainPendingClassificationWorkIfIdle();
  }

  classifyRecordedSweep(
    recorded: { readonly classification?: ClassificationWork },
  ): Promise<ClassificationExecutionRecord | undefined> {
    const work = recorded.classification;
    if (!work || work.requests.length === 0) return Promise.resolve(undefined);
    const abortController = new AbortController();
    const promise = this.executeRecordedSweepClassification(work, abortController.signal);
    this.registerDirectClassificationTask(work, promise, abortController);
    return promise;
  }

  async executeRecordedSweepClassification(
    work: ClassificationWork,
    signal: AbortSignal,
  ): Promise<ClassificationExecutionRecord> {
    const k = this.k;
    // Yield once so React can commit the newly ingested trace before even a
    // test/non-worker classifier begins. Production inference runs in the
    // module worker and therefore remains off the renderer thread.
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    if (signal.aborted) {
      return { work, status: 'failed', error: errorMessage(signal.reason) };
    }
    if (!this.classificationWorkIsCurrent(work)) {
      const failure = new Error('Classification evidence revision was superseded before inference');
      this.failClassificationExecution(work, failure);
      return { work, status: 'failed', error: failure.message };
    }
    try {
      const results = await this.waitForClassificationSource(
        Promise.all(work.requests.map(({ detection, evidence }) =>
          k.requireClassifierRuntime().classifier.classify(detection, evidence, signal))),
        signal,
      );
      if (!signal.aborted && this.classificationWorkIsCurrent(work)) {
        this.completeClassificationExecution(work, results);
        k.set({ classifications: k.agent.classificationResultsBoundToWork(work, results) });
      }
      // The operation receipt remains bound to its frozen work even if a
      // later human action owns the UI by publication time. In that case the
      // result is returned to the initiating action but is not published into
      // the newer UI selection.
      return { work, status: 'ready', results };
    } catch (value) {
      if (!signal.aborted && this.classificationWorkIsCurrent(work)) {
        this.failClassificationExecution(work, value);
        k.set({ classifications: [], error: errorMessage(value) });
      }
      return { work, status: 'failed', error: errorMessage(value) };
    }
  }

  applyDetectionConfiguration(input: SignalDetectionConfig): SignalDetectionConfig {
    const k = this.k;
    const next = signalDetectionConfigSchema.parse(input);
    if (JSON.stringify(next) === JSON.stringify(k.state.detectionConfig)) return k.state.detectionConfig;
    k.detector.current.configure(next);
    k.tracker.current.configure(next);
    k.analysisSequence.current++;
    k.classificationSelectionRevision.current++;
    k.stagedClassificationTargetIdRef.current = undefined;
    k.set({
      detectionConfig: next,
      detections: [],
      classifications: [],
      explicitClassificationId: undefined,
    });
    this.retireClassificationOperations('Classification detector configuration was invalidated');
    this.clearClassificationCapture();
    return next;
  }
}
