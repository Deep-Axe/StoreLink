export type ChatLimits = {
  perUserHour: number;
  perUserConcurrent: number;
  perTeamConcurrent: number;
  globalConcurrent: number;
};
export const defaultChatLimits: ChatLimits = {
  perUserHour: 15,
  perUserConcurrent: 1,
  perTeamConcurrent: 4,
  globalConcurrent: 16,
};
export class ChatBusyError extends Error {}

// Process-local admission for a single gateway process and tests; the cluster
// uses PostgresChatAdmission so limits hold across replicas.
export class ChatAdmission {
  private hourly = new Map<string, { count: number; until: number }>();
  private users = new Map<string, number>();
  private teams = new Map<string, number>();
  private conversations = new Set<string>();
  private active = 0;
  limits: ChatLimits;
  constructor(limits: Partial<ChatLimits> = {}) {
    this.limits = { ...defaultChatLimits, ...limits };
    if (
      Object.values(this.limits).some((n) => !Number.isSafeInteger(n) || n < 1)
    )
      throw new Error('Chat limits must be positive integers');
  }
  acquire(
    user: string,
    team: string,
    conversation?: string,
    now = Date.now(),
  ): () => void {
    for (const [id, value] of this.hourly)
      if (value.until <= now) this.hourly.delete(id);
    const hour = this.hourly.get(user);
    if ((hour?.count ?? 0) >= this.limits.perUserHour)
      throw new ChatBusyError(
        'Hourly chat limit reached; try again after the current hour window.',
      );
    if (
      (this.users.get(user) ?? 0) >= this.limits.perUserConcurrent ||
      (this.teams.get(team) ?? 0) >= this.limits.perTeamConcurrent ||
      this.active >= this.limits.globalConcurrent ||
      (conversation && this.conversations.has(conversation))
    )
      throw new ChatBusyError(
        'Chat is busy; wait for an active answer to finish.',
      );
    if (!hour && this.hourly.size >= 10000)
      throw new ChatBusyError('Chat is busy; try again later.');
    this.hourly.set(user, {
      count: (hour?.count ?? 0) + 1,
      until: hour?.until ?? now + 3600000,
    });
    this.users.set(user, (this.users.get(user) ?? 0) + 1);
    this.teams.set(team, (this.teams.get(team) ?? 0) + 1);
    this.active++;
    if (conversation) this.conversations.add(conversation);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      for (const [map, key] of [
        [this.users, user],
        [this.teams, team],
      ] as const) {
        const count = (map.get(key) ?? 1) - 1;
        if (count) map.set(key, count);
        else map.delete(key);
      }
      if (conversation) this.conversations.delete(conversation);
    };
  }
}
