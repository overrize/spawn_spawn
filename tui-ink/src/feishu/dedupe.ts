export class BoundedMessageDeduper {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];

  constructor(private readonly maxSize = 1000) {}

  has(id: string): boolean {
    return this.seen.has(id);
  }

  add(id: string): void {
    if (!id || this.seen.has(id)) return;
    this.seen.add(id);
    this.order.push(id);
    while (this.order.length > this.maxSize) {
      const oldest = this.order.shift();
      if (oldest) this.seen.delete(oldest);
    }
  }

  checkAndAdd(id: string): boolean {
    if (!id) return false;
    if (this.seen.has(id)) return true;
    this.add(id);
    return false;
  }

  size(): number {
    return this.seen.size;
  }
}
