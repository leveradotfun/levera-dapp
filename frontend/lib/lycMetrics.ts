"use client";

import { useEffect, useMemo, useState } from "react";
import { DeployedAddresses } from "./chain";
import { LycGlobal, fetchLycGlobal } from "./lyc";
import { allFactories, fetchLaunchAddresses, getLaunch, getProvider } from "./launchpad";
import { apiGet, apiPost } from "./remote";

/// NAV ring in Postgres, keyed by factory so a wipe/redeploy starts a new series.
/// 5-min buckets, 8 days.

const BUCKET_MS = 5 * 60_000;
const RETAIN_MS = 8 * 24 * 60 * 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

export type NavSample = {
  t: number;
  nav: number;
  occ: number;
  cash: number;
  liab: number;
  util: number;
  pending: number;
};

export type TrailingApy = {
  window: "24h" | "7d";
  ready: boolean;
  haveHours: number;
  needHours: number;
  nav0: number;
  nav1: number;
  ret: number;
  simpleApr: number | null;
  occDelta: number;
  cashDelta: number;
};

export type Durability = {
  launches: number;
  graduated: number;
  paired: number;
  inBand: number;
  stretched: number;
  slack: number;
  unharvestedEth: number;
  occupancyPendingUsd: number;
  occupancySettledUsd: number;
  cashYieldUsd: number;
  globalCr: number;
  utilization: number;
  fundingApr: number;
  nav: number;
};

function sampleFromGlobal(g: LycGlobal): NavSample {
  const t = Date.now();
  return {
    t: Math.floor(t / BUCKET_MS) * BUCKET_MS,
    nav: Number(g.nav) / 1e18,
    occ: Number(g.occupancyUsd) / 1e18,
    cash: Number(g.cashYieldUsd) / 1e18,
    liab: Number(g.liability) / 1e18,
    util: Number(g.utilization) / 1e18,
    pending: Number(g.occupancyPendingUsd) / 1e18,
  };
}

export async function recordLycSample(factory: string, g: LycGlobal) {
  await apiPost("/api/lyc-nav", { factory, sample: sampleFromGlobal(g) });
}

export async function loadLycSamples(factory: string): Promise<NavSample[]> {
  const r = await apiGet<{ samples: NavSample[] }>(`/api/lyc-nav?factory=${encodeURIComponent(factory)}`);
  return r?.samples ?? [];
}

