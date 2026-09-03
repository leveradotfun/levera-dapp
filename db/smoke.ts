import { ensureSchema, tableCounts, wipeDatabase } from "./migrate";
import {
  applyTrade,
  insertCollateralSamples,
  listCollateralSamples,
  insertPricePoints,
  listLedger,
  listNavSamples,
  listPricePoints,
  upsertNavSample,
  wipeFactory,
} from "./store";

async function main() {
  // The schema applies itself. A fresh clone or a dropped database has to be a non-event, not an
  // opaque 500 at the first write halfway through a session.
  await ensureSchema();

  const f = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const l = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  await wipeFactory(f);
  await upsertNavSample(f, { t: 1_000, nav: 1.01, occ: 1, cash: 2, liab: 3, util: 0.5, pending: 0 });
  const nav = await listNavSamples(f);
  if (nav.length !== 1 || nav[0].nav !== 1.01) throw new Error("nav " + JSON.stringify(nav));
  await insertPricePoints(l, f, [{ t: 2_000, price: 0.001 }]);
  const px = await listPricePoints(l);
  if (px.length !== 1) throw new Error("price " + JSON.stringify(px));
  const row = await applyTrade({
    factory: f,
    launch: l,
    trader: "0xcccccccccccccccccccccccccccccccccccccccc",
    side: "buy",
    usdWad: "100",
    tokenWad: "50",
    t: 3_000,
  });
  if (Number(row.spent) !== 100) throw new Error("ledger " + JSON.stringify(row));
  const rows = await listLedger(l);
  if (rows.length !== 1) throw new Error("rows");
  // Per-asset rows: the senior claim is one unit across collaterals, the risk machinery is not.
  await insertCollateralSamples(f, 1_700_000_000_000, [
    {
      token: "0xdddddddddddddddddddddddddddddddddddddddd",
      symbol: "WETH",
      priceUsd: 2400,
      oracleLive: true,
      pooled: 10,
      idle: 1,
      seniorUsd: 12_000,
      collateralCr: 2.4,
      headroomUsd: 5_000,
      capBps: 5_000,
      routingApr: 0,
      fundingApr: 0.1,
      enabled: true,
    },
    {
      // A dead feed on one asset is recorded as such rather than dropping the row: the gap is the
      // finding.
      token: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      symbol: "BTC",
      priceUsd: null,
      oracleLive: false,
      pooled: 0.5,
      idle: 0,
      seniorUsd: 15_000,
      collateralCr: null,
      headroomUsd: 0,
      capBps: 5_000,
      routingApr: 0.3,
      fundingApr: 0.4,
      enabled: true,
    },
  ]);
  const assets = await listCollateralSamples(f);
  if (assets.length !== 2) throw new Error("collateral " + assets.length);

  await wipeFactory(f);
  const nav2 = await listNavSamples(f);
  if (nav2.length !== 0) throw new Error("wipe failed");

  // And the clean slate a new deployment runs: every session table, identity counters reset.
  await wipeDatabase();
  const counts = await tableCounts();
  const left = Object.entries(counts).filter(([, n]) => n !== 0);
  if (left.length > 0) throw new Error("wipe left rows: " + JSON.stringify(left));

  console.log("store ok — schema, per-asset rows, factory wipe, clean slate");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
