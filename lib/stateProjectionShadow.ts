export type StateProjectionRecordType =
  | 'document'
  | 'project_validation_finding'
  | 'execution_item';

export type StateProjectionShadowMismatch = {
  record_type: StateProjectionRecordType;
  record_id: string;
  project_id: string | null;
  legacy_value: string;
  persisted_value: string | null;
  surface: string;
  timestamp: string;
};

export type StateProjectionShadowInput = Omit<
  StateProjectionShadowMismatch,
  'timestamp' | 'persisted_value'
> & {
  persisted_value: string | null | undefined;
};

type StateProjectionShadowInsertRow = {
  record_type: StateProjectionRecordType;
  record_id: string;
  project_id: string | null;
  organization_id: string | null;
  legacy_value: string;
  persisted_value: string | null;
  surface: string;
};

type StateProjectionShadowAdminClient = {
  from: (table: 'state_projection_shadow_mismatches') => {
    insert: (row: StateProjectionShadowInsertRow) => PromiseLike<{
      error?: { message?: string } | null;
    }>;
  };
};

export type StateProjectionShadowSinkOptions = {
  adminClient?: StateProjectionShadowAdminClient | null;
  organization_id?: string | null;
};

function shadowLoggingEnabled(): boolean {
  return process.env.NEXT_PUBLIC_EIGHTFORGE_STATE_SHADOW_LOGGING !== '0';
}

function persistStateProjectionMismatch(
  payload: StateProjectionShadowMismatch,
  options: StateProjectionShadowSinkOptions,
): void {
  if (!options.adminClient) return;

  void Promise.resolve()
    .then(async () => {
      const { error } = await options.adminClient!.from('state_projection_shadow_mismatches').insert({
        record_type: payload.record_type,
        record_id: payload.record_id,
        project_id: payload.project_id,
        organization_id: options.organization_id ?? null,
        legacy_value: payload.legacy_value,
        persisted_value: payload.persisted_value,
        surface: payload.surface,
      });

      if (error) {
        console.error('[state-projection-shadow-mismatch:persist-failed]', error);
      }
    })
    .catch((error) => {
      console.error('[state-projection-shadow-mismatch:persist-failed]', error);
    });
}

export function logStateProjectionMismatch(
  input: StateProjectionShadowInput,
  options: StateProjectionShadowSinkOptions = {},
): boolean {
  if (
    !shadowLoggingEnabled()
    || input.persisted_value === undefined
    || input.legacy_value === input.persisted_value
  ) {
    return false;
  }

  const payload: StateProjectionShadowMismatch = {
    ...input,
    persisted_value: input.persisted_value,
    timestamp: new Date().toISOString(),
  };

  console.warn('[state-projection-shadow-mismatch]', payload);
  persistStateProjectionMismatch(payload, options);
  return true;
}
