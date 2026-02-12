// scripts/setupMongoIndexes.js
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") }); // <- server/.env

const { MongoClient } = require("mongodb");

const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = process.env.MONGO_DB || "test";

async function ensureIndex(col, spec, opts) {
  const existing = await col.indexes();
  const same = existing.some((ix) => {
    const sameKey = JSON.stringify(ix.key) === JSON.stringify(spec);
    const sameUnique = (ix.unique || false) === (opts.unique || false);
    const sameTTL =
      (ix.expireAfterSeconds ?? null) === (opts.expireAfterSeconds ?? null);
    return sameKey && sameUnique && sameTTL;
  });

  if (!same) {
    await col.createIndex(spec, opts);
  }
}

(async () => {
  if (!MONGO_URI) throw new Error("MONGO_URI is required");

  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(DB_NAME);

  const ttl30d = 30 * 24 * 60 * 60;

  await ensureIndex(db.collection("signals_security"), { createdAt: 1 }, { expireAfterSeconds: ttl30d });
  await ensureIndex(db.collection("signals_ml"), { createdAt: 1 }, { expireAfterSeconds: ttl30d });

  await ensureIndex(
    db.collection("alerts"),
    { userId: 1, bucket: 1, dedupeKey: 1 },
    { unique: true }
  );

  await ensureIndex(
    db.collection("alerts"),
    { userId: 1, status: 1, score: -1, createdAt: -1 },
    {}
  );

  console.log("Indexes ensured.");
  await client.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
