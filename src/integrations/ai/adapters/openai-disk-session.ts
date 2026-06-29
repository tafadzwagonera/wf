import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { Session, AgentInputItem } from '@openai/agents';

export class WfDiskSession implements Session {
  private sessionId: string;
  private filePath: string;
  private items: AgentInputItem[] = [];
  private loaded = false;

  constructor(opts: { sessionId: string; filePath: string }) {
    this.sessionId = opts.sessionId;
    this.filePath = opts.filePath;
  }

  async getSessionId(): Promise<string> {
    return this.sessionId;
  }

  async getItems(limit?: number): Promise<AgentInputItem[]> {
    await this.ensureLoaded();
    const source = limit ? this.items.slice(-limit) : this.items;
    return structuredClone(source);
  }

  async addItems(items: AgentInputItem[]): Promise<void> {
    await this.ensureLoaded();
    this.items.push(...structuredClone(items));
    await this.persist();
  }

  async popItem(): Promise<AgentInputItem | undefined> {
    await this.ensureLoaded();
    const item = this.items.pop();
    if (item) await this.persist();
    return item;
  }

  async clearSession(): Promise<void> {
    this.items = [];
    await this.persist();
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;

    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        this.items = JSON.parse(raw) as AgentInputItem[];
      }
    } catch {
      this.items = [];
    }
  }

  private async persist(): Promise<void> {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${this.filePath}.tmp.${crypto.randomUUID()}`;
    fs.writeFileSync(tmpPath, JSON.stringify(this.items));
    fs.renameSync(tmpPath, this.filePath);
  }
}
