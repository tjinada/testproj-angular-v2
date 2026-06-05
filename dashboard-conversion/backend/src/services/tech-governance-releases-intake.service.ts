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
   * Normalize a branch / release identifier for matching: trim, lowercase, and
   * drop a leading "release/" prefix. So "R83", "r83", and "release/r83" all
   * normalize to "r83".
   */
  private normalizeBranch(value: string): string {
    return (value ?? '').trim().toLowerCase().replace(/^release\//, '');
  }

  /**
   * Branch lookup that is case-insensitive and tolerant of the "release/"
   * prefix. Matches a release-workflow Release ID (e.g. "R83" or "release/r83")
   * to a governance entry keyed by branch. Returns undefined if none match.
   */
  findByBranch(branch: string): TechGovernanceRelease | undefined {
    const target = this.normalizeBranch(branch);
    if (!target) return undefined;
    for (const [key, release] of Object.entries(this.releases)) {
      if (this.normalizeBranch(key) === target) return release;
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
