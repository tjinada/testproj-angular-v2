export interface DATeamMember {
  name: string;
  email: string;
}

export interface DATeamLastUpdated {
  by: string;
  at: string;
}

export interface DATeam {
  name: string;
  jiraProjects: string[];
  dm: DATeamMember;
  adm: DATeamMember;
  devLead: DATeamMember;
  prApprovers: DATeamMember[];
  qaLead: DATeamMember;
  features: string[];
  qm?: DATeamMember;
  bd?: DATeamMember;
  po?: DATeamMember;
  sto?: DATeamMember;
  ba?: DATeamMember;
  sa?: DATeamMember;
  dpm?: DATeamMember;
  devops?: DATeamMember[];
  devs?: DATeamMember[];
  devsPoland?: DATeamMember[];
  qas?: DATeamMember[];
  details?: string;
  v?: number;
  lastUpdated?: DATeamLastUpdated;
}

export type DATeamsData = Record<string, DATeam>;
