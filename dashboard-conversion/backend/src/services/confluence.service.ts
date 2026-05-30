import axios, { AxiosInstance } from 'axios';
import config from '../config';
import { HttpsProxyAgent } from 'https-proxy-agent';

class ConfluenceService {
  private client: AxiosInstance;

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

  async getChildPagesContent(parentPageId: string): Promise<any> {
    const response = await this.client.get(`content/${parentPageId}/child/page?expand=history,version,body.storage&limit=100`);
    return response.data;
  }

  async getPageContent(pageId: string): Promise<any> {
    const response = await this.client.get(`content/${pageId}?expand=history,version,body.storage`);
    return response.data;
  }

  async savePageContent(pageId: string, content: any): Promise<any> {
    const response = await this.client.put(`content/${pageId}`, {
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
}

export default new ConfluenceService();
