/** Presentation only: persisted qualification evidence is never rewritten. */
export function workflowQualificationLabel(state: string): string {
  if (state === 'qualified') return 'historical qualification (pre-current trust model)';
  return state.replace(/_/g, ' ');
}
