import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/extraction/assessmentSupportingFile', () => ({ parseAssessmentSupportingFile: vi.fn() }));
vi.mock('@/lib/extraction/persistence/sourceArtifactIdentity', () => ({ captureUploadedStorageObjectVersion: vi.fn() }));
import { createAssessmentDraft, uploadAssessmentAttachment, listAssessmentAttachments,
  readAssessmentAttachmentFile, removeAssessmentAttachment, loadAssessmentAttachmentContext } from './workflowAssessmentEvidence';
const ORG = '11111111-1111-4111-8111-111111111111';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const DRAFT = '33333333-3333-4333-8333-333333333333';
const FILE = '44444444-4444-4444-8444-444444444444';
const actor = vi.fn(async () => ({ ok: true as const, actor: { organizationId: ORG, actorId: ACTOR,
  email: null, role: null, displayName: null } }));
function setup(options: { draft?: unknown; files?: unknown; publicBucket?: boolean; version?: string | null } = {}) {
  const calls: unknown[][] = [];
  const insert = vi.fn(async () => ({ error: null }));
  function query(table: string) {
    const result = { data: table === 'workflow_assessment_drafts'
      ? (options.draft === undefined ? { id: DRAFT, state: 'open', created_by_actor_id: ACTOR } : options.draft)
      : (options.files === undefined ? [] : options.files), error: null };
    const chain: Record<string, unknown> = {};
    for (const key of ['select','eq','is','in','order']) chain[key] = (...args: unknown[]) => { calls.push([table,key,...args]); return chain; };
    chain.maybeSingle = async () => result;
    chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
    chain.insert = insert;
    return chain;
  }
  const upload = vi.fn(async () => ({ error: null }));
  const remove = vi.fn(async () => ({ error: null }));
  const download = vi.fn(async () => ({ data: new Blob(['wrong bytes']), error: null }));
  const rpc = vi.fn(async () => ({ data: true, error: null }));
  const admin = { from: query, rpc, storage: { getBucket: vi.fn(async () => ({ data: { public: options.publicBucket ?? false }, error: null })),
    from: vi.fn(() => ({ upload, remove, download })) } } as never;
  const parse = vi.fn(async () => ({ status: 'processed', mediaType: 'text/csv', sourceSha256: 'a'.repeat(64),
    parserVersion: 'assessment_supporting_file_v1', context: { attachmentId: FILE, sourceSha256: 'a'.repeat(64), representationDigestSha256: 'b'.repeat(64) } })) as never;
  const storageVersion = vi.fn(async () => options.version === undefined ? 'immutable-version' : options.version);
  return { dependencies: { actor, admin, parse, storageVersion }, calls, insert, upload, remove, download, rpc };
}
function fileRequest(extra = false) {
  const form = new FormData(); form.set('file', new File(['a,b\n1,2'], 'input.csv', { type: 'text/csv' }));
  if (extra) form.set('organizationId', 'forged');
  return new Request('http://local/upload', { method: 'POST', body: form });
}
beforeEach(() => actor.mockClear());
describe('authenticated assessment evidence boundaries', () => {
  it('denies every unauthenticated file/draft operation before persistence', async () => {
    const denied = { actor: vi.fn(async () => ({ ok: false as const, status: 401, error: 'Unauthorized' })) };
    const req = new Request('http://local');
    for (const response of await Promise.all([createAssessmentDraft(req, denied), listAssessmentAttachments(req,DRAFT,denied),
      uploadAssessmentAttachment(req,DRAFT,denied),removeAssessmentAttachment(req,DRAFT,FILE,denied),readAssessmentAttachmentFile(req,DRAFT,FILE,denied)])) {
      expect(response?.status).toBe(401);
    }
  });
  it('creates a server-owned identity and ignores client tenant/actor inputs', async () => {
    const state = setup();
    const response = await createAssessmentDraft(new Request('http://local', { method: 'POST', body: JSON.stringify({ organizationId:'forged' }) }),state.dependencies);
    expect(response?.status).toBe(201);
    expect(state.insert).toHaveBeenCalledWith(expect.objectContaining({ organization_id: ORG, created_by_actor_id: ACTOR }));
  });
  it('a foreign draft cannot upload or enumerate files', async () => {
    const state = setup({ draft: null });
    expect((await uploadAssessmentAttachment(fileRequest(),DRAFT,state.dependencies))?.status).toBe(404);
    expect((await listAssessmentAttachments(new Request('http://local'),DRAFT,state.dependencies))?.status).toBe(404);
    expect(state.upload).not.toHaveBeenCalled();
    expect(state.calls).toContainEqual(['workflow_assessment_drafts','eq','organization_id',ORG]);
  });
  it('requires private storage and rejects caller organization in multipart', async () => {
    const state = setup({ publicBucket: true });
    expect((await uploadAssessmentAttachment(fileRequest(),DRAFT,state.dependencies))?.status).toBe(503);
    expect((await uploadAssessmentAttachment(fileRequest(true),DRAFT,state.dependencies))?.status).toBe(400);
    expect(state.upload).not.toHaveBeenCalled();
  });
  it('writes only assessment evidence with source/version pins', async () => {
    const state = setup();
    expect((await uploadAssessmentAttachment(fileRequest(),DRAFT,state.dependencies))?.status).toBe(201);
    expect(state.insert).toHaveBeenCalledWith(expect.objectContaining({ draft_id:DRAFT, organization_id:ORG,
      uploaded_by_actor_id:ACTOR, storage_version:'immutable-version', content_sha256:'a'.repeat(64), representation_digest_sha256:'b'.repeat(64) }));
    expect(state.calls.some(call => call[0] === 'documents')).toBe(false);
    expect(state.upload).toHaveBeenCalledWith(expect.stringContaining(`${ORG}/workflow-assessments/${DRAFT}/`),expect.any(Uint8Array),expect.objectContaining({ upsert:false }));
  });
  it('identity failure never reports successful attachment and cleans only unlinked upload', async () => {
    const state = setup({ version:null });
    expect((await uploadAssessmentAttachment(fileRequest(),DRAFT,state.dependencies))?.status).toBe(500);
    expect(state.insert).not.toHaveBeenCalled(); expect(state.remove).toHaveBeenCalledTimes(1);
  });
  it('direct file IDs always require organization and assessment scope', async () => {
    const state = setup({ files:null });
    expect((await readAssessmentAttachmentFile(new Request('http://local'),DRAFT,FILE,state.dependencies))?.status).toBe(404);
    expect(state.calls).toContainEqual(['workflow_assessment_attachments','eq','organization_id',ORG]);
    expect(state.calls).toContainEqual(['workflow_assessment_attachments','eq','draft_id',DRAFT]);
    expect(state.download).not.toHaveBeenCalled();
  });
  it('retains linked bytes after an ambiguous insert failure and removes only proven orphans', async () => {
    for (const [files, mayRemove] of [[{ id:FILE }, false], [null, true]] as const) {
      const state = setup({ files });
      state.insert.mockResolvedValueOnce({ error:{ message:'Ambiguous insert failure' } } as never);
      expect((await uploadAssessmentAttachment(fileRequest(),DRAFT,state.dependencies))?.status).toBe(500);
      expect(state.remove).toHaveBeenCalledTimes(mayRemove ? 1 : 0);
    }
  });
  it('removal uses server actor and organization rather than request authority', async () => {
    const state = setup(); await removeAssessmentAttachment(new Request('http://local'),DRAFT,FILE,state.dependencies);
    expect(state.rpc).toHaveBeenCalledWith('remove_workflow_assessment_attachment', { p_draft_id:DRAFT,p_attachment_id:FILE,p_organization_id:ORG,p_actor_id:ACTOR });
    expect(state.remove).not.toHaveBeenCalled();
  });
  it('provider context accepts only the complete own manifest, with exact pins', async () => {
    const manifest = [{ attachmentId:FILE,sourceSha256:'a'.repeat(64),representationDigestSha256:'b'.repeat(64) }];
    const context = { ...manifest[0] };
    const state = setup({ files:[{ id:FILE, draft_id:DRAFT,organization_id:ORG,content_sha256:'a'.repeat(64),status:'processed',removed_at:null,context }] });
    expect(await loadAssessmentAttachmentContext(state.dependencies.admin,DRAFT,ORG,manifest)).toEqual([context]);
    await expect(loadAssessmentAttachmentContext(state.dependencies.admin,DRAFT,'foreign',manifest)).rejects.toThrow('closure');
    await expect(loadAssessmentAttachmentContext(state.dependencies.admin,DRAFT,ORG,[{ ...manifest[0],sourceSha256:'c'.repeat(64) }])).rejects.toThrow('closure');
    expect(await loadAssessmentAttachmentContext(state.dependencies.admin,DRAFT,null,undefined)).toEqual([]);
  });
});
