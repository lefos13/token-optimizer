import { z } from 'zod';
import type { LLMResponseTask, LLMValidationError } from './types';

/* These schemas are deliberately strict and bounded: model output is untrusted input, so malformed,
   contradictory, or unexpectedly large responses must take the existing conservative fallback path. */
const NonEmptyBoundedString = z.string().min(1).max(4000);
const BoundedString = z.string().max(4000);

export const FailureDetailSchema = z.object({
  file: z.string().max(1000).nullable(),
  reason: NonEmptyBoundedString,
  suggestedFix: z.string().max(4000).nullable(),
}).strict();

const VerdictSchemaBase = z.object({
  verdict: z.enum(['pass', 'fail', 'uncertain']),
  confidence: z.number().finite().min(0).max(1),
  summary: BoundedString,
  likelyRelevantToRecentChanges: z.boolean(),
  failures: z.array(FailureDetailSchema).max(50),
  needsRawLogs: z.boolean(),
}).strict();

export const VerdictSchema = VerdictSchemaBase.superRefine((value, ctx) => {
  if (value.verdict === 'pass' && value.failures.length > 0) {
    ctx.addIssue({ code: 'custom', path: ['failures'], message: 'pass verdict cannot contain failures' });
  }
});

export const TriageSchema = VerdictSchema;

const CodeReviewIssueSchema = z.object({
  file: NonEmptyBoundedString,
  line: z.number().int().positive().optional(),
  severity: z.enum(['error', 'warning']),
  description: NonEmptyBoundedString,
  suggestedFix: z.string().max(4000).nullable(),
}).strict();

export const ReviewSchema = z.object({
  hasIssues: z.boolean(),
  issues: z.array(CodeReviewIssueSchema).max(100),
  summary: BoundedString,
}).strict().superRefine((value, ctx) => {
  if (!value.hasIssues && value.issues.length > 0) {
    ctx.addIssue({ code: 'custom', path: ['issues'], message: 'review with issues must set hasIssues to true' });
  }
});

export const DigestSchema = z.object({
  summary: BoundedString,
  keyFindings: z.array(NonEmptyBoundedString).max(100),
  digest: BoundedString,
  needsRawLogs: z.boolean(),
}).strict();

export const ScoutSchema = z.object({
  pointers: z.array(z.object({
    file: NonEmptyBoundedString,
    lineRange: NonEmptyBoundedString,
    why: NonEmptyBoundedString,
    confidence: z.number().finite().min(0).max(1),
  }).strict()).max(100),
  suggestedNextSearches: z.array(NonEmptyBoundedString).max(100),
  summary: BoundedString,
  needsDeeperLook: z.boolean(),
}).strict();

export const QuerySchema = z.object({
  answer: BoundedString,
  relevantExcerpt: BoundedString,
  lineRange: z.string().max(200),
}).strict();

export type ParsedLLMResponse =
  | { success: true; data: z.infer<typeof VerdictSchema> | z.infer<typeof ReviewSchema> | z.infer<typeof DigestSchema> | z.infer<typeof ScoutSchema> | z.infer<typeof QuerySchema> }
  | { success: false; validationErrors: LLMValidationError[] };

export function parseLLMResponse(taskType: LLMResponseTask, content: string): ParsedLLMResponse {
  if (!['verdict', 'triage', 'review', 'digest', 'scout', 'query'].includes(taskType)) {
    return { success: false, validationErrors: [{ path: [], message: `Unsupported LLM task type: ${String(taskType)}` }] };
  }
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    return { success: false, validationErrors: [{ path: [], message: error instanceof Error ? error.message : 'Invalid JSON' }] };
  }
  const schema = taskType === 'verdict' ? VerdictSchema
    : taskType === 'triage' ? TriageSchema
    : taskType === 'review' ? ReviewSchema
    : taskType === 'digest' ? DigestSchema
    : taskType === 'scout' ? ScoutSchema
    : QuerySchema;
  const result = schema.safeParse(value);
  if (result.success) return { success: true, data: result.data };
  return { success: false, validationErrors: result.error.issues.map((issue) => ({ path: issue.path.filter((part): part is string | number => typeof part !== 'symbol'), message: issue.message })) };
}
