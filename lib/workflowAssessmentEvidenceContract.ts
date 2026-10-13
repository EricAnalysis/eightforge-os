import { z } from 'zod';
import { hashCanonical } from '@/lib/extraction/domain/hash';

export const ASSESSMENT_SUPPORTING_FILE_LIMITS = Object.freeze({
  maxFiles: 5, maxFileBytes: 10 * 1024 * 1024, maxContextCharacters: 4000,
  maxTotalContextCharacters: 20000, maxArchiveExpandedBytes: 20 * 1024 * 1024,
});
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const ContextEnvelopeSchema = z.object({
  attachmentId: z.string().uuid(), originalFilename: z.string().min(1).max(255),
  mediaType: z.string().min(1).max(256), sizeBytes: z.number().int().positive().max(ASSESSMENT_SUPPORTING_FILE_LIMITS.maxFileBytes),
  sourceSha256: digest, parserVersion: z.literal('assessment_supporting_file_v1'),
  format: z.enum(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'json']),
  truncated: z.boolean(), limitations: z.array(z.string().min(1).max(200)).max(8),
  sections: z.array(z.object({ sourceRef: z.string().min(1).max(200),
    kind: z.enum(['page', 'sheet', 'paragraph', 'table', 'json']), label: z.string().min(1).max(200),
    content: z.string().min(1).max(4000) }).strict()).min(1).max(12),
}).strict().superRefine((context, ctx) => {
  if (context.sections.reduce((sum, section) => sum + section.content.length, 0) > 4000
    || context.sections.some((section) => !section.sourceRef.startsWith(`sha256:${context.sourceSha256}:`))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid bounded source representation' });
  }
});
// The digest belongs to the strict envelope, so validate it without allowing
// authority, URLs, customer identity or raw bytes to enter a provider context.
export function parseAssessmentSupportingFileContext(input: unknown) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid context');
  const { representationDigestSha256, ...envelope } = input as Record<string, unknown>;
  const parsed = ContextEnvelopeSchema.parse(envelope);
  if (!digest.safeParse(representationDigestSha256).success || hashCanonical(parsed) !== representationDigestSha256) {
    throw new Error('Representation identity mismatch');
  }
  return { ...parsed, representationDigestSha256: representationDigestSha256 as string };
}
export type AssessmentSupportingFileContext = ReturnType<typeof parseAssessmentSupportingFileContext>;
export const AssessmentSupportingFileContextSchema = z.unknown().transform((input, ctx) => {
  try { return parseAssessmentSupportingFileContext(input); }
  catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid bounded attachment representation', fatal: true });
    return z.NEVER;
  }
});
export type AssessmentSupportingFileResult =
  Readonly<{ mediaType: string; sourceSha256: string; parserVersion: 'assessment_supporting_file_v1' }> & (
    | Readonly<{ status: 'processed'; context: AssessmentSupportingFileContext }>
    | Readonly<{ status: 'failed'; code: 'unsupported_file_type' | 'file_too_large' | 'corrupt_file' | 'no_readable_content'; safeMessage: string }>);