function migrateLegacyNav(factory: string) {
  if (typeof window === "undefined") return;
  try {
    const key = `lyc-nav:${factory.toLowerCase()}`;
    const raw = window.localStorage.getItem(key);
    if (!raw) return;
    const samples = JSON.parse(raw) as NavSample[];
    if (Array.isArray(samples) && samples.length > 0) {
      void apiPost("/api/lyc-nav", { factory, samples });
    }
    window.localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

function trailing(samples: NavSample[], windowMs: number, label: "24h" | "7d"): TrailingApy {
  const needHours = windowMs / HOUR;
  const empty: TrailingApy = {
    window: label,
    ready: false,
    haveHours: 0,
    needHours,
    nav0: 1,
    nav1: 1,
    ret: 0,
    simpleApr: null,
    occDelta: 0,
    cashDelta: 0,
  };
  if (samples.length < 2) return empty;
  const end = samples[samples.length - 1];
  const startBound = end.t - windowMs;
  const window = samples.filter((p) => p.t >= startBound);
  if (window.length < 2) {
    const have = (end.t - samples[0].t) / HOUR;
    return { ...empty, haveHours: have };
  }
  const first = window[0];
  const last = window[window.length - 1];
  const haveHours = (last.t - first.t) / HOUR;
  const nav0 = first.nav > 0 ? first.nav : 1;
  const nav1 = last.nav > 0 ? last.nav : nav0;
  const ret = nav1 / nav0 - 1;
  const years = haveHours / (365.25 * 24);
  const simpleApr = years > 0 ? ret / years : null;
  // Ready only when we actually covered ~90% of the window. Do not annualize 4 hours as "24h APY".
  const ready = haveHours >= needHours * 0.9;
  return {
    window: label,
    ready,
    haveHours,
    needHours,
    nav0,
    nav1,
    ret,
    simpleApr: ready ? simpleApr : null,
    occDelta: last.occ - first.occ,
    cashDelta: last.cash - first.cash,
  };
}

export function computeTrailingApy(samples: NavSample[]): { h24: TrailingApy; d7: TrailingApy } {
  return { h24: trailing(samples, DAY, "24h"), d7: trailing(samples, WEEK, "7d") };
}

const UPPER = 2.5;
const LOWER = 1.5;

export async function fetchDurability(addresses: DeployedAddresses, g: LycGlobal): Promise<Durability> {
  const addrs = (await Promise.all(allFactories(addresses).map((f) => fetchLaunchAddresses(f)))).flat();
  const provider = getProvider();
  let graduated = 0;
  let paired = 0;
  let inBand = 0;
  let stretched = 0;
  let slack = 0;
  let unharvested = 0n;
  await Promise.all(
    addrs.map(async (a) => {
      const l = getLaunch(a, provider);
      try {
        // Renamed from *FeeEth to *FeeQuote when multi-collateral landed. holderFeeQuote is
        // LYC's own leverage-scaled trading-fee slice -- real again as of the 50/45/5 redesign,
        // and part of what's "unharvested" from LYC's own perspective too.
        const [grad, isPaired, lev, holder, proto] = (await Promise.all([
          l.graduated(),
          l.paired(),
          l.leverageWad(),
          l.holderFeeQuote(),
          l.protocolFeeQuote(),
        ])) as [boolean, boolean, bigint, bigint, bigint];
        unharvested += holder + proto;
        if (grad) graduated++;
        if (isPaired) {
          paired++;
          const x = Number(lev) / 1e18;
          if (x >= UPPER) stretched++;
          else if (x > 0 && x <= LOWER) slack++;
          else inBand++;
        }
      } catch {
        // skip a broken clone
      }
    }),
  );
  return {
    launches: addrs.length,
    graduated,
    paired,
    inBand,
    stretched,
    slack,
    unharvestedEth: Number(unharvested) / 1e18,
    occupancyPendingUsd: Number(g.occupancyPendingUsd) / 1e18,
    occupancySettledUsd: Number(g.occupancyUsd) / 1e18,
    cashYieldUsd: Number(g.cashYieldUsd) / 1e18,
    globalCr: Number(g.globalCr) / 1e18,
    utilization: Number(g.utilization) / 1e18,
    fundingApr: Number(g.fundingRate) / 1e18,
    nav: Number(g.nav) / 1e18,
  };
}

export function formatApr(x: number | null): string {
  if (x === null || !Number.isFinite(x)) return "—";
  const pct = x * 100;
  if (Math.abs(pct) >= 1000) return `${pct.toFixed(0)}%`;
  return `${pct.toFixed(2)}%`;
}

export function formatPct(x: number): string {
  return `${(x * 100).toFixed(2)}%`;
}

/// Records a NAV sample whenever LYC is loaded. Survives reloads; resets on new factory.
export function useLycMetrics(addresses: DeployedAddresses | null) {
  const [g, setG] = useState<LycGlobal | null>(null);
  const [dur, setDur] = useState<Durability | null>(null);
  const [samples, setSamples] = useState<NavSample[]>([]);

  useEffect(() => {
    if (!addresses) return;
    let stopped = false;

    migrateLegacyNav(addresses.factory);

    async function tick() {
      if (stopped || !addresses) return;
      try {
        const gg = await fetchLycGlobal(addresses);
        const sample = sampleFromGlobal(gg);
        await recordLycSample(addresses.factory, gg);
        const d = await fetchDurability(addresses, gg);
        const fromDb = await loadLycSamples(addresses.factory);
        if (stopped) return;
        setG(gg);
        setDur(d);
        const cutoff = Date.now() - RETAIN_MS;
        const kept = fromDb.filter((p) => p.t >= cutoff && p.t !== sample.t);
        kept.push(sample);
        kept.sort((a, b) => a.t - b.t);
        setSamples(kept);
      } catch {
        // anvil / stale
      }
    }

    void tick();
    const id = setInterval(tick, 30_000);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [addresses?.factory, addresses?.lyc]);

  const apy = useMemo(() => computeTrailingApy(samples), [samples]);

  return { g, dur, samples, apy };
}
