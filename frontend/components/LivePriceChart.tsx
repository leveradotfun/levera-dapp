"use client";

import { useEffect, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { PricePoint } from "@/lib/priceHistory";
import {
  CHART_INTERVALS,
  type ChartIntervalId,
  candlesFromPoints,
  formatChartPrice,
} from "@/lib/ohlc";

const UP = "#22c55e";
const DOWN = "#ef4444";
const BG = "#141414";
const GRID = "#252525";
const TEXT = "#71717a";

export default function LivePriceChart({
  points,
}: {
  points: PricePoint[];
  color?: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const [intervalId, setIntervalId] = useState<ChartIntervalId>("15s");

  const intervalMs = CHART_INTERVALS.find((i) => i.id === intervalId)?.ms ?? 15_000;
  const fittedRef = useRef(false);
  /// The last dataset pushed into the series, per interval. The point stream emits every 400ms,
  /// which used to trigger a full `setData` rebuild of every candle each time; when only the tail
  /// has moved, `series.update()` on the last bar is all the chart needs.
  const dataRef = useRef<{ intervalMs: number; lastTime: number; count: number } | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;

    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: BG },
        textColor: TEXT,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: GRID },
        horzLines: { color: GRID },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "#3f3f46", labelBackgroundColor: "#1e1e1e" },
        horzLine: { color: "#3f3f46", labelBackgroundColor: "#1e1e1e" },
      },
      rightPriceScale: {
        borderColor: GRID,
        scaleMargins: { top: 0.15, bottom: 0.15 },
        entireTextOnly: false,
        visible: true,
      },
      timeScale: {
        borderColor: GRID,
        timeVisible: true,
        secondsVisible: intervalMs < 60_000,
      },
      localization: {
        priceFormatter: formatChartPrice,
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      borderUpColor: UP,
      borderDownColor: DOWN,
      wickUpColor: UP,
      wickDownColor: DOWN,
      priceLineVisible: true,
      lastValueVisible: true,
      priceLineStyle: LineStyle.Dashed,
      priceFormat: {
        type: "custom",
        minMove: 1e-12,
        formatter: formatChartPrice,
      },
    });

    chartRef.current = chart;
    seriesRef.current = series;
    fittedRef.current = false;
    dataRef.current = null;

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, [intervalMs]);

  useEffect(() => {
    const series = seriesRef.current;
    const chart = chartRef.current;
    if (!series || !chart) return;
    const candles = candlesFromPoints(points, intervalMs);
    if (candles.length === 0) {
      series.setData([]);
      dataRef.current = null;
      return;
    }
    const last = candles[candles.length - 1];
    const prev = dataRef.current;
    // Same interval and the tail bar is the same bucket (or a later one): update just that bar.
    // Anything else -- first load, interval switch, a reseed from the chain log -- needs setData.
    if (prev && prev.intervalMs === intervalMs && last.time >= prev.lastTime) {
      series.update({
        time: last.time as UTCTimestamp,
        open: last.open,
        high: last.high,
        low: last.low,
        close: last.close,
      });
      dataRef.current = { intervalMs, lastTime: last.time, count: candles.length };
      return;
    }
    series.setData(
      candles.map((c) => ({
        time: c.time as UTCTimestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    );
    dataRef.current = { intervalMs, lastTime: last.time, count: candles.length };
    if (!fittedRef.current) {
      // Don't fit the entire history — early 1s spikes to $0.01 would compress
      // the current $0.00128 action at the bottom. Show the last ~80 bars
      // (like TradingView) so recent price action fills the viewport.
      if (candles.length > 80) {
        const from = candles[candles.length - 80].time as UTCTimestamp;
        const to = candles[candles.length - 1].time as UTCTimestamp;
        chart.timeScale().setVisibleRange({ from, to });
      } else {
        chart.timeScale().fitContent();
      }
      fittedRef.current = true;
    }
  }, [points, intervalMs]);

  // The chart container must stay mounted even with no data. Returning an early placeholder
  // instead meant createChart ran once with a null node and the chart never existed by the time
  // the first points arrived -- the "empty chart forever" bug.
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wide text-muted">TradingView</span>
        <div className="flex rounded-lg border border-border p-0.5">
          {CHART_INTERVALS.map((i) => (
            <button
              key={i.id}
              type="button"
              onClick={() => setIntervalId(i.id)}
              className={`rounded-md px-2 py-1 text-[11px] font-medium tabular-nums transition-colors ${
                intervalId === i.id ? "bg-accent text-accent-ink" : "text-muted hover:text-foreground"
              }`}
            >
              {i.label}
            </button>
          ))}
        </div>
      </div>
      <div className="relative">
        <div ref={wrapRef} className="h-[380px] w-full" />
        {points.length < 1 && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-muted">
            No price history yet — the chart fills in from the coin&apos;s on-chain trades.
          </div>
        )}
      </div>
    </div>
  );
}
