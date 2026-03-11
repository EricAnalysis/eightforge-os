export type ActionType =
  | 'create_review'
  | 'flag_document'
  | 'assign_project'
  | 'send_alert'
  | 'log_event';

export type WorkflowRule = {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  is_active: boolean;
  condition_type: string;
  condition_value: string;
  action_type: ActionType;
  action_payload: Record<string, unknown> | null;
  created_at: string;
};

export type WorkflowEvent = {
  id: string;
  organization_id: string;
  document_id: string | null;
  rule_id: string | null;
  event_type: string;
  status: 'pending' | 'completed' | 'failed' | 'skipped';
  payload: Record<string, unknown> | null;
  error_message: string | null;
  created_at: string;
};

