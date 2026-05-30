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
}

export interface TechGovernanceRelease {
  branch: string;
  details: string;
  intakePageId: string;
  gracePeriodInDays: number;
  intakes: TechGovernanceReleaseIntake[];
}
