"use client";

import { DailyStat } from "@/lib/analytics";

interface DailyBarChartProps {
  data: DailyStat[];
  title: string;
  subtitle?: string;
  totalLabel?: string;
  totalValue?: string;
  color?: string;
  /// How to render values in the hover tooltip. Defaults to usd for the volume charts; the
  /// launches/traders charts pass "count" so a day with 3 launches doesn't read as "$3".
  valueFormat?: "usd" | "count";
}

function formatValue(n: number, format: "usd" | "count" = "usd"): string {
  if (format === "count") return n.toLocaleString();
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  if (n === 0) return "$0";
  return `$${n.toFixed(0)}`;
}

function formatCount(n: number): string {
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  if (n === 0) return "0";
  return n.toLocaleString();
}

export default function DailyBarChart({
  data,
  title,
  subtitle,
  totalLabel,
  totalValue,
  color = "#ECE3D1",
  valueFormat = "usd",
}: DailyBarChartProps) {
  if (data.length === 0) return null;

  const values = data.map((d) => d.value);
  const max = Math.max(...values, 1);
  const total = values.reduce((sum, v) => sum + v, 0);

  // Pick label positions: first, middle, last
  const labelIndices = new Set<number>();
  labelIndices.add(0);
  labelIndices.add(Math.floor(data.length / 2));
  labelIndices.add(data.length - 1);

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-start justify-between mb-4">
        <div>
          <div className="text-lg font-semibold text-foreground">{title}</div>
          {subtitle && (
            <div className="text-sm text-muted mt-0.5">{subtitle}</div>
          )}
        </div>
        {totalValue && (
          <div className="text-right">
            <div className="text-2xl font-bold text-foreground">{totalValue}</div>
          </div>
        )}
      </div>

      <div className="flex items-end gap-[3px] h-32">
        {data.map((d, i) => {
          const height = max > 0 ? (d.value / max) * 100 : 0;
          const isLast = i === data.length - 1;
          return (
            <div
              key={i}
              className="flex-1 flex flex-col items-center justify-end h-full"
              title={`${d.date}: ${formatValue(d.value, valueFormat)}`}
            >
              <div
                className="w-full rounded-t-sm transition-all duration-300"
                style={{
                  height: `${Math.max(height, 2)}%`,
                  backgroundColor: isLast ? color : `${color}99`,
                }}
              />
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between mt-2 text-[10px] text-muted">
        {data.map((d, i) =>
          labelIndices.has(i) ? (
            <span key={i}>{d.date}</span>
          ) : null
        )}
      </div>
    </div>
  );
}
