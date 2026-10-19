import { Injectable } from '@nestjs/common';

type Labels = Record<string, string>;

const LATENCY_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

const key = (name: string, labels: Labels = {}) => {
  const parts = Object.keys(labels)
    .sort()
    .map((k) => `${k}="${labels[k]}"`);
  return parts.length ? `${name}{${parts.join(',')}}` : name;
};

/**
 * Minimal in-process metrics registry exposed in Prometheus text format at
 * GET /metrics. Per instance by design: Prometheus scrapes every instance.
 */
@Injectable()
export class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly histograms = new Map<string, { buckets: number[]; sum: number; count: number }>();

  increment(name: string, by = 1, labels?: Labels): void {
    const k = key(name, labels);
    this.counters.set(k, (this.counters.get(k) ?? 0) + by);
  }

  set(name: string, value: number, labels?: Labels): void {
    this.gauges.set(key(name, labels), value);
  }

  observeMs(name: string, ms: number, labels?: Labels): void {
    const k = key(name, labels);
    const h = this.histograms.get(k) ?? { buckets: LATENCY_BUCKETS_MS.map(() => 0), sum: 0, count: 0 };
    LATENCY_BUCKETS_MS.forEach((le, i) => {
      if (ms <= le) h.buckets[i] = (h.buckets[i] ?? 0) + 1;
    });
    h.sum += ms;
    h.count += 1;
    this.histograms.set(k, h);
  }

  counter(name: string, labels?: Labels): number {
    return this.counters.get(key(name, labels)) ?? 0;
  }

  render(): string {
    const lines: string[] = [];
    for (const [k, v] of this.counters) lines.push(`${k} ${v}`);
    for (const [k, v] of this.gauges) lines.push(`${k} ${v}`);
    for (const [k, h] of this.histograms) {
      const brace = k.indexOf('{');
      const name = brace === -1 ? k : k.slice(0, brace);
      const labels = brace === -1 ? '' : k.slice(brace + 1, -1);
      const withLe = (le: string) => `${name}_bucket{${labels ? `${labels},` : ''}le="${le}"}`;
      LATENCY_BUCKETS_MS.forEach((le, i) => lines.push(`${withLe(String(le))} ${h.buckets[i]}`));
      lines.push(`${withLe('+Inf')} ${h.count}`);
      lines.push(`${name}_sum${labels ? `{${labels}}` : ''} ${h.sum}`);
      lines.push(`${name}_count${labels ? `{${labels}}` : ''} ${h.count}`);
    }
    return `${lines.join('\n')}\n`;
  }
}
