"use client";

import { useXHandles } from "@/lib/xHandles";
import TraderIdentity from "./TraderIdentity";

interface Holder {
  address: string;
  balance: number;
  pct: number;
  pnl: number;
}

interface HoldersTableProps {
  holders: Holder[];
}

export default function HoldersTable({ holders }: HoldersTableProps) {
  const xHandles = useXHandles();
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-muted text-xs uppercase border-b border-border">
            <th className="text-left py-2 px-3 font-medium">Address</th>
            <th className="text-right py-2 px-3 font-medium">Balance</th>
            <th className="text-right py-2 px-3 font-medium">Value</th>
            <th className="text-right py-2 px-3 font-medium">PnL</th>
          </tr>
        </thead>
        <tbody>
          {holders.map((h, i) => (
            <tr key={h.address} className="border-b border-border/50 hover:bg-card transition-colors">
              <td className="py-2.5 px-3 text-xs">
                <TraderIdentity
                  address={h.address}
                  identity={xHandles.get(h.address.toLowerCase())}
                  linkHandle
                />
              </td>
              <td className="text-right py-2.5 px-3 text-foreground">
                {h.balance.toLocaleString("en-US", { maximumFractionDigits: 2 })}
              </td>
              <td className="text-right py-2.5 px-3 text-foreground">
                {h.pct.toFixed(2)}%
              </td>
              <td className={`text-right py-2.5 px-3 font-medium ${h.pnl >= 0 ? "text-green" : "text-red"}`}>
                {h.pnl >= 0 ? "+" : ""}{h.pnl.toFixed(1)}%
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
