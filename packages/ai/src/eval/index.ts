// The evaluation harness (PLAN §13; ADR-217), published as `@rampsmith/ai/eval`.
export {
  BUNDLED_DATASET,
  loadDataset,
  type DatasetImage,
  type DatasetLicence,
  type DatasetManifest,
  type LoadedImage,
} from './dataset.ts';
export { prepareGrade } from './grade.ts';
export {
  APPROVAL_TARGET,
  COVERAGE_THRESHOLD,
  UNSUPPORTED_LIMIT,
  approvedUneditedRate,
  mentions,
  releaseGate,
  scoreCandidate,
  selectRatingSample,
  summarize,
  summarizeRatings,
  type CandidateScore,
  type EvalSummary,
  type GraderVerdict,
  type Rating,
  type RatingSummary,
  type ReviewEvent,
} from './metrics.ts';
export {
  BUNDLED_RECORDINGS,
  RecordedTransport,
  RecordingTransport,
  promptVersionOf,
  requestKey,
  type Recording,
} from './recorded.ts';
export {
  EVAL_BUDGET_MICRO_USD,
  EVAL_TENANT,
  formatReport,
  runEval,
  type EvalOptions,
  type EvalReport,
} from './runner.ts';
