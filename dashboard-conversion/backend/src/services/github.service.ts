import axios, { AxiosInstance } from 'axios';
import config from '../config';
import { HttpsProxyAgent } from 'https-proxy-agent';

/**
 * GitHub service.
 *
 * NOTE: This file in dashboard-conversion is a *reference copy* of the
 * production github.service.ts plus the new `searchPullRequests` method.
 * The production file already has the constructor and getFileContent;
 * only the new method below needs to be copied across.
 */
class GitHubService {
  private client: AxiosInstance;

  constructor() {
    const agent = new HttpsProxyAgent(
      `http://${config.proxy.username}:${config.proxy.password}@${config.proxy.host}:${config.proxy.port}`,
    );
    this.client = axios.create({
      baseURL: config.github.baseUrl,
      headers: {
        Authorization: `Bearer ${config.github.token}`,
        Accept: 'application/vnd.github.v3.raw',
      },
      ...(agent && { httpsAgent: agent, proxy: false }),
    });
  }

  async getFileContent<T>(owner: string, repo: string, path: string, ref = 'main'): Promise<T> {
    const url = `/repos/${owner}/${repo}/contents/${path}`;
    const response = await this.client.get(url, { params: { ref } });

    const { content, encoding } = response.data;

    if (encoding === 'base64') {
      const decoded = Buffer.from(content, 'base64').toString('utf-8');
      return JSON.parse(decoded);
    }

    return response.data;
  }

  /**
   * Fetch a single pull request by number.
   *
   * Hits GET /repos/{owner}/{repo}/pulls/{number}. Returns the PR object,
   * or null if it doesn't exist (404). Throws on other errors.
   *
   * Note: this endpoint returns JSON, not raw content, so we override the
   * Accept header for this call only — the client-level Accept is set to
   * `application/vnd.github.v3.raw` for getFileContent.
   *
   * @param owner   Repo owner / org
   * @param repo    Repo name
   * @param number  PR number
   */
  async getPullRequest(owner: string, repo: string, number: number): Promise<any | null> {
    try {
      const response = await this.client.get(
        `/repos/${owner}/${repo}/pulls/${number}`,
        {
          headers: {
            // Override the client-level raw Accept; this endpoint returns JSON.
            Accept: 'application/vnd.github+json',
          },
        },
      );
      return response.data;
    } catch (err: any) {
      if (err?.response?.status === 404) return null;
      throw err;
    }
  }

  /**
   * Fetch a single branch by name.
   *
   * Hits GET /repos/{owner}/{repo}/branches/{branch}. Returns the branch
   * object (with .name and .commit.sha) or null if it doesn't exist (404).
   * Throws on other errors.
   *
   * Branch names containing slashes (e.g. 'release/r85.0.0') must be
   * URL-encoded; encodeURIComponent handles that.
   */
  async getBranch(owner: string, repo: string, branch: string): Promise<any | null> {
    try {
      const response = await this.client.get(
        `/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`,
        {
          headers: {
            Accept: 'application/vnd.github+json',
          },
        },
      );
      return response.data;
    } catch (err: any) {
      if (err?.response?.status === 404) return null;
      throw err;
    }
  }

  /**
   * Fetch a single Git tag by name.
   *
   * Hits GET /repos/{owner}/{repo}/git/ref/tags/{tag}. Returns the ref
   * object (with .ref like 'refs/tags/v1.0.0' and .object.sha) or null
   * if the tag doesn't exist (404). Throws on other errors.
   *
   * Works for both lightweight and annotated tags. Doesn't require a
   * GitHub Release to exist for the tag.
   *
   * Tag names containing slashes (e.g. 'release/v1.0.0') must be
   * URL-encoded; encodeURIComponent handles that.
   */
  async getTag(owner: string, repo: string, tag: string): Promise<any | null> {
    try {
      const response = await this.client.get(
        `/repos/${owner}/${repo}/git/ref/tags/${encodeURIComponent(tag)}`,
        {
          headers: {
            Accept: 'application/vnd.github+json',
          },
        },
      );
      return response.data;
    } catch (err: any) {
      if (err?.response?.status === 404) return null;
      throw err;
    }
  }
}

export default new GitHubService();
