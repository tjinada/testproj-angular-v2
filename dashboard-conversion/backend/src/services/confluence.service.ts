import axios, { AxiosInstance } from 'axios';
import config from '../config';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { IntakeFormData } from './intake-template';
import { IntakePropertyPayload } from '../types/intake';

class ConfluenceService {
  private client: AxiosInstance;
  private cachedServiceAccountId: string | null = null;

  constructor() {
    const agent = new HttpsProxyAgent(`http://${config.proxy.username}:${config.proxy.password}@${config.proxy.target}`);
    this.client = axios.create({
      baseURL: config.confluence.baseUrl,
      headers: {
        'Authorization': `Basic ${config.confluence.apiToken}`,
      },
      ...(agent && { httpsAgent: agent, proxy: false }),
    });
  }

  private sleep(ms: number) {
    return new Promise((res) => setTimeout(res, ms));
  }

  private async withRetries<T>(fn: () => Promise<T>, attempts = 3, baseDelay = 200): Promise<T> {
    let lastErr: any;
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (err: any) {
        lastErr = err;
        // If it's a 413, don't retry
        if (err?.response?.status === 413) throw err;
        const delay = baseDelay * Math.pow(2, i);
        await this.sleep(delay);
      }
    }
    throw lastErr;
  }

  async getChildPagesContent(parentPageId: string): Promise<any> {
    const apiPrefix = config.confluence.baseUrl.includes('/rest/api') ? '' : 'rest/api/';
    const response = await this.client.get(`${apiPrefix}content/${parentPageId}/child/page?expand=history,version,body.storage&limit=100`);
    return response.data;
  }

  /**
   * Return the child pages (results array) for a given parent page id.
   * Uses the REST endpoint `/rest/api/content/{id}/child/page` and returns
   * the `results` array directly for easier client-side filtering.
   */
  async getChildPages(parentPageId: string, limit = 100): Promise<any[]> {
    const apiPrefix = config.confluence.baseUrl.includes('/rest/api') ? '' : 'rest/api/';
    const response = await this.client.get(`${apiPrefix}content/${parentPageId}/child/page`, {
      params: {
        limit,
        expand: 'version',
      },
    });
    return response.data?.results || [];
  }

  /**
   * Search Confluence using CQL and return results array
   */
  async searchByCql(cql: string): Promise<any[]> {
    const apiPrefix = config.confluence.baseUrl.includes('/rest/api') ? '' : 'rest/api/';
    const response = await this.client.get(`${apiPrefix}content/search`, {
      params: {
        cql,
        limit: 50,
        expand: 'version',
      },
    });
    return response.data?.results || [];
  }

  /**
   * Store the intake JSON as a Confluence content property on the given page.
   */
  async storeIntakeProperty(pageId: string, intakeData: IntakeFormData, createdBy: { name?: string; email?: string }): Promise<any> {
    const apiPrefix = config.confluence.baseUrl.includes('/rest/api') ? '' : 'rest/api/';
    const exportedAt = new Date().toISOString();
    const exportedBy = createdBy?.email || 'unknown';
    const payload: IntakePropertyPayload = {
      key: 'intake-data',
      value: {
        schemaVersion: 2,
        exportedAt,
        exportedBy,
        createdBy: createdBy || { name: exportedBy, email: exportedBy },
        step1: intakeData.step1,
        generalValues: intakeData.generalValues || {},
        selectedScopes: intakeData.selectedScopes || [],
        scopeValues: intakeData.scopeValues || {},
        dynamicRows: intakeData.dynamicRows || {},
        metadata: {
          createdBy: createdBy?.name || exportedBy,
          createdAt: exportedAt,
          lastModifiedBy: createdBy?.name || exportedBy,
          lastModifiedAt: exportedAt,
          editHistory: [],
        },
      },
    };

    return this.withRetries(async () => {
      const resp = await this.client.post(`${apiPrefix}content/${pageId}/property`, payload);
      return resp.data;
    });
  }

  async getIntakeProperty(pageId: string): Promise<null | any> {
    const apiPrefix = config.confluence.baseUrl.includes('/rest/api') ? '' : 'rest/api/';
    try {
      const resp = await this.client.get(`${apiPrefix}content/${pageId}/property/intake-data`);
      return resp.data || null;
    } catch (err: any) {
      if (err?.response?.status === 404) return null;
      throw err;
    }
  }

  /**
   * Get the current page version info (needed before updating).
   * Returns { id, title, version: { number } } or null if not found.
   */
  async getPageVersion(pageId: string): Promise<{ id: string; title: string; version: { number: number } } | null> {
    try {
      const apiPrefix = config.confluence.baseUrl.includes('/rest/api') ? '' : 'rest/api/';
      const response = await this.client.get(`${apiPrefix}content/${pageId}`, {
        params: { expand: 'version' },
      });
      return response.data || null;
    } catch (err: any) {
      if (err?.response?.status === 404) return null;
      throw err;
    }
  }

  async updateIntakeProperty(pageId: string, value: any, currentVersion: number): Promise<any> {
    const apiPrefix = config.confluence.baseUrl.includes('/rest/api') ? '' : 'rest/api/';
    const body: any = {
      key: 'intake-data',
      value,
      version: { number: (currentVersion || 1) + 1 },
    };

    try {
      return await this.withRetries(async () => {
        const resp = await this.client.put(`${apiPrefix}content/${pageId}/property/intake-data`, body);
        return resp.data;
      });
    } catch (err: any) {
      if (err?.response?.status === 409) {
        // conflict: refetch and retry once
        const latest = await this.client.get(`${apiPrefix}content/${pageId}/property/intake-data`);
        const latestVersion = latest.data?.version?.number || (currentVersion || 1);
        body.version.number = latestVersion + 1;
        return await this.client.put(`${apiPrefix}content/${pageId}/property/intake-data`, body);
      }
      if (err?.response?.status === 413) {
        console.warn('Intake property payload too large (413) for page', pageId);
        throw err;
      }
      throw err;
    }
  }

  async getPageContent(pageId: string): Promise<any> {
    const apiPrefix = config.confluence.baseUrl.includes('/rest/api') ? '' : 'rest/api/';
    const response = await this.client.get(`${apiPrefix}content/${pageId}?expand=history,version,body.storage`);
    return response.data;
  }

  async savePageContent(pageId: string, content: any): Promise<any> {
    const apiPrefix = config.confluence.baseUrl.includes('/rest/api') ? '' : 'rest/api/';
    const response = await this.client.put(`${apiPrefix}content/${pageId}`, {
      id: pageId,
      type: 'page',
      title: 'new page', // If page title update is needed, it can be passed as an argument to this method
      space: { key: 'TST' },
      body: {
        storage: {
          value: content,
          representation: 'storage',
        },
      },
      version: { number: 2 },
    });
    return response.data;
  }

  async createPage(payload: { spaceId?: string; parentId?: string; title: string; bodyStorage: string }): Promise<any> {
    const { spaceId, parentId, title, bodyStorage } = payload;
    // Prefer the v2 API for Atlassian cloud (/wiki/api/v2/pages), fall back to REST create
    try {
      const v2Path = '/wiki/api/v2/pages';
      const body: any = {
        type: 'page',
        title,
        body: {
          storage: { value: bodyStorage, representation: 'storage' },
        },
      };
      if (spaceId) body.space = { key: spaceId };
      if (parentId) body.ancestors = [{ id: parentId }];
      const resp = await this.client.post(v2Path, body);
      return resp.data;
    } catch (err) {
      // Fallback to legacy REST API
      const apiPrefix = config.confluence.baseUrl.includes('/rest/api') ? '' : 'rest/api/';
      const restBody: any = {
        type: 'page',
        title,
        body: { storage: { value: bodyStorage, representation: 'storage' } },
      };
      if (spaceId) restBody.space = { key: spaceId };
      if (parentId) restBody.ancestors = [{ id: parentId }];
      const resp = await this.client.post(`${apiPrefix}content`, restBody);
      return resp.data;
    }
  }

  async updatePage(...args: any[]): Promise<any> {
    // Support two calling conventions for backwards compatibility:
    // 1) updatePage({ pageId, newBodyStorage, currentVersion, title, spaceKey })
    // 2) updatePage(pageId, { title, body, version, versionMessage })
    if (args.length === 1 && typeof args[0] === 'object' && args[0].pageId) {
      const payload = args[0];
      const { pageId, newBodyStorage, currentVersion = 1, title, spaceKey } = payload;
      try {
        const v2Path = `/wiki/api/v2/pages/${pageId}`;
        const body: any = {
          id: pageId,
          type: 'page',
          body: { storage: { value: newBodyStorage, representation: 'storage' } },
          version: { number: currentVersion + 1 },
        } as any;
        if (title) body.title = title;
        if (spaceKey) body.space = { key: spaceKey };
        const resp = await this.client.put(v2Path, body);
        return resp.data;
      } catch (err) {
        const apiPrefix = config.confluence.baseUrl.includes('/rest/api') ? '' : 'rest/api/';
        const restBody: any = {
          id: pageId,
          type: 'page',
          title: title || 'updated page',
          body: { storage: { value: newBodyStorage, representation: 'storage' } },
          version: { number: currentVersion + 1 },
        };
        if (spaceKey) restBody.space = { key: spaceKey };
        const resp = await this.client.put(`${apiPrefix}content/${pageId}`, restBody);
        return resp.data;
      }
    }

    // New-style: updatePage(pageId, options)
    const [pageId, options] = args;
    const title = options?.title || '';
    const bodyHtml = options?.body || '';
    const versionNumber = options?.version || 1;
    const versionMessage = options?.versionMessage || 'Updated via CDB Dashboard';

    const apiPrefix = config.confluence.baseUrl.includes('/rest/api') ? '' : 'rest/api/';
    const putBody: any = {
      type: 'page',
      title: title || 'updated page',
      body: {
        storage: {
          value: bodyHtml,
          representation: 'storage',
        },
      },
      version: {
        number: versionNumber,
        message: versionMessage,
      },
    };

    const resp = await this.client.put(`${apiPrefix}content/${pageId}`, putBody);
    return resp.data;
  }

  async lockPage(pageId: string): Promise<any> {
    const apiPrefix = config.confluence.baseUrl.includes('/rest/api') ? '' : 'rest/api/';
    const serviceAccountId = await this.getServiceAccountId();

    const body = [
      {
        operation: 'update',
        restrictions: {
          user: [
            {
              type: 'known',
              accountId: serviceAccountId,
            },
          ],
        },
      },
    ];

    try {
      return await this.withRetries(async () => {
        const resp = await this.client.put(`${apiPrefix}content/${pageId}/restriction`, body, { headers: { 'Content-Type': 'application/json' } });
        return resp.data;
      });
    } catch (err: any) {
      if (err?.response?.status === 404) {
        console.error('Cannot lock Confluence page, page not found', pageId);
        return null;
      }
      if (err?.response?.status === 403) {
        console.error('Forbidden locking Confluence page - service account lacks permission', pageId, err?.response?.data ?? err?.message);
        return null;
      }
      throw err;
    }
  }

  async unlockPage(pageId: string): Promise<any> {
    const apiPrefix = config.confluence.baseUrl.includes('/rest/api') ? '' : 'rest/api/';
    const serviceAccountId = await this.getServiceAccountId();
    try {
      return await this.withRetries(async () => {
        const resp = await this.client.delete(`${apiPrefix}content/${pageId}/restriction/byOperation/update/user/accountId/${serviceAccountId}`);
        return resp.data;
      });
    } catch (err: any) {
      if (err?.response?.status === 404) {
        console.error('Cannot unlock Confluence page, page or restriction not found', pageId);
        return null;
      }
      if (err?.response?.status === 403) {
        console.error('Forbidden unlocking Confluence page - service account lacks permission', pageId, err?.response?.data ?? err?.message);
        return null;
      }
      throw err;
    }
  }

  async isPageLocked(pageId: string): Promise<boolean> {
    const apiPrefix = config.confluence.baseUrl.includes('/rest/api') ? '' : 'rest/api/';
    try {
      const resp = await this.client.get(`${apiPrefix}content/${pageId}/restriction/byOperation/update`);
      const users = resp.data?.results?.[0]?.restrictions?.user || resp.data?.restrictions?.user || [];
      return Array.isArray(users) && users.length > 0;
    } catch (err: any) {
      if (err?.response?.status === 404) {
        console.error('isPageLocked: page not found', pageId);
        return false;
      }
      if (err?.response?.status === 403) {
        console.error('isPageLocked: forbidden checking restrictions for page', pageId, err?.response?.data ?? err?.message);
        return false;
      }
      throw err;
    }
  }

  async getServiceAccountId(): Promise<string> {
    if (this.cachedServiceAccountId) return this.cachedServiceAccountId;
    const apiPrefix = config.confluence.baseUrl.includes('/rest/api') ? '' : 'rest/api/';
    const resp = await this.withRetries(async () => this.client.get(`${apiPrefix}user/current`));
    const accountId = resp?.data?.accountId;
    if (!accountId) throw new Error('Could not determine Confluence service accountId from /user/current');
    this.cachedServiceAccountId = accountId;
    return accountId;
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.client.get('/space?limit=1');
      return true;
    } catch (error) {
      return false;
    }
  }
}

export default new ConfluenceService();
