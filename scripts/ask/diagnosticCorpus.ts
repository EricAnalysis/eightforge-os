export type DiagnosticQuery = { id: number; set: 'A' | 'B' | 'C' | 'D'; scope: 'project' | 'portfolio'; text: string; matrixId?: string; };
export const QUERIES: DiagnosticQuery[] = [
  // CM-001
  { id: 1, set: 'A', scope: 'project', text: 'Is this project ready for invoice approval?' },
  { id: 2, set: 'A', scope: 'project', text: 'Which invoice amounts are fully supported?' },
  // CM-002
  { id: 3, set: 'A', scope: 'project', text: 'What is blocking approval?' },
  // CM-008
  { id: 4, set: 'A', scope: 'project', matrixId: 'CM-008', text: 'Where did the $815,559.35 total come from?' },
  { id: 5, set: 'A', scope: 'project', text: 'Show me unsupported ticket costs.' },
  { id: 6, set: 'A', scope: 'project', text: 'What is at risk in this project?' },
  // CM-042
  { id: 7, set: 'A', scope: 'project', text: 'What changed since the last review?' },
  // CM-018
  { id: 8, set: 'B', scope: 'project', text: 'Which contract is governing?' },
  // CM-023
  { id: 9, set: 'B', scope: 'project', text: 'Are tipping fees billable under this contract?' },
  { id: 10, set: 'B', scope: 'project', text: 'Is this FEMA reimbursable work?' },
  // CM-030
  { id: 11, set: 'B', scope: 'project', text: 'What federal compliance requirements apply?' },
  // CM-031
  { id: 12, set: 'B', scope: 'project', text: 'Can the contractor work on private property?' },
  { id: 13, set: 'B', scope: 'project', text: 'Is a performance bond required?' },
  // CM-033
  { id: 14, set: 'B', scope: 'project', text: 'What happens if FEMA funding is denied?' },
  // CM-029
  { id: 15, set: 'C', scope: 'project', text: 'Is monitoring required?' },
  // CM-028
  { id: 16, set: 'C', scope: 'project', text: 'What documentation is required for payment?' },
  // CM-049
  { id: 17, set: 'D', scope: 'portfolio', text: 'Which projects are blocked right now?' },
  // CM-050
  { id: 18, set: 'D', scope: 'portfolio', matrixId: 'CM-050', text: 'What is the total at-risk amount across all projects?' },
  // CM-051
  { id: 19, set: 'D', scope: 'portfolio', matrixId: 'CM-051', text: 'Which projects need review first?' },
  // CM-052
  { id: 20, set: 'D', scope: 'portfolio', matrixId: 'CM-052', text: 'What issues are happening most across projects?' },
  // CM-053
  { id: 21, set: 'D', scope: 'portfolio', text: 'Which projects are ready for approval?' },
  // CM-056
  { id: 22, set: 'D', scope: 'portfolio', text: 'Are any projects approaching contract ceiling?' },
  // CM-001
  { id: 23, set: 'A', scope: 'project', matrixId: 'CM-001', text: 'Is this project ready for invoice approval?' },
  // CM-002
  { id: 24, set: 'A', scope: 'project', matrixId: 'CM-002', text: 'What is preventing approval?' },
  // CM-003
  { id: 25, set: 'A', scope: 'project', matrixId: 'CM-003', text: 'What is the next best action for this project?' },
  // CM-005
  { id: 26, set: 'A', scope: 'project', matrixId: 'CM-005', text: 'Can this invoice move forward while open tickets are pending?' },
  // CM-006
  { id: 27, set: 'A', scope: 'project', matrixId: 'CM-006', text: 'Which invoice amounts are fully supported?' },
  // CM-007
  { id: 28, set: 'A', scope: 'project', matrixId: 'CM-007', text: 'Which invoice amounts are unsupported?' },
  // CM-009
  { id: 29, set: 'A', scope: 'project', matrixId: 'CM-009', text: 'What is the total invoice exposure?' },
  // CM-010
  { id: 30, set: 'A', scope: 'project', matrixId: 'CM-010', text: 'Can this invoice be approved with exceptions?' },
  // CM-011
  { id: 31, set: 'A', scope: 'project', matrixId: 'CM-011', text: 'Which tickets need correction?' },
  // CM-013
  { id: 32, set: 'A', scope: 'project', matrixId: 'CM-013', text: 'Which tickets have missing disposal site, material, CYD, tonnage, or mileage?' },
  // CM-014
  { id: 33, set: 'A', scope: 'project', matrixId: 'CM-014', text: 'Which tickets have rate-code mismatches?' },
  // CM-017
  { id: 34, set: 'A', scope: 'project', matrixId: 'CM-017', text: 'Which tickets are unresolved by reviewer?' },
  // CM-018
  { id: 35, set: 'B', scope: 'project', matrixId: 'CM-018', text: 'Which contract is governing?' },
  // CM-019
  { id: 36, set: 'B', scope: 'project', matrixId: 'CM-019', text: 'Which amendment or exhibit controls the rate schedule?' },
  // CM-020
  { id: 37, set: 'B', scope: 'project', matrixId: 'CM-020', text: 'Did a newer document replace an older one?' },
  // CM-021
  { id: 38, set: 'B', scope: 'project', matrixId: 'CM-021', text: 'Are there conflicting facts across documents?' },
  // CM-022
  { id: 39, set: 'B', scope: 'project', matrixId: 'CM-022', text: 'Does this invoice use the correct contract rates?' },
  // CM-023
  { id: 40, set: 'B', scope: 'project', matrixId: 'CM-023', text: 'Are tipping fees billable under this contract?' },
  // CM-025
  { id: 41, set: 'B', scope: 'project', matrixId: 'CM-025', text: 'Are any invoice line items missing from the contract rate table?' },
  // CM-026
  { id: 42, set: 'B', scope: 'project', matrixId: 'CM-026', text: 'Is the project approaching contract ceiling?' },
  // CM-028
  { id: 43, set: 'B', scope: 'project', matrixId: 'CM-028', text: 'What documentation is required for payment?' },
  // CM-029
  { id: 44, set: 'B', scope: 'project', matrixId: 'CM-029', text: 'Is monitoring required?' },
  // CM-030
  { id: 45, set: 'B', scope: 'project', matrixId: 'CM-030', text: 'Are GPS, photos, load tickets, or daily reconciliation required?' },
  // CM-031
  { id: 46, set: 'B', scope: 'project', matrixId: 'CM-031', text: 'Can the contractor work on private property?' },
  // CM-033
  { id: 47, set: 'B', scope: 'project', matrixId: 'CM-033', text: 'Is there no-guaranteed-quantity or funding-contingency language?' },
  // CM-034
  { id: 48, set: 'B', scope: 'project', matrixId: 'CM-034', text: 'Which documents still need review?' },
  // CM-035
  { id: 49, set: 'B', scope: 'project', matrixId: 'CM-035', text: 'Are any documents marked reviewed but still producing warnings?' },
  // CM-036
  { id: 50, set: 'B', scope: 'project', matrixId: 'CM-036', text: 'Which facts were manually confirmed?' },
  // CM-037
  { id: 51, set: 'B', scope: 'project', matrixId: 'CM-037', text: 'Which facts were overridden by a human?' },
  // CM-038
  { id: 52, set: 'B', scope: 'project', matrixId: 'CM-038', text: 'Which document should the operator inspect first?' },
  // CM-039
  { id: 53, set: 'C', scope: 'project', matrixId: 'CM-039', text: 'What execution items are still open?' },
  // CM-040
  { id: 54, set: 'C', scope: 'project', matrixId: 'CM-040', text: 'Which findings require action before approval?' },
  // CM-041
  { id: 55, set: 'C', scope: 'project', matrixId: 'CM-041', text: 'Which findings were overridden, and why?' },
  // CM-042
  { id: 56, set: 'C', scope: 'project', matrixId: 'CM-042', text: 'What changed since the last review?' },
  // CM-043
  { id: 57, set: 'C', scope: 'project', matrixId: 'CM-043', text: 'Which actions are blocking payment release?' },
  // CM-053
  { id: 58, set: 'D', scope: 'portfolio', matrixId: 'CM-053', text: 'Which projects are ready for approval?' },
  // CM-054
  { id: 59, set: 'D', scope: 'portfolio', matrixId: 'CM-054', text: 'Which projects have stale validation snapshots?' },
  // CM-049
  { id: 60, set: 'D', scope: 'portfolio', matrixId: 'CM-049', text: 'Which projects are blocked right now?' },
];

