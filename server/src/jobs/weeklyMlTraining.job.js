const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const { logger } = require("../config/logger");

// -------- paths (Person A repo layout) ----------
const serverRoot = path.resolve(__dirname, "..", ".."); // .../server
const mlRoot = path.resolve(serverRoot, "ml_service");  // .../server/ml_service

const exportSecurityScript = path.resolve(serverRoot, "scripts", "exportSecurityFeatures.js");

// outputs/artifacts (minimal: keep at ml_service root/models)
const securityJsonl = path.resolve(mlRoot, "security_features.jsonl");
const priceJsonl = path.resolve(mlRoot, "price_weights.jsonl");

const weightsOut = path.resolve(mlRoot, "models", "weights.json");
const securityModelOut = path.resolve(mlRoot, "models", "security_iforest.joblib");

// -------- helpers ----------
function fileExists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

function resolvePython() {
  if (process.env.ML_PYTHON_PATH) return process.env.ML_PYTHON_PATH;

  const isWin = process.platform === "win32";
  const venvPy = isWin
    ? path.resolve(mlRoot, ".venv", "Scripts", "python.exe")
    : path.resolve(mlRoot, ".venv", "bin", "python");

  return fileExists(venvPy) ? venvPy : "python";
}

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: "inherit",
      shell: false,
      ...opts,
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) return resolve();
      reject(new Error(`Command failed (${code}): ${cmd} ${args.join(" ")}`));
    });
  });
}

async function reloadMlService() {
  const baseUrl = (process.env.ML_SERVICE_URL || "http://127.0.0.1:8000").replace(/\/$/, "");
  const key = process.env.ML_SERVICE_API_KEY || "";

  if (!key) {
    logger.warn("ML_SERVICE_API_KEY missing; skipping ML reload");
    return { skipped: true };
  }

  const r = await fetch(`${baseUrl}/admin/reload`, {
    method: "POST",
    headers: { "x-service-key": key },
  });

  const body = await r.text();
  if (!r.ok) throw new Error(`ML reload failed: ${r.status} ${body}`);

  try {
    return JSON.parse(body);
  } catch {
    return { ok: true, raw: body };
  }
}

// -------- training steps ----------
async function trainSecurityAnomaly() {
  if (String(process.env.ML_WEEKLY_SECURITY_ENABLED || "true").toLowerCase() !== "true") {
    return { skipped: true };
  }

  // Export from MySQL using Person A script
  const days = process.env.ML_SECURITY_EXPORT_DAYS || "60";
  const limit = process.env.ML_SECURITY_EXPORT_LIMIT || "10000";
  const maxAnchors = process.env.ML_SECURITY_EXPORT_MAX_ANCHORS || "2000";

  logger.info({ out: securityJsonl, days, limit, maxAnchors }, "security_export_start");
  await runCmd(process.execPath, [
    exportSecurityScript,
    "--out", securityJsonl,
    "--days", String(days),
    "--limit", String(limit),
    "--maxAnchors", String(maxAnchors),
  ], { cwd: serverRoot });

  // Train IsolationForest in ml_service venv
  const py = resolvePython();
  logger.info({ py, in: securityJsonl, out: securityModelOut }, "security_train_start");
  await runCmd(py, [
  "train_security_anomaly.py",
  "--in", securityJsonl,
  "--out", securityModelOut,
  "--log1p",
  "--target-train", String(process.env.ML_SECURITY_TARGET_TRAIN || "1500"),
  "--min-real", String(process.env.ML_SECURITY_MIN_REAL || "50"),
], { cwd: mlRoot });


  logger.info({ out: securityModelOut }, "security_train_done");
  return { ok: true };
}

