import type { ImStatus } from '@af/shared';
import { dingtalk } from './dingtalk.js';

export interface ImAdapter {
  readonly id: string;
  readonly enabled: boolean;
  start(): void;
  notifyAdmins(title: string, markdown: string): Promise<void>;
}

class ImRegistry {
  private adapters = new Map<string, ImAdapter>();

  register(adapter: ImAdapter) {
    this.adapters.set(adapter.id, adapter);
  }

  startAll() {
    for (const a of this.adapters.values()) a.start();
  }

  get hasEnabled() {
    return [...this.adapters.values()].some((a) => a.enabled);
  }

  async notifyAdmins(title: string, markdown: string) {
    await Promise.all(
      [...this.adapters.values()]
        .filter((a) => a.enabled)
        .map((a) => a.notifyAdmins(title, markdown)),
    );
  }

  status(): ImStatus {
    return { dingtalk: dingtalk.status };
  }
}

export const imRegistry = new ImRegistry();
imRegistry.register({
  id: 'dingtalk',
  get enabled() {
    return dingtalk.enabled;
  },
  start: () => dingtalk.start(),
  notifyAdmins: (title, md) => dingtalk.notifyAdmins(title, md),
});
