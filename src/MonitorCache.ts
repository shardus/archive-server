import {ConsensusNodeInfo} from "./NodeList";
import {config} from "./Config";
import fetch from 'node-fetch'
import {NodeInfo} from "@shardus/types/build/src/p2p/P2PTypes";

export class MonitorCache {
  private static instance: MonitorCache;
  private readonly REFRESH_INTERVAL = 1000 * 60; // 1 minute
  private intervalId: NodeJS.Timer | null;
  private activeNodeCache: ConsensusNodeInfo[] = [];
  private syncingNodeCache: ConsensusNodeInfo[] = [];
  private publicKeyMap: Map<string, string> = new Map();
  private initialized: boolean;
  private jwtToken: string;

  private constructor() {
  }

  public static getInstance(): MonitorCache {
    if (!MonitorCache.instance) {
      MonitorCache.instance = new MonitorCache();
    }
    return MonitorCache.instance;
  }

  private async authenticate(): Promise<void> {
    try {
      const response = await fetch(`http://${config.MONITOR_IP}:${config.MONITOR_PORT}/api/signin`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: config.MONITOR_USERNAME,
            password: config.MONITOR_PASSWORD,
          })
        })
      if (!response.ok) throw new Error('Authentication failed');
      const data = await response.json();
      this.jwtToken = data.token;
    } catch (error) {
      console.error('Error during authentication:', error);
      throw new Error('Authentication failed');
    }
  }

  public async getActiveNodes(): Promise<ConsensusNodeInfo[]> {
    if (!this.initialized) {
      await this.init();
    }
    return this.activeNodeCache;
  }

  public async getSyncingNodes(): Promise<ConsensusNodeInfo[]> {
    if (!this.initialized) {
      await this.init();
    }
    return this.syncingNodeCache;
  }

  private mapNodeData(data: any): ConsensusNodeInfo[] {
    const consensusNodes: ConsensusNodeInfo[] = [];

    for (const nodeId in data) {
      if (data.hasOwnProperty(nodeId)) {
        const node = data[nodeId];
        consensusNodes.push({
          ip: node.nodeIpInfo.externalIp,
          port: node.nodeIpInfo.externalPort,
          publicKey: '',
          id: nodeId,
        });
      }
    }
    return consensusNodes;
  }

  private async init(): Promise<void> {
    await this.authenticate();
    await this.refreshData();
    if (!this.intervalId) {
      this.intervalId = setInterval(() => this.refreshData(), this.REFRESH_INTERVAL);
    }
    this.initialized = true;
  }

  async refreshData(): Promise<void> {
    try {
      const response = await fetch(`http://${config.MONITOR_IP}:${config.MONITOR_PORT}/api/report`, {
        method: 'get',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.jwtToken}`
        },
        timeout: 5000,
      }).then((res) => res.json())
      const activeNodes = this.mapNodeData(response.nodes.active);
      const syncingNodes = this.mapNodeData(response.nodes.syncing);

      await Promise.allSettled([
          ...activeNodes.map(node => this.fetchNodeInfo(node)),
          ...syncingNodes.map(node => this.fetchNodeInfo(node))]);
      this.activeNodeCache = activeNodes.map(node => ({
        ...node,
        publicKey: this.publicKeyMap.get(node.id) || ''
      }));
      this.syncingNodeCache = syncingNodes.map(node => ({
        ...node,
        publicKey: this.publicKeyMap.get(node.id) || ''
      }));

    } catch (error) {
      console.error('Error fetching data:', error);
    }
  }


  async fetchNodeInfo(node: ConsensusNodeInfo): Promise<void> {
    if (!this.publicKeyMap.has(node.ip)) {
      try {
        const response = await fetch(`http://${node.ip}:${node.port}/nodeinfo`);
        if (!response.ok) throw new Error(`Failed to fetch node info for ${node.ip}:${node.port}`);
        const data  = await response.json();
        this.publicKeyMap.set(node.id, data.nodeInfo.publicKey);
      } catch (error) {
        console.error(`Error fetching node info for ${node.ip}:${node.port}`, error);
      }
    }
  }
}
