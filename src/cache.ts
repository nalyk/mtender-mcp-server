// Tiny LRU with TTL. Closed OCDS records don't change; cache for the lifetime
// of the process to avoid re-fetching the same tender across many tool calls.

interface Entry<V> {
  v: V;
  exp: number;
}

export class TtlLru<V> {
  private map = new Map<string, Entry<V>>();
  constructor(
    private readonly cap: number,
    private readonly ttlMs: number,
  ) {}

  get(k: string): V | undefined {
    const e = this.map.get(k);
    if (!e) return undefined;
    if (e.exp < Date.now()) {
      this.map.delete(k);
      return undefined;
    }
    // bump recency
    this.map.delete(k);
    this.map.set(k, e);
    return e.v;
  }

  set(k: string, v: V): void {
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, { v, exp: Date.now() + this.ttlMs });
    if (this.map.size > this.cap) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  size(): number {
    return this.map.size;
  }
}