async function trainPriceWeights() {
  if (String(process.env.ML_WEEKLY_PRICE_ENABLED || "true").toLowerCase() !== "true") {
    return { skipped: true };
  }

  const py = resolvePython();

  // Rebuild dataset (calls Person C endpoints)
  const baseUrl = process.env.MARKET_DATA_SERVICE_URL || "http://127.0.0.1:4000";
  const symbols = process.env.ML_TRAIN_SYMBOLS || "BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT";
  const interval = process.env.ML_TRAIN_INTERVAL || "1h";
  const limit = process.env.ML_TRAIN_LIMIT || "2500";
  const lookback = process.env.ML_TRAIN_LOOKBACK || "480";
  const horizon = process.env.ML_TRAIN_HORIZON || "24";
  const apiKey = process.env.MARKET_DATA_SERVICE_API_KEY || ""; // optional

  logger.info({ baseUrl, symbols, interval, limit, lookback, horizon, out: priceJsonl }, "price_dataset_build_start");

  const buildArgs = [
    "build_price_dataset.py",
    "--base-url", baseUrl,
    "--symbols", symbols,
    "--interval", interval,
    "--limit", String(limit),
    "--lookback", String(lookback),
    "--horizon", String(horizon),
    "--out", priceJsonl,
  ];
  if (apiKey) buildArgs.push("--api-key", apiKey);

  await runCmd(py, buildArgs, { cwd: mlRoot });

  // Train ridge weights
  logger.info({ in: priceJsonl, out: weightsOut }, "price_train_start");
  await runCmd(py, [
    "train_price_weights.py",
    "--in", priceJsonl,
    "--out", weightsOut,
  ], { cwd: mlRoot });

  logger.info({ out: weightsOut }, "price_train_done");
  return { ok: true };
}

// -------- scheduler ----------
function computeNextWeeklyRun(dayOfWeek, hour, minute) {
  // dayOfWeek: 0=Sun .. 6=Sat
  const now = new Date();
  const next = new Date(now);

  next.setSeconds(0, 0);
  next.setHours(hour, minute, 0, 0);

  const deltaDays = (dayOfWeek - next.getDay() + 7) % 7;
  next.setDate(next.getDate() + deltaDays);

  // if scheduled time already passed this week, schedule for next week
  if (next <= now) next.setDate(next.getDate() + 7);

  return next;
}

let running = false;
let timer = null;

async function runWeeklyMlTrainingOnce() {
  if (running) {
    logger.warn("weekly_ml_training_already_running");
    return;
  }

  running = true;
  const startedAt = Date.now();

  try {
    logger.info("weekly_ml_training_run_start");

    // 1) security
    await trainSecurityAnomaly();

    // 2) price
    await trainPriceWeights();

    // 3) reload python service
    const reload = await reloadMlService();
    logger.info({ reload }, "weekly_ml_training_reload_done");

    logger.info({ ms: Date.now() - startedAt }, "weekly_ml_training_run_done");
  } catch (err) {
    logger.error({ err }, "weekly_ml_training_run_failed");
  } finally {
    running = false;
  }
}

function startWeeklyMlTrainingJob() {
  const enabled = String(process.env.ML_WEEKLY_TRAIN_ENABLED || "true").toLowerCase() === "true";
  if (!enabled) {
    logger.info("weekly_ml_training_job_disabled");
    return;
  }

  // Defaults: Monday 03:10 local server time
  const day = Number(process.env.ML_WEEKLY_DAY ?? 1);      // 1 = Monday
  const hour = Number(process.env.ML_WEEKLY_HOUR ?? 3);
  const minute = Number(process.env.ML_WEEKLY_MINUTE ?? 10);

  const scheduleNext = () => {
    const next = computeNextWeeklyRun(day, hour, minute);
    const delay = Math.max(1000, next.getTime() - Date.now());

    logger.info({ next: next.toISOString(), delayMs: delay }, "weekly_ml_training_job_scheduled");

    timer = setTimeout(async () => {
      await runWeeklyMlTrainingOnce();
      scheduleNext();
    }, delay);
  };

  // optional: run once immediately for testing
  const runOnBoot = String(process.env.ML_WEEKLY_RUN_ON_BOOT || "false").toLowerCase() === "true";
  if (runOnBoot) {
    runWeeklyMlTrainingOnce().finally(scheduleNext);
  } else {
    scheduleNext();
  }
}

module.exports = { startWeeklyMlTrainingJob, runWeeklyMlTrainingOnce };
