// scripts/delete-ml-signal.js
/* eslint-disable no-console */
const { MongoClient, ObjectId } = require("mongodb");

const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
const dbName = process.env.MONGODB_DB || process.env.MONGO_DB;

const id = process.argv.includes("--id") ? process.argv[process.argv.indexOf("--id") + 1] : null;
if (!uri) throw new Error("Missing MONGODB_URI (or MONGO_URI)");
if (!dbName) throw new Error("Missing MONGODB_DB (or MONGO_DB)");
if (!id) throw new Error("Missing --id <mongoObjectId>");

(async () => {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);

  const res = await db.collection("signals_ml").deleteOne({ _id: new ObjectId(id) });

  console.log(JSON.stringify({ ok: true, deletedCount: res.deletedCount, id }, null, 2));
  await client.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
