import type { QualityCheckCategory } from './types.js'

export const QUALITY_CONTRACT_VERSION = '1.0.0' as const

/**
 * Public issue codes are append-only within contract v1. Text may change, but
 * automation can safely baseline, suppress, and ratchet these identifiers.
 */
export const QUALITY_CODES = {
  validation: 'quality.validation',
  buildPassed: 'quality.build.passed',
  buildFailed: 'quality.build.failed',
  linkOk: 'quality.link.ok',
  linkBroken: 'quality.link.broken',
  linkUnavailable: 'quality.link.unavailable',
  linkSkipped: 'quality.link.skipped',
  examplePassed: 'quality.example.passed',
  exampleFailed: 'quality.example.failed',
  exampleSourceVerified: 'quality.example.source-verified',
  schemaPassed: 'quality.schema.passed',
  schemaIssue: 'quality.schema.issue',
  accessibilityPassed: 'quality.accessibility.passed',
  accessibilityIssue: 'quality.accessibility.issue',
  accessibilityManual: 'quality.accessibility.manual-review',
  visualMatched: 'quality.visual.matched',
  visualChanged: 'quality.visual.changed',
  visualCreated: 'quality.visual.created',
  visualSkipped: 'quality.visual.skipped',
  lintIssue: 'quality.lint.issue',
  lintPassed: 'quality.lint.passed',
  claimVerified: 'quality.claim.verified',
  claimInferred: 'quality.claim.inferred',
  claimContradicted: 'quality.claim.contradicted',
  claimNeedsHuman: 'quality.claim.needs-human',
  ratchetBaselineMissing: 'quality.ratchet.baseline-missing',
  ratchetBaselineInvalid: 'quality.ratchet.baseline-invalid',
} as const

export const QUALITY_CATEGORIES: readonly QualityCheckCategory[] = [
  'validation',
  'build',
  'links',
  'examples',
  'schemas',
  'accessibility',
  'visual',
  'lint',
  'claims',
]
