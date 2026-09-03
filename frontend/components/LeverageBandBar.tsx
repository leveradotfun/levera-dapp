"use client";

import { useEffect, useState } from "react";
import { LeverageBand, fetchLeverageBand, pairLaunch } from "@/lib/leverage";
import { usd } from "@/lib/launchpad";
import { toastError, toastSuccess } from "@/lib/toast";
import { useWallet } from "@/lib/wallet";
import { useAppState } from "@/lib/appState";
import ConnectWalletButton from "@/components/ConnectWalletButton";

const STATUS_LABEL: Record<LeverageBand["status"], string> = {
  "in-band": "IN BAND",
  below: "BELOW BAND",
  above: "ABOVE BAND",
  unpaired: "UNLEVERED",
};

/// One coin's own leverage against the 1.5–2.5x band. HFyc is shared across every coin; this
/// number is not. Pairing takes idle HFyc cash equal to this pool's junior USD.
export default function LeverageBandBar({ launchAddress }: { launchAddress: string }) {
  const { addresses } = useAppState();
  const wallet = useWallet(addresses);
  const [band, setBand] = useState<LeverageBand | null>(null);
  const [pairing, setPairing] = useState(false);

  useEffect(() => {
    let stopped = false;
    const load = () => {
      fetchLeverageBand(launchAddress)
        .then((b) => {
          if (!stopped) setBand(b);
        })
        .catch(() => {});
    };
    load();
    const id = setInterval(load, 5000);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [launchAddress]);

  if (!band) return null;

  if (!band.paired) {
    if (!band.leverageEnabled) {
      return (
        <div className="rounded-xl border border-border bg-card p-4 space-y-2">
          <div className="flex items-baseline justify-between">
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-2xl font-semibold text-foreground">1.00x</span>
              <span className="text-xs text-muted">spot market</span>
            </div>
            <span className="text-xs font-semibold tracking-wide text-muted">NORMAL</span>
          </div>
          <p className="text-[11px] leading-relaxed text-muted">
            This coin was launched without 2x. It trades as a normal market after the curve and
            never pulls HFyc senior. Leverage is a creation-time choice and cannot be flipped later.
          </p>
        </div>
      );
    }
    const canPair = band.idleUsdg > 0n && band.juniorUsd > 0n;
    return (
      <div className="rounded-xl border border-border bg-card p-4 space-y-3">
        <div className="flex items-baseline justify-between">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-2xl font-semibold text-blue-400">1.00x</span>
            <span className="text-xs text-muted">waiting to pair</span>
          </div>
          <span className="text-xs font-semibold tracking-wide text-blue-400">{STATUS_LABEL.unpaired}</span>
        </div>
        <p className="text-[11px] leading-relaxed text-muted">
          2x is on, but HFyc senior is not attached yet. Pairing takes whatever idle exists, up
          to a full 2x ({usd(band.juniorUsd)} junior vs {usd(band.idleUsdg)} idle).
        </p>
        {!wallet.isConnected ? (
          <ConnectWalletButton label="Connect to pair" />
        ) : (
          <button
            type="button"
            disabled={pairing || !canPair}
            onClick={async () => {
              setPairing(true);
              try {
                await pairLaunch(launchAddress);
                toastSuccess("Paired at 2x.");
                setBand(await fetchLeverageBand(launchAddress));
              } catch (e) {
                toastError(e, "Pairing failed — idle cash or the swap router may be short.");
              } finally {
                setPairing(false);
              }
            }}
            className="w-full rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-accent-ink disabled:opacity-40"
          >
            {pairing ? "Pairing…" : canPair ? "Attach available HFyc (partial 2x ok)" : "Need idle HFyc to pair"}
          </button>
        )}
      </div>
    );
  }

  const span = band.high - band.low || band.target || 1;
  const min = Math.min(band.low - span * 0.5, band.achieved - span * 0.15);
  const max = Math.max(band.high + span * 0.5, band.achieved + span * 0.15);
  const pos = (v: number) => `${Math.min(100, Math.max(0, ((v - min) / (max - min)) * 100))}%`;
  const tone =
    band.status === "in-band" ? "text-green" : band.status === "below" ? "text-blue-400" : "text-yellow";

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-baseline justify-between">
        <div className="flex items-baseline gap-2">
          <span className={`font-mono text-2xl font-semibold ${tone}`}>
            {Number.isFinite(band.achieved) ? `${band.achieved.toFixed(2)}x` : "∞"}
          </span>
          <span className="text-xs text-muted">this coin&apos;s leverage</span>
        </div>
        <span className={`text-xs font-semibold tracking-wide ${tone}`}>{STATUS_LABEL[band.status]}</span>
      </div>

      <div className="relative mt-3 h-1.5 w-full rounded-full bg-surface">
        <div
          className="absolute inset-y-0 rounded-full bg-border"
          style={{ left: pos(band.low), right: `calc(100% - ${pos(band.high)})` }}
        />
        <div
          className={`absolute inset-y-0 left-0 rounded-full ${
            band.status === "in-band" ? "bg-green" : band.status === "below" ? "bg-blue-400" : "bg-yellow"
          }`}
          style={{ width: pos(Number.isFinite(band.achieved) ? band.achieved : max) }}
        />
        <div className="absolute inset-y-[-3px] w-px bg-muted/60" style={{ left: pos(band.low) }} />
        <div className="absolute inset-y-[-3px] w-px bg-muted/60" style={{ left: pos(band.high) }} />
      </div>

      <div className="mt-1.5 flex justify-between font-mono text-[11px] text-muted">
        <span>{band.low.toFixed(2)}x</span>
        <span className="text-secondary">target {band.target.toFixed(2)}x</span>
        <span>{band.high.toFixed(2)}x</span>
      </div>

      <p className="mt-2 text-[11px] leading-relaxed text-muted">
        Senior attached {usd(band.seniorUsd)} of {usd(band.juniorUsd)} (2x). This meme has paid{" "}
        {usd(band.occupancyPaidUsd)} occupancy rent and {usd(band.pairingFeesPaidUsd)} pairing
        fees to HFyc.
        {band.status === "in-band"
          ? " At target. Quiet coins can be peeled into louder ones when HFyc is scarce."
          : band.status === "below"
            ? " Under 2x — idle cash, then quieter coins' senior, will bump it toward target."
            : band.tripped
              ? " Outside the band — protect() (≥ 2.5x) sells vault collateral back into idle."
              : " Drifting from target, still inside the band."}
      </p>
    </div>
  );
}
