import { techGovernanceReleasesIntakeService } from '../services';

/**
 * INTAKE BOARD TOGGLE
 *
 * Change this ONE value to switch all intake operations between boards:
 * - 'ssrelease'           → Test board (SS Release Management space)
 * - 'channel-technology'  → Production board (Channel Technology space)
 */
const configuredBoard = process.env.INTAKE_ACTIVE_BOARD;
const ACTIVE_BOARD: 'ssrelease' | 'channel-technology' = configuredBoard === 'channel-technology'
  ? 'channel-technology'
  : 'ssrelease';

if (configuredBoard !== 'channel-technology' && configuredBoard !== 'ssrelease') {
  const received = configuredBoard ? ` (received "${configuredBoard}")` : '';
  console.warn(`[Intake Board] INTAKE_ACTIVE_BOARD is missing or invalid; falling back to ssrelease${received}`);
}
const BOARD_CONFIG = {
  ssrelease: {
    spaceKey: 'SSRELEASE',
    // Static parent page ID for all releases in test mode
    getParentPageId: (_releaseId: string): string => '1356094131',
    baseUrl: 'https://bmo.atlassian.net/wiki',
  },
  'channel-technology': {
    spaceKey: 'CHNLTECH',
    // Dynamic parent page ID per release from Tech Governance data
    getParentPageId: (releaseId: string): string | null => {
      return techGovernanceReleasesIntakeService.findByBranch(releaseId)?.intakePageId || null;
    },
    baseUrl: 'https://bmo.atlassian.net/wiki',
  },
} as const;

/**
 * Returns the active board configuration.
 * All intake operations (create, edit, lookup) should use this.
 */
export function getIntakeBoardConfig() {
  return {
    ...BOARD_CONFIG[ACTIVE_BOARD],
    activeBoard: ACTIVE_BOARD,
  };
}

/**
 * Resolves the parent page ID for a given release on the active board.
 * Returns null if no parent can be resolved (caller should handle).
 */
export function resolveIntakeParentPageId(releaseId: string): string | null {
  return BOARD_CONFIG[ACTIVE_BOARD].getParentPageId(releaseId);
}

/**
 * Returns the space key for the active board.
 */
export function getIntakeSpaceKey(): string {
  return BOARD_CONFIG[ACTIVE_BOARD].spaceKey;
}

/**
 * Builds a Confluence page URL for the active board.
 */
export function buildIntakePageUrl(pageId: string, pageTitle: string): string {
  const cfg = BOARD_CONFIG[ACTIVE_BOARD];
  const titleSlug = encodeURIComponent(pageTitle || '').replace(/%20/g, '+');
  return `${cfg.baseUrl}/spaces/${cfg.spaceKey}/pages/${pageId}/${titleSlug}`;
}

