// scripts/seed-ml-signal.js
/* eslint-disable no-console */
const { MongoClient } = require("mongodb");
const crypto = require("crypto");

function arg(name, def = null) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return def;
  return process.argv[idx + 1] ?? def;
}

function nowIso() {
  return new Date().toISOString();
}

function hourFloorUtc(d) {
  const x = new Date(d);
  x.setUTCMinutes(0, 0, 0);
  return x;
}

(async () => {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  const dbName = process.env.MONGODB_DB || process.env.MONGO_DB;

  if (!uri) throw new Error("Missing MONGODB_URI (or MONGO_URI)");
  if (!dbName) throw new Error("Missing MONGODB_DB (or MONGO_DB)");

  const userId = arg("userId");
  if (!userId) throw new Error("Missing --userId");

  const symbol = (arg("symbol", "ETH") || "ETH").toUpperCase();
  const direction = (arg("direction", "BULLISH") || "BULLISH").toUpperCase();
  const severity = Number(arg("severity", "70"));
  const confidence = Number(arg("confidence", "0.7"));

  // Ensure createdAt is in the hour you want to test (same bucket)
  // If you pass --createdAt, we use it; otherwise current time.
  const createdAtRaw = arg("createdAt", nowIso());
  const createdAt = new Date(createdAtRaw);
  if (Number.isNaN(createdAt.getTime())) throw new Error("Invalid --createdAt ISO date");

  const doc = {
    userId,
    signalType: "PRICE_PREDICTION",
    createdAt,
    predictionId: arg("predictionId", crypto.randomUUID ? crypto.randomUUID() : String(Date.now())),
    requestId: arg("requestId", crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + 1)),
    model: { name: "simple_graph_baseline", version: "v2" },
    horizon: 7,
    interval: "1d",
    items: [
      {
        symbol,
        direction,
        severityScore100: severity,
        confidence,
        pUp: direction === "BULLISH" ? 0.85 : 0.15,
        expReturn: direction === "BULLISH" ? 0.05 : -0.05,
      },
    ],
  };

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);

  const res = await db.collection("signals_ml").insertOne(doc);

  const bucketHint = hourFloorUtc(createdAt).toISOString().slice(0, 13).replace("T", "T");
  console.log(
    JSON.stringify(
      {
        ok: true,
        insertedId: String(res.insertedId),
        userId,
        createdAt: createdAt.toISOString(),
        bucketHint: createdAt.toISOString().slice(0, 13).replace(":00", ""),
        dedupeKey: `ML:PRICE_PREDICTION:${symbol}:${direction}`,
        severity,
      },
      null,
      2
    )
  );

  await client.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
