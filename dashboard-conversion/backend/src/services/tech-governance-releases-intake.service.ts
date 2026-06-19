import artifactoryService from './artifactory.service';
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
  // Derived scope: comma-separated list e.g. "CDB UI Config, Akamai"
  scope?: string;
  // Optional Confluence-sourced dev lead contact info (preferred over DA tab)
  confluenceDevLeadName?: string;
  confluenceDevLeadEmail?: string;
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

  private normalizeBranch(value: string): string {
    return (value ?? '').trim().toLowerCase().replace(/^release\//, '');
  }

  findByBranch(branch: string): TechGovernanceRelease | undefined {
    const target = this.normalizeBranch(branch);
    if (!target) return undefined;
    for (const [key, release] of Object.entries(this.releases)) {
      if (this.normalizeBranch(key) === target) return release;
    }
    return undefined;
  }

  exists(key: string): boolean {
    return Boolean(this.releases[key]);
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

  async addEmptyRelease(key: string): Promise<TechGovernanceRelease> {
    return this.add(key, {
      details: '',
      intakePageId: '',
      branch: key,
      intakes: [],
      gracePeriodInDays: 0,
    });
  }

  async setIntakePageId(key: string, intakePageId: string): Promise<TechGovernanceRelease> {
    const existing = this.releases[key];
    if (!existing) {
      throw new Error(`Release '${key}' not found`);
    }
    if (!intakePageId || typeof intakePageId !== 'string') {
      throw new Error('intakePageId is required');
    }

    const intakes = await this.fetchConfluenceChildPagesDetails(intakePageId);

    // Preserve existing platformVeto values when refreshing intakes.
    const prevById = new Map(existing.intakes.map((i) => [i.id, i]));
    const mergedIntakes = intakes.map((intake) => {
      const prev = prevById.get(intake.id);
      if (prev && prev.platformVeto) {
        return { ...intake, platformVeto: prev.platformVeto };
      }
      return intake;
    });

    return this.update(key, {
      ...existing,
      intakePageId,
      intakes: mergedIntakes,
    });
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

        // Helper to strip tags and whitespace
        const strip = (html: string): string => (html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

        // Extract table cell HTML (raw) for a row matching label in first cell
        const extractFieldHtml = (html: string, label: string): string | undefined => {
          if (!html) return undefined;
          const rows = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
          for (const row of rows) {
            const cells = row.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || [];
            if (cells.length < 2) continue;
            const first = strip(cells[0] ?? '').toLowerCase();
            if (first.includes(label.toLowerCase())) {
              return cells[1];
            }
          }
          return undefined;
        };

        // Extract a section that may span multiple table rows. Start at the
        // row whose first cell contains the label, then include subsequent
        // rows until a new bold header (<strong> or <b>) appears in the first cell.
        const extractMultiRowFieldHtml = (html: string, label: string): string | undefined => {
          if (!html) return undefined;
          const rows = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
          let collecting = false;
          let collected = '';
          for (const row of rows) {
            const cells = row.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || [];
            if (cells.length < 1) continue;
            const firstCellHtml = cells[0] ?? '';
            const firstCellText = strip(firstCellHtml).toLowerCase();

            if (!collecting) {
              if (firstCellText.includes(label.toLowerCase())) {
                collecting = true;
                collected += cells.join(' ');
              }
            } else {
              // If we hit another header (strong/bold) in the first cell,
              // stop collecting — it's the next section.
              if (/\<strong\>|<b>/i.test(firstCellHtml)) break;
              collected += cells.join(' ');
            }
          }
          return collected ? collected : undefined;
        };

        // Determine whether a specific option is CHECKED inside the cell html.
        // Tries Confluence storage ac:task entries first, then falls back to text checks for "[x] Option".
        const isCheckedOption = (cellHtml: string | undefined, optionKeywords: string | string[]): boolean => {
          if (!cellHtml) return false;
          const keywords = Array.isArray(optionKeywords) ? optionKeywords : [optionKeywords];

          // Check ac:task blocks if present
          const taskMatches = cellHtml.match(/<ac:task[\s\S]*?<\/ac:task>/gi) || [];
          if (taskMatches.length > 0) {
            for (const task of taskMatches) {
              const statusMatch = task.match(/<ac:task-status>([\w-]+)<\/ac:task-status>/i);
              const completed = !!(statusMatch && /^(complete|done|true)$/i.test(statusMatch[1]));
              if (!completed) continue;
              const bodyMatch = task.match(/<ac:task-body[\s\S]*?>([\s\S]*?)<\/ac:task-body>/i);
              const bodyText = bodyMatch ? strip(bodyMatch[1]) : strip(task);
              for (const kw of keywords) {
                if (new RegExp('\\b' + kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(bodyText)) return true;
              }
            }
          }

          // Fallback: look for explicit "[x] <option>" in the stripped text
          const text = strip(cellHtml);
          for (const kw of keywords) {
            const rx = new RegExp('\\[x\\]\\s*' + kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
            if (rx.test(text)) return true;
          }
          return false;
        };

        // Parse checklist-like table fields from page body HTML
        const bodyHtml: string = page.body?.storage?.value || '';

        const addingToggleCell = extractMultiRowFieldHtml(bodyHtml, 'Adding/Updating Toggle') || extractFieldHtml(bodyHtml, 'Adding/Updating Toggle');
        const changingConfigCell = extractMultiRowFieldHtml(bodyHtml, 'Changing Configurations') || extractFieldHtml(bodyHtml, 'Changing Configurations');
        const addingOrChangingApisCell = extractMultiRowFieldHtml(bodyHtml, 'Adding or changing APIs') || extractFieldHtml(bodyHtml, 'Adding or changing APIs');
        const devLeadNameVal = strip(extractFieldHtml(bodyHtml, 'Dev Lead Name') || extractFieldHtml(bodyHtml, 'Dev Lead') || '');
        const devLeadEmailVal = strip(extractFieldHtml(bodyHtml, 'Dev Lead Email') || extractFieldHtml(bodyHtml, 'Dev Lead E-mail') || '');

        const hasUIToggle = isCheckedOption(addingToggleCell, ['UI']);
        const hasBOSToggle = isCheckedOption(addingToggleCell, ['CDBBOS', 'CDB BOS', 'BOS']);
        const hasUIConfig = isCheckedOption(changingConfigCell, ['UI config', 'UI configuration', 'UI Config']);
        const hasBOSConfig = isCheckedOption(changingConfigCell, ['CDBBOS Config', 'CDB BOS Config', 'BOS Config', 'CDBBOS Config']);
        const hasAPIChanges = isCheckedOption(addingOrChangingApisCell, ['Yes', 'Y', 'New API endpoints']);


        const touchesUI = hasUIToggle || hasUIConfig;
        const touchesBOS = hasBOSToggle || hasBOSConfig || hasAPIChanges;

        // --- PRIMARY: explicit Scope column from Confluence page ---
        // Prefer exact "Change Scope" row in the new template, fall back to
        // a broader "Scope" match for older pages.
        const ALL_SCOPE_OPTIONS = [
          'CDB UI',
          'CDB UI Config',
          'CDB BOS',
          'CDB BOS Config',
          'Akamai',
          'Channels Changes',
          'Lambda Changes',
        ];
        const changeScopeCellHtml = extractFieldHtml(bodyHtml, 'Change Scope') || extractFieldHtml(bodyHtml, 'Scope');
        let scope: string | undefined;
        let scopeSource = 'checklist-fallback';

        if (changeScopeCellHtml) {
          // Collect all explicitly checked options from the Change Scope row.
          const checkedScopes: string[] = [];
          for (const option of ALL_SCOPE_OPTIONS) {
            if (isCheckedOption(changeScopeCellHtml, [option])) checkedScopes.push(option);
          }
          if (checkedScopes.length > 0) {
            scope = checkedScopes.join(', ');
            scopeSource = 'explicitScope';
          }
        }

        // Diagnostic logs to help trace parsing decisions
        try {
          console.debug('[INTAKE DEBUG] pageId=%s title=%s changeScopeCellHtmlPresent=%s', page.id, page.title, !!changeScopeCellHtml);
          console.debug(
            '[INTAKE DEBUG] checks: hasUIToggle=%s hasBOSToggle=%s hasUIConfig=%s hasBOSConfig=%s hasAPIChanges=%s',
            hasUIToggle,
            hasBOSToggle,
            hasUIConfig,
            hasBOSConfig,
            hasAPIChanges,
          );
          console.debug('[INTAKE DEBUG] touchesUI=%s touchesBOS=%s', touchesUI, touchesBOS);
          console.debug('[INTAKE DEBUG] devLead: name=%s email=%s', devLeadNameVal || '(none)', devLeadEmailVal || '(none)');
        } catch (logErr) {
          // Swallow logging errors to avoid breaking parsing
        }

        // --- FALLBACK: derive scope from checklist fields (inferred signals) ---
        if (!scope) {
          scopeSource = 'checklist-fallback';
          const inferredScopes: string[] = [];

          if (hasUIConfig) inferredScopes.push('CDB UI Config');
          else if (hasUIToggle) inferredScopes.push('CDB UI');

          if (hasBOSConfig) inferredScopes.push('CDB BOS Config');
          else if (hasBOSToggle) inferredScopes.push('CDB BOS');

          // API changes imply BOS only if we haven't already added another BOS signal
          if (hasAPIChanges && !hasBOSConfig && !hasBOSToggle) inferredScopes.push('CDB BOS');

          if (inferredScopes.length > 0) {
            scope = inferredScopes.join(', ');
          }
        }

        // Final diagnostic of chosen scope, include which source determined it.
        try {
          console.debug(
            '[INTAKE DEBUG] resolved scope=%s for pageId=%s (source: %s)',
            scope || '(unset)',
            page.id,
            scopeSource,
          );
        } catch (logErr) {
          // ignore
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
          scope,
          confluenceDevLeadName: devLeadNameVal || undefined,
          confluenceDevLeadEmail: devLeadEmailVal || undefined,
        };
      });
    } catch (error: any) {
      console.error('Error fetching Confluence child pages:', error?.message ?? error);
      throw error;
    }
  }
}

export default new TechGovernanceReleasesIntakeService();
