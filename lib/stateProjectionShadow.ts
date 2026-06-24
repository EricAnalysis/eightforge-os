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

function shadowLoggingEnabled(): boolean {
  return process.env.NEXT_PUBLIC_EIGHTFORGE_STATE_SHADOW_LOGGING !== '0';
}

export function logStateProjectionMismatch(input: StateProjectionShadowInput): boolean {
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
  return true;
}
