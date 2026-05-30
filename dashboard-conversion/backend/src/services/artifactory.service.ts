import axios, { AxiosInstance } from 'axios';
import config from '../config';
import { HttpsProxyAgent } from 'https-proxy-agent';
import fs from 'fs';
import path from 'path';
import cacheSyncService from './cache-sync.service';

class ArtifactoryService {
  private client: AxiosInstance;

  constructor() {
    const agent = new HttpsProxyAgent(`http://${config.proxy.username}:${config.proxy.password}@${config.proxy.target}`);
    this.client = axios.create({
      baseURL: config.artifactory.baseUrl,
      headers: {
        'X-JFrog-Art-Api': `${config.artifactory.token}`,
      },
      ...(agent && { httpsAgent: agent, proxy: false }),
    });

    this.initializeSaaSProxySetupScript();
    cacheSyncService.register('saas-proxy-setup', () => this.initializeSaaSProxySetupScript());
  }

  async initializeSaaSProxySetupScript() {
    try {
      const scriptContent = await this.getFileContent('saas_proxy_setup.sh');
      const targetPath = path.join(__dirname, '../scripts/saas_proxy_setup.sh');
      fs.writeFileSync(targetPath, scriptContent, 'utf8');
      console.log('SaaS proxy setup script initialized successfully');
    } catch (error) {
      console.error('Error initializing SaaS proxy setup script:', error);
    }
  }

  async getFileContent(path: string): Promise<any> {
    const response = await this.client.get(`${path}`);
    return response.data;
  }

  /**
   * Check whether an artifact exists at the given Artifactory repo path.
   *
   * Probes with HEAD (no body) and returns true on 2xx, false on 404.
   * If the proxy rejects HEAD (405/501), retries once with GET and discards
   * the body. Any other error (auth, proxy, 5xx) is re-thrown so the caller
   * surfaces a real failure rather than masking it as "not found".
   */
  async artifactExists(artifactPath: string): Promise<boolean> {
    try {
      await this.client.head(`${artifactPath}`);
      return true;
    } catch (error: any) {
      const status = error?.response?.status;
      if (status === 404) return false;
      // Some proxies don't allow HEAD — fall back to GET once.
      if (status === 405 || status === 501) {
        try {
          await this.client.get(`${artifactPath}`);
          return true;
        } catch (getError: any) {
          if (getError?.response?.status === 404) return false;
          throw getError;
        }
      }
      throw error;
    }
  }

  async saveFileContent(path: string, content: any): Promise<any> {
    const response = await this.client.put(`${path}`, content);
    return response.data;
  }
}

export default new ArtifactoryService();
