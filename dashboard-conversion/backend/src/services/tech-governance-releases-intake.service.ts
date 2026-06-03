import artifactoryService from './artifactory.service';
import cacheSyncService from './cache-sync.service';
import ConfluenceService from './confluence.service';

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
  details: string;
  intakePageId: string;
  branch: string;
  intakes: TechGovernanceReleaseIntake[];
  gracePeriodInDays: number;
}

export type TechGovernanceReleasesIntakeData = Record<string, TechGovernanceRelease>;

class TechGovernanceReleasesIntakeService {
  private readonly dataFilePath = '/tech_governance_releases_intake_data.json';

  releases: TechGovernanceReleasesIntakeData = {};

  constructor() {
    this.initialize();
    cacheSyncService.register('tech-governance-releases-intake', () => this.initialize());
  }

  async initialize(): Promise<void> {
    try {
      const data = await artifactoryService.getFileContent(this.dataFilePath);
      this.releases = { ...data };
    } catch (error) {
      console.log('No existing tech governance releases intake data found in artifactory');
    }
  }

  private async save(): Promise<void> {
    await artifactoryService.saveFileContent(this.dataFilePath, this.releases);
    cacheSyncService.notifyPeers('tech-governance-releases-intake');
  }

  /**
   * Returns the cached tech governance releases intake data.
   */
  getAll(): TechGovernanceReleasesIntakeData {
    return this.releases;
  }

  /**
   * Get release intake data for a specific branch.
   * @param branch - The branch name to filter by.
   * @returns Release data for the specified branch, or undefined if not found.
   */
  getByBranch(branch: string): TechGovernanceRelease | undefined {
    return this.releases[branch];
  }

  /**
   * Case-insensitive branch lookup. Matches a release-workflow Release ID
   * (e.g. "release/r83") to a governance entry keyed by branch regardless of
   * case. Returns undefined if no entry matches.
   */
  findByBranch(branch: string): TechGovernanceRelease | undefined {
    const target = (branch ?? '').trim().toLowerCase();
    if (!target) return undefined;
    for (const [key, release] of Object.entries(this.releases)) {
      if (key.trim().toLowerCase() === target) return release;
    }
    return undefined;
  }

  /**
   * Add a new release entry. Throws if the key already exists.
   */
  async add(key: string, release: TechGovernanceRelease): Promise<TechGovernanceRelease> {
    if (!key || typeof key !== 'string') {
      throw new Error('Release key is required');
    }
    if (this.releases[key]) {
      throw new Error(`Release '${key}' already exists`);
    }
    this.releases[key] = release;
    await this.save();
    return release;
  }

  /**
   * Replace an existing release entry. Throws if the key does not exist.
   */
  async update(key: string, release: TechGovernanceRelease): Promise<TechGovernanceRelease> {
    if (!this.releases[key]) {
      throw new Error(`Release '${key}' not found`);
    }
    this.releases[key] = release;
    await this.save();
    return release;
  }

  /**
   * Delete a release entry by key. Returns true if deleted, false if not found.
   */
  async delete(key: string): Promise<boolean> {
    if (!this.releases[key]) {
      return false;
    }
    delete this.releases[key];
    await this.save();
    return true;
  }

