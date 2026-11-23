export type IntakeGateState = 'approved' | 'grace' | 'blocking' | 'veto-allow' | 'veto-block';

// Computed by the backend with the same evaluator the ADO PR check uses
export interface IntakeGateStatus {
  state: IntakeGateState;
  allowsPRs: boolean;
  // Last day (YYYY-MM-DD) PRs are allowed without discussion
  graceEndsOn?: string;
  // Whole days of grace left (0 = last day); 'grace' only
  graceDaysLeft?: number;
}

// Team-facing summary shown on the Tech Intake page
export type IntakeGovernanceStatus = 'approved' | 'pending' | 'rejected';

export interface TechGovernanceReleaseIntake {
  id: string;
  title: string;
  jira: string;
  createdDate: string;
  updatedDate: string;
  discussedOn?: string;
  author: string;
  contributors: string[];
  platformVeto: number;
  // Derived scope from backend parser: comma-separated list of checked scope items
  // Possible values: "CDB UI", "CDB UI Config", "CDB BOS", "CDB BOS Config", "Akamai", "Channels Changes", "Lambda Changes"
  scope?: string;
  // Optional Confluence-sourced dev lead contact info
  confluenceDevLeadName?: string;
  confluenceDevLeadEmail?: string;
  // Who approved from the dashboard; absent when the line was added on the page by hand
  approvedBy?: string;
  gateStatus?: IntakeGateStatus;
}

export interface TechGovernanceRelease {
  branch: string;
  details: string;
  intakePageId: string;
  gracePeriodInDays: number;
  intakes: TechGovernanceReleaseIntake[];
}

export interface AwaitingDiscussionItem {
  branch: string;
  intake: TechGovernanceReleaseIntake;
}
