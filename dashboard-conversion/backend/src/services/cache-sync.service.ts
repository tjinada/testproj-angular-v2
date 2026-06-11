import axios from 'axios';
import https from 'node:https';
import config from '../config';

/**
 * Logical cache "topics" that can be refreshed cross-pod.
 * Each topic maps to one in-memory cache held by a service.
 */
export const CACHE_TOPIC = {
  APP_DATA: 'app-data',
  DA_TEAMS: 'da-teams',
  TECH_GOVERNANCE_RELEASES_INTAKE: 'tech-governance-releases-intake',
  RELEASE_WORKFLOW: 'release-workflow',
  ENVS_DASHBOARD: 'envs-dashboard',
  CMS_BANNERS: 'cms-banners',
  SAAS_PROXY_SETUP: 'saas-proxy-setup',
} as const;

export type CacheTopic = (typeof CACHE_TOPIC)[keyof typeof CACHE_TOPIC];
export const CACHE_TOPIC_VALUES: CacheTopic[] = Object.values(CACHE_TOPIC);

export const CACHE_SYNC_SECRET_HEADER = 'x-cache-sync-secret';

type CacheReloader = () => Promise<void>;

class CacheSyncService {
  private readonly reloaders = new Map<CacheTopic, CacheReloader>();

  private readonly httpsAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

  register(topic: CacheTopic, reloader: CacheReloader): void {
    if (this.reloaders.has(topic)) {
      console.warn(`[cache-sync] Reloader for topic "${topic}" is being overridden`);
    }
    this.reloaders.set(topic, reloader);
  }

  hasTopic(topic: CacheTopic): boolean {
    return this.reloaders.has(topic);
  }

  async refresh(topic: CacheTopic): Promise<void> {
    const reloader = this.reloaders.get(topic);
    if (!reloader) {
      throw new Error(`No cache reloader registered for topic "${topic}"`);
    }
    console.log(`[cache-sync] Refreshing local cache: ${topic}`);
    await reloader();
  }

  notifyPeers(topic: CacheTopic): void {
    const peers = config.cacheSync.peerUrls;
    if (!peers.length) return;

    for (const peer of peers) {
      this.postRefresh(peer, topic).catch((err) => {
        console.error(
          `[cache-sync] Failed to notify peer "${peer}" for topic "${topic}":`,
          err?.message ?? err,
        );
      });
    }
  }

  private async postRefresh(peerBaseUrl: string, topic: CacheTopic): Promise<void> {
    const url = `${peerBaseUrl}/api/cache-sync/refresh`;
    await axios.post(
      url,
      { topic },
      {
        httpsAgent: this.httpsAgent,
        proxy: false,
        headers: {
          [CACHE_SYNC_SECRET_HEADER]: config.cacheSync.secret,
          'Content-Type': 'application/json',
        },
        validateStatus: (s) => s >= 200 && s < 300,
      },
    );
    console.log(`[cache-sync] Notified peer ${peerBaseUrl} -> ${topic}`);
  }
}

export default new CacheSyncService();
