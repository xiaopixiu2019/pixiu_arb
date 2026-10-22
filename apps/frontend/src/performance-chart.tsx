import { useEffect, useRef, useState } from 'react';
import { AreaSeries, LineSeries, LineStyle, TickMarkType, ColorType, createChart, type Time } from 'lightweight-charts';
import type { AccountPerformance } from '@gate-crossex/shared-types';
import { performanceSegments, performanceTimeLabel } from './performance-chart-data.js';
import { FieldHelp } from './field-help.js';

type Point = AccountPerformance['points'][number];
export function PerformanceChart({ points, language, theme }: { points: Point[]; language: string; theme: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [assetsVisible, setAssetsVisible] = useState(true), [returnsVisible, setReturnsVisible] = useState(true);
  const [hover, setHover] = useState<Point | null>(null);
  const zh = language === 'zh';
  useEffect(() => {
    if (!host.current) return;
    const light = theme === 'light';
    const chart = createChart(host.current, { autoSize: true, height: 210,
      layout: { background: { type: ColorType.Solid, color: light ? '#ffffff' : '#0b1118' }, textColor: light ? '#4b6072' : '#92a4b5', attributionLogo: false },
      grid: { vertLines: { color: light ? '#e0e6ea' : '#20303b' }, horzLines: { color: light ? '#e0e6ea' : '#20303b' } },
      leftPriceScale: { visible: true, borderColor: '#304453' }, rightPriceScale: { visible: true, borderColor: '#304453' },
      timeScale: { timeVisible: true, borderColor: '#304453', tickMarkFormatter: (time: Time, type: TickMarkType) => performanceTimeLabel(Number(time) * 1000, language, type >= TickMarkType.Time) },
      localization: { locale: zh ? 'zh-CN' : 'en-US', timeFormatter: (time: number) => new Date(time * 1000).toLocaleString(zh ? 'zh-CN' : 'en-US', { timeZone: 'Asia/Shanghai' }) },
    });
    for (const key of ['equity', 'returnPct'] as const) {
      const segments = performanceSegments(points, key);
      for (const [index, segment] of segments.entries()) {
        const shared = { lineWidth: 2 as const, lastValueVisible: index === segments.length - 1, priceLineVisible: false,
          lineVisible: segment.length > 1, pointMarkersVisible: segment.length === 1, pointMarkersRadius: 2 };
        if (key === 'equity') chart.addSeries(AreaSeries, { ...shared, priceScaleId: 'left', lineColor: light ? '#2179a3' : '#00c9a7',
          topColor: '#00c9a725', bottomColor: '#00c9a703', visible: assetsVisible,
          priceFormat: { type: 'custom', minMove: .01, formatter: (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: 2 }) } }).setData(segment);
        else chart.addSeries(LineSeries, { ...shared, priceScaleId: 'right', color: light ? '#007b63' : '#9582d6', lineStyle: LineStyle.Dashed, visible: returnsVisible,
          priceFormat: { type: 'custom', minMove: .01, formatter: (v: number) => `${v.toFixed(2)}%` } }).setData(segment);
      }
    }
    const unique = new Map(points.map((p) => [Math.floor(p.at / 1000), p]));
    chart.timeScale().fitContent();
    chart.subscribeCrosshairMove((param) => setHover(param.time === undefined ? null : unique.get(Number(param.time)) ?? null));
    return () => chart.remove();
  }, [points, zh, assetsVisible, returnsVisible, theme, language]);
  return <div className="performance-chart">
    <div className="performance-legend"><button type="button" aria-pressed={assetsVisible} onClick={() => setAssetsVisible(!assetsVisible)} className="asset-legend">{zh ? '总资产 · 左轴 USDT' : 'Net assets · left axis USDT'}</button>
      <button type="button" aria-pressed={returnsVisible} onClick={() => setReturnsVisible(!returnsVisible)} className="return-legend">{zh ? '累计收益率 · 右轴 %' : 'Cumulative return · right axis %'}</button>
      <FieldHelp label={zh ? '双轴图说明' : 'Chart axes'}>{zh ? '同一时间轴、不同纵轴。累计收益率按统计起点计算；当前资金费率年化不在此图。缺失时段保留断点。' : 'One time axis, independent value axes. Returns retain the original baseline; current funding APR is not plotted. Missing periods remain gaps.'}</FieldHelp>
    </div>
    <div ref={host} role="img" aria-label={zh ? '总资产与累计收益率双轴图' : 'Net assets and cumulative return chart'} />
    {points.length < 2 && <div className="performance-chart-empty">{zh ? '等待更多可信历史快照，曲线将从统计启用时开始积累。' : 'Waiting for more verified snapshots. History begins when statistics are enabled.'}</div>}
    {hover && <div className="performance-chart-tooltip"><time>{new Date(hover.at).toLocaleString(zh ? 'zh-CN' : 'en-US', { timeZone: 'Asia/Shanghai' })}</time>
      <span>{zh ? '总资产' : 'Net assets'} <b>{hover.equity === null ? '—' : `${Number(hover.equity).toLocaleString('en-US', { maximumFractionDigits: 2 })} USDT`}</b></span>
      <span>{zh ? '累计收益率' : 'Cumulative return'} <b>{hover.returnPct === null ? '—' : `${Number(hover.returnPct).toFixed(2)}%`}</b></span></div>}
  </div>;
}
