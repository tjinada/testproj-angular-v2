import daTeamsService from './da-teams.service';
import { DATeam } from '../models/da-team.models';

export interface DATeamResolution {
  /** Distinct DA teams that own at least one of the supplied codes. */
  matched: DATeam[];
  /** Codes (e.g. PRO numbers) that map to no DA team, distinct + in input order. */
  unmatched: string[];
}

/**
 * Build a case-insensitive index from JIRA project key -> DA team.
 * First team to claim a key wins (registry iteration order).
 */
function buildJiraProjectIndex(teams: Record<string, DATeam>): Map<string, DATeam> {
  const index = new Map<string, DATeam>();
  for (const team of Object.values(teams)) {
    for (const project of team.jiraProjects ?? []) {
      const key = (project ?? '').trim().toUpperCase();
      if (key && !index.has(key)) {
        index.set(key, team);
      }
    }
  }
  return index;
}

/**
 * Resolve a list of codes (JIRA project keys) to the DA teams that own them.
 *
 * Reusable single source of truth: callers pass codes from any source. Codes
 * are matched against each team's `jiraProjects` (case-insensitive). A code
 * that matches no team is surfaced in `unmatched` rather than dropped, so the
 * caller can see gaps. Each matched team appears once even if several codes
 * map to it.
 */
export function resolveDATeamsByCodes(codes: string[]): DATeamResolution {
  const index = buildJiraProjectIndex(daTeamsService.getAll());

  const matchedByName = new Map<string, DATeam>();
  const unmatched: string[] = [];
  const seenUnmatched = new Set<string>();

  for (const raw of codes) {
    const code = (raw ?? '').trim();
    if (!code) continue;

    const team = index.get(code.toUpperCase());
    if (team) {
      matchedByName.set(team.name, team);
    } else if (!seenUnmatched.has(code.toUpperCase())) {
      seenUnmatched.add(code.toUpperCase());
      unmatched.push(code);
    }
  }

  return { matched: [...matchedByName.values()], unmatched };
}

/** Minimal shape this module needs: anything carrying a `jira` code field. */
interface CodeBearingIntake {
  jira: string;
}

/**
 * Pull the codes out of tech-governance intakes. Each intake's `jira` field
 * already holds the code extracted from its Confluence page title
 * (e.g. "R82 - BNPL - ..." -> "BNPL"). Typed structurally so the backend stays
 * decoupled from any tech-governance model definition.
 */
export function codesFromIntakes(intakes: CodeBearingIntake[]): string[] {
  return intakes
    .map((intake) => intake.jira)
    .filter((code): code is string => !!code && code.trim().length > 0);
}
