/**
 * Minimal model types for the CDBBOS Log Search feature.
 */

/**
 * Option for the environment dropdown — one entry per env key from
 * `GET /api/envs-dashboard/details`.
 */
export interface EnvOption {
  name: string;
  applicationLogsUrl: string;
}

/**
 * Shape of the relevant subset of the response from
 * `GET /api/envs-dashboard/details`. Only fields we consume are listed.
 */
export interface DashboardDetailsResponse {
  qa_environments: string[];
  environments: Record<string, { application_logs?: string }>;
}

export interface LogSearchRequest {
  logUrl: string;
  reqId: string;
}

export interface LogLineEntry {
  text: string;
  lineNum: number;
  isMatch: boolean;
}

export interface LogGapEntry {
  gap: true;
  skipped: number;
}

export type LogEntry = LogLineEntry | LogGapEntry;

export function isGap(entry: LogEntry): entry is LogGapEntry {
  return (entry as LogGapEntry).gap === true;
}

export interface LogSearchResponse {
  lines: LogEntry[];
  totalMatched: number;
  matchesReturned: number;
  truncated: boolean;
  contextSize: number;
}