  /**
   * Create-or-update a release entry (keyed by branch) from its Confluence
   * intake page, refreshing the intake child-page list from Confluence.
   *
   * Manually-edited per-intake fields (platformVeto) and the entry-level
   * details / gracePeriodInDays are preserved across refreshes; the rest of
   * each intake (title, dates, author, contributors) is taken fresh from
   * Confluence. New intake pages are added and removed pages drop off.
   */
  async upsertFromIntakePage(input: {
    branch: string;
    intakePageId: string;
    details?: string;
    gracePeriodInDays?: number;
  }): Promise<TechGovernanceRelease> {
    const { branch, intakePageId } = input;
    if (!branch) throw new Error('branch is required');
    if (!intakePageId) throw new Error('intakePageId is required');

    const fetched = await this.fetchConfluenceChildPagesDetails(intakePageId);
    const existing = this.releases[branch];

    // Preserve manually-set platformVeto for intakes that still exist.
    const previousVetoById = new Map(
      (existing?.intakes ?? []).map((intake) => [intake.id, intake.platformVeto]),
    );
    const intakes = fetched.map((intake) => ({
      ...intake,
      platformVeto: previousVetoById.get(intake.id) ?? intake.platformVeto,
    }));

    const release: TechGovernanceRelease = {
      branch,
      intakePageId,
      details: existing?.details ?? input.details ?? '',
      gracePeriodInDays: existing?.gracePeriodInDays ?? input.gracePeriodInDays ?? 0,
      intakes,
    };

    this.releases[branch] = release;
    await this.save();
    return release;
  }

  /**
   * Fetch details of child pages for a given Confluence parent page ID.
   * @param parentPageId - The Confluence parent page ID.
   * @returns Array of child page details mapped to TechGovernanceReleaseIntake.
   */
  async fetchConfluenceChildPagesDetails(parentPageId: string): Promise<TechGovernanceReleaseIntake[]> {
    try {
      const data = await ConfluenceService.getChildPagesContent(parentPageId);

      const children = data.results || [];
      return children.map((page: any): TechGovernanceReleaseIntake => {
        // Derive jira field from title
        let jira = '';
        if (page.title) {
          const match = page.title.match(/R\d+(?:\.\d+)?\s*-\s*([A-Z0-9]+)\b/i);
          if (match && match[1]) {
            jira = match[1];
          }
        }

        // Extract discussedOn from description
        let discussedOn: string | undefined;
        const desc: string = page.body?.storage?.value || '';

        // First try to extract from <time> tag (Confluence date field)
        const timeTagMatch = desc.match(/Discussed in Tech Governance Meeting on\s*<time datetime="([^"]+)"/i);
        if (timeTagMatch && timeTagMatch[1]) {
          const dateStr = timeTagMatch[1].trim();
          // Confluence date format is typically YYYY-MM-DD
          if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
            // Add 20:00 UTC (3pm EST)
            const dateOnly = new Date(dateStr + 'T20:00:00.000Z');
            discussedOn = dateOnly.toISOString();
          } else {
            discussedOn = new Date(dateStr).toISOString();
          }
        } else {
          // Fall back to plain text date extraction
          const discussedMatch = desc.match(/Discussed in Tech Governance Meeting on\s*([\w\-,.\/ ]+)/i);
          if (discussedMatch && discussedMatch[1]) {
            const dateStr = discussedMatch[1].trim();
            // If dateStr is only a date (no time), treat as 3pm EST (which is 20:00 UTC)
            const parsedDate = Date.parse(dateStr);
            if (!isNaN(parsedDate)) {
              if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
                const dateOnly = new Date(dateStr + 'T20:00:00.000Z');
                discussedOn = dateOnly.toISOString();
              } else {
                discussedOn = new Date(parsedDate).toISOString();
              }
            } else {
              discussedOn = dateStr;
            }
          }
        }

        // Author and contributors
        const author: string =
          page.history?.createdBy?.displayName ||
          page.history?.createdBy?.email ||
          '';

        let contributors: string[] = [];
        if (Array.isArray(page.version?.by)) {
          contributors = page.version.by
            .map((u: any) => u.displayName || u.email)
            .filter((v: any): v is string => Boolean(v));
        } else if (page.version?.by) {
          const single = page.version.by.displayName || page.version.by.email;
          if (single) contributors = [single];
        }

        return {
          id: page.id,
          title: page.title,
          jira,
          createdDate: page.history?.createdDate,
          updatedDate: page.version?.when,
          discussedOn,
          author,
          contributors,
          platformVeto: 0,
        };
      });
    } catch (error: any) {
      console.error('Error fetching Confluence child pages:', error?.message ?? error);
      throw error;
    }
  }
}

export default new TechGovernanceReleasesIntakeService();
