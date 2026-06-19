import type { MatchedRule } from './papi-naive-matcher';

export type RewriteBehaviorKind = 'REWRITE' | 'REPLACE' | 'REMOVE' | 'PREPEND';

export interface RewriteStep {
  rulePath: string[];
  behavior: RewriteBehaviorKind;
  from: string;
  to: string;
}

export interface DestinationResolution {
  destinationPath: string;
  pathChanged: boolean;
  rewriteTrace: RewriteStep[];
}

/**
 * Applies the rewriteUrl behaviors of fully-matched rules, in evaluation
 * order, to produce the destination path. Rules that only partially match
 * (gated by variables, headers, or cookies we can't evaluate from a URL —
 * e.g. Shape routing) are skipped, so variable targets like
 * {{user.PMUSER_PATH}} never leak into the result.
 */
export function resolveDestinationPath(
  matchedRules: MatchedRule[],
  originalPath: string
): DestinationResolution {
  let working = originalPath;
  const rewriteTrace: RewriteStep[] = [];

  for (const rule of matchedRules) {
    if (rule.matchStatus !== 'full') continue;
    for (const behavior of rule.behaviors) {
      if (behavior.name !== 'rewriteUrl') continue;
      const options = behavior.options || {};
      const before = working;
      const after = applyRewrite(before, options);
      if (after === before) continue;
      rewriteTrace.push({
        rulePath: rule.rulePath,
        behavior: (asString(options.behavior) as RewriteBehaviorKind) || 'REWRITE',
        from: before,
        to: after
      });
      working = after;
    }
  }

  return {
    destinationPath: working,
    pathChanged: working !== originalPath,
    rewriteTrace
  };
}

function applyRewrite(path: string, options: Record<string, unknown>): string {
  const kind = asString(options.behavior);
  switch (kind) {
    case 'REWRITE':
      return typeof options.targetUrl === 'string' ? options.targetUrl : path;
    case 'REPLACE': {
      const match = asString(options.match);
      if (!match) return path;
      const target = asString(options.targetPath);
      return options.matchMultiple === true
        ? path.split(match).join(target)
        : replaceFirst(path, match, target);
    }
    case 'REMOVE': {
      const match = asString(options.match);
      if (!match) return path;
      return options.matchMultiple === true
        ? path.split(match).join('')
        : replaceFirst(path, match, '');
    }
    case 'PREPEND': {
      const prepend = asString(options.targetPathPrepend);
      if (!prepend) return path;
      return prepend.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '');
    }
    default:
      return path;
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function replaceFirst(haystack: string, needle: string, replacement: string): string {
  const idx = haystack.indexOf(needle);
  if (idx < 0) return haystack;
  return haystack.slice(0, idx) + replacement + haystack.slice(idx + needle.length);
}
