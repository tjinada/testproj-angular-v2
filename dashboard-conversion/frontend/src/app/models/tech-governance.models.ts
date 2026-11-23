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
}

export interface TechGovernanceRelease {
  branch: string;
  details: string;
  intakePageId: string;
  gracePeriodInDays: number;
  intakes: TechGovernanceReleaseIntake[];
}
