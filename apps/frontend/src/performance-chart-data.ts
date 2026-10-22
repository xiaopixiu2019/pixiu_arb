import type { AccountPerformance } from '@gate-crossex/shared-types';
import type { UTCTimestamp } from 'lightweight-charts';
type Point = AccountPerformance['points'][number];
export function performanceSegments(points: Point[], key: 'equity' | 'returnPct') {
  const groups: Array<Array<{ time: UTCTimestamp; value: number }>> = [];
  let segment: Array<{ time: UTCTimestamp; value: number }> = [];
  const unique = [...new Map(points.map((p) => [Math.floor(p.at / 1000), p])).entries()].sort(([a], [b]) => a - b);
  for (const [time, point] of unique) {
    if (point[key] === null || !Number.isFinite(Number(point[key]))) {
      if (segment.length) groups.push(segment); segment = [];
    } else segment.push({ time: time as UTCTimestamp, value: Number(point[key]) });
  }
  if (segment.length) groups.push(segment);
  return groups;
}

export function performanceTimeLabel(at: number, language: string, timeOnly: boolean): string {
  return new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-GB', { timeZone: 'Asia/Shanghai',
    ...(timeOnly ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } as const : { month: '2-digit', day: '2-digit' } as const) }).format(at);
}
