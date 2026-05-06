import axios, { AxiosInstance } from 'axios';
import config from '../config';
import { HttpsProxyAgent } from 'https-proxy-agent';

/**
 * JIRA service.
 *
 * Mirrors the structure of confluence.service.ts: a single axios client
 * configured at construction time with baseURL + Basic auth + optional
 * proxy agent. Methods return parsed JSON, or null on 404 so callers can
 * cleanly detect "not found" without try/catch.
 *
 * Expected config shape (config.jira):
 *   - baseUrl:    string  (e.g. "https://jira.example.com/rest/api/2")
 *   - apiToken:   string  (full Basic auth value, e.g. "Basic <base64>")
 *   - projectKey: string  (e.g. "SSRELEASE") — used for fix-version lookup
 *
 * Currently only reads. Add createIssue / searchIssues when a stage owner
 * needs them.
 */
class JiraService {
  private client: AxiosInstance;

  constructor() {
    const agent = new HttpsProxyAgent(
      `http://${config.proxy.username}:${config.proxy.password}@${config.proxy.host}:${config.proxy.port}`,
    );
    this.client = axios.create({
      baseURL: config.jira.baseUrl,
      headers: {
        'Authorization': `Basic ${config.jira.apiToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      ...(agent && { httpsAgent: agent, proxy: false }),
    });
  }

  /**
   * Look up a JIRA issue by key (e.g. "SSRELEASE-6688").
   * Returns the parsed issue object, or null if the issue doesn't exist.
   * Throws for non-404 errors.
   */
  async getIssue(issueKey: string): Promise<any | null> {
    try {
      const response = await this.client.get(`/issue/${encodeURIComponent(issueKey)}`);
      return response.data;
    } catch (err: any) {
      if (err?.response?.status === 404) return null;
      throw err;
    }
  }

  /**
   * Look up a Fix Version by name in the configured project.
   * Returns the matching version object ({ id, name, released, ... }) or
   * null if no version with that name exists.
   *
   * Hits GET /project/{projectKey}/versions and filters in JS — JIRA has
   * no direct "get version by name" endpoint. Most projects have under a
   * few hundred versions so the cost is fine.
   */
  async getFixVersionByName(versionName: string): Promise<any | null> {
    const projectKey = config.jira.projectKey;
    if (!projectKey) {
      throw new Error('config.jira.projectKey is not set');
    }

    try {
      const response = await this.client.get(
        `/project/${encodeURIComponent(projectKey)}/versions`,
      );
      const versions: any[] = Array.isArray(response.data) ? response.data : [];
      return versions.find((v) => v?.name === versionName) ?? null;
    } catch (err: any) {
      if (err?.response?.status === 404) return null;
      throw err;
    }
  }
}

export default new JiraService();
