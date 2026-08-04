/**
 * Loads the CDB Monitoring tab's Dynatrace dashboard links from YAML.
 *
 * Path resolution, first existing file wins:
 *   1. $CDB_DASHBOARDS_CONFIG_PATH, if set (resolved against cwd when relative)
 *   2. ../../config/cdb-dynatrace-dashboards.yaml  (backend/config from src|dist/services)
 *   3. ../config/cdb-dynatrace-dashboards.yaml     (fallback for a flatter build layout)
 *
 * Unlike release-workflow.loader.ts, a missing or invalid file does NOT throw.
 * This is a list of links, not operational config — the backend still boots,
 * a warning is logged, and the tab renders its empty state.
 *
 * Parsed once at module load. Edits require a backend restart.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { z } from 'zod';

export interface DashboardLink {
  name: string;
  description: string;
  url: string;
}

export interface DashboardConfig {
  accessRequestUrl: string | null;
  dashboards: DashboardLink[];
}

const FILE_NAME = 'cdb-dynatrace-dashboards.yaml';

const DashboardSchema = z.object({
  name: z.string().min(1),
  url: z.string().min(1),
  description: z.string().default(''),
});

const FileSchema = z.object({
  accessRequestUrl: z.string().min(1).optional(),
  dashboards: z.array(DashboardSchema).default([]),
});

const EMPTY: DashboardConfig = { accessRequestUrl: null, dashboards: [] };

function resolveYamlPath(): string | null {
  const envPath = process.env.CDB_DASHBOARDS_CONFIG_PATH;
  const candidates: string[] = [];

  if (envPath) {
    candidates.push(path.isAbsolute(envPath) ? envPath : path.resolve(process.cwd(), envPath));
  }
  candidates.push(path.resolve(__dirname, '..', '..', 'config', FILE_NAME));
  candidates.push(path.resolve(__dirname, '..', 'config', FILE_NAME));

  return candidates.find(p => fs.existsSync(p)) ?? null;
}

function load(): DashboardConfig {
  const filePath = resolveYamlPath();
  if (!filePath) {
    console.warn(`[cdb-dashboards] ${FILE_NAME} not found — CDB Monitoring tab will be empty.`);
    return EMPTY;
  }

  try {
    const parsed = yaml.load(fs.readFileSync(filePath, 'utf8'));
    const result = FileSchema.safeParse(parsed);

    if (!result.success) {
      const issues = result.error.issues.map(i => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
      console.warn(`[cdb-dashboards] ${filePath} failed validation — tab will be empty:\n${issues}`);
      return EMPTY;
    }

    console.log(`[cdb-dashboards] Loaded ${result.data.dashboards.length} dashboard(s) from ${filePath}`);
    return {
      accessRequestUrl: result.data.accessRequestUrl ?? null,
      dashboards: result.data.dashboards,
    };
  } catch (err) {
    console.warn(`[cdb-dashboards] Failed to read ${filePath} — tab will be empty:`, err);
    return EMPTY;
  }
}

export const CDB_DASHBOARDS: DashboardConfig = load();
