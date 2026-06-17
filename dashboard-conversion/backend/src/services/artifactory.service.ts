import axios, { AxiosInstance } from 'axios';
import config from '../config';
import { HttpsProxyAgent } from 'https-proxy-agent';
import fs from 'fs';
import path from 'path';
class ArtifactoryService {
  private static readonly DEPLOYMENT_DETAILS_PATH = '/cdb-Snapshots/CDB_Deployment_Details';
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

  private buildDeploymentPath(path: string): string {
    return `${ArtifactoryService.DEPLOYMENT_DETAILS_PATH}/${path.replace(/^\/+/, '')}`;
  }

  async getFileContent(path: string): Promise<any> {
    const response = await this.client.get(this.buildDeploymentPath(path));
    return response.data;
  }

  async saveFileContent(path: string, content: any): Promise<any> {
    const response = await this.client.put(this.buildDeploymentPath(path), content);
    return response.data;
  }

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
  
  async healthCheck(): Promise<boolean> {
    try {
      await this.client.get('/api/system/ping');
      return true;
    } catch (error) {
      return false;
    }
  }
}

export default new ArtifactoryService();
