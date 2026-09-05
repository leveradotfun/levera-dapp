import { ensureSchema, tableCounts, wipeDatabase } from "./migrate";
import {
  applyTrade,
  insertPricePoints,
  listLedger,
  listLycNavSamples,
  listPricePoints,
  upsertLycNavSample,
  wipeFactory,
} from "./store";

async function main() {
  // The schema applies itself. A fresh clone or a dropped database has to be a non-event, not an
  // opaque 500 at the first write halfway through a session.
  await ensureSchema();

  const f = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const l = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  await wipeFactory(f);
  await upsertLycNavSample(f, { t: 1_000, nav: 1.01, occ: 1, cash: 2, liab: 3, util: 0.5, pending: 0 });
  const nav = await listLycNavSamples(f);
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

  await wipeFactory(f);
  const nav2 = await listLycNavSamples(f);
  if (nav2.length !== 0) throw new Error("wipe failed");
  const left2 = await listPricePoints(l);
  if (left2.length !== 0) throw new Error("wipe failed");

  // And the clean slate a new deployment runs: every session table, identity counters reset.
  await wipeDatabase();
  const counts = await tableCounts();
  const left = Object.entries(counts).filter(([, n]) => n !== 0);
  if (left.length > 0) throw new Error("wipe left rows: " + JSON.stringify(left));

  console.log("store ok — schema, price points, ledger, factory wipe, clean slate");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
