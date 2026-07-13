"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.QuerySchema = exports.ScoutSchema = exports.DigestSchema = exports.ReviewSchema = exports.TriageSchema = exports.VerdictSchema = exports.FailureDetailSchema = void 0;
exports.parseLLMResponse = parseLLMResponse;
const zod_1 = require("zod");
/* These schemas are deliberately strict and bounded: model output is untrusted input, so malformed,
   contradictory, or unexpectedly large responses must take the existing conservative fallback path. */
const NonEmptyBoundedString = zod_1.z.string().min(1).max(4000);
const BoundedString = zod_1.z.string().max(4000);
exports.FailureDetailSchema = zod_1.z.object({
    file: zod_1.z.string().max(1000).nullable(),
    reason: NonEmptyBoundedString,
    suggestedFix: zod_1.z.string().max(4000).nullable(),
}).strict();
const VerdictSchemaBase = zod_1.z.object({
    verdict: zod_1.z.enum(['pass', 'fail', 'uncertain']),
    confidence: zod_1.z.number().finite().min(0).max(1),
    summary: BoundedString,
    likelyRelevantToRecentChanges: zod_1.z.boolean(),
    failures: zod_1.z.array(exports.FailureDetailSchema).max(50),
    needsRawLogs: zod_1.z.boolean(),
}).strict();
exports.VerdictSchema = VerdictSchemaBase.superRefine((value, ctx) => {
    if (value.verdict === 'pass' && value.failures.length > 0) {
        ctx.addIssue({ code: 'custom', path: ['failures'], message: 'pass verdict cannot contain failures' });
    }
});
exports.TriageSchema = exports.VerdictSchema;
const CodeReviewIssueSchema = zod_1.z.object({
    file: NonEmptyBoundedString,
    line: zod_1.z.number().int().positive().nullable().optional(),
    severity: zod_1.z.enum(['error', 'warning']),
    description: NonEmptyBoundedString,
    suggestedFix: zod_1.z.string().max(4000).nullable(),
}).strict();
exports.ReviewSchema = zod_1.z.object({
    hasIssues: zod_1.z.boolean(),
    issues: zod_1.z.array(CodeReviewIssueSchema).max(100),
    summary: BoundedString,
}).strict().superRefine((value, ctx) => {
    if (!value.hasIssues && value.issues.length > 0) {
        ctx.addIssue({ code: 'custom', path: ['issues'], message: 'review with issues must set hasIssues to true' });
    }
});
exports.DigestSchema = zod_1.z.object({
    summary: BoundedString,
    keyFindings: zod_1.z.array(NonEmptyBoundedString).max(100),
    digest: BoundedString,
    needsRawLogs: zod_1.z.boolean(),
}).strict();
exports.ScoutSchema = zod_1.z.object({
    pointers: zod_1.z.array(zod_1.z.object({
        file: NonEmptyBoundedString,
        lineRange: NonEmptyBoundedString,
        why: NonEmptyBoundedString,
        confidence: zod_1.z.number().finite().min(0).max(1),
    }).strict()).max(100),
    suggestedNextSearches: zod_1.z.array(NonEmptyBoundedString).max(100),
    summary: BoundedString,
    needsDeeperLook: zod_1.z.boolean(),
}).strict();
exports.QuerySchema = zod_1.z.object({
    answer: BoundedString,
    relevantExcerpt: BoundedString,
    lineRange: zod_1.z.string().max(200),
}).strict();
function parseLLMResponse(taskType, content) {
    if (!['verdict', 'triage', 'review', 'digest', 'scout', 'query'].includes(taskType)) {
        return { success: false, validationErrors: [{ path: [], message: `Unsupported LLM task type: ${String(taskType)}` }] };
    }
    let value;
    try {
        value = JSON.parse(content);
    }
    catch (error) {
        return { success: false, validationErrors: [{ path: [], message: error instanceof Error ? error.message : 'Invalid JSON' }] };
    }
    const schema = taskType === 'verdict' ? exports.VerdictSchema
        : taskType === 'triage' ? exports.TriageSchema
            : taskType === 'review' ? exports.ReviewSchema
                : taskType === 'digest' ? exports.DigestSchema
                    : taskType === 'scout' ? exports.ScoutSchema
                        : exports.QuerySchema;
    const result = schema.safeParse(value);
    if (result.success)
        return { success: true, data: result.data };
    return { success: false, validationErrors: result.error.issues.map((issue) => ({ path: issue.path.filter((part) => typeof part !== 'symbol'), message: issue.message })) };
}
