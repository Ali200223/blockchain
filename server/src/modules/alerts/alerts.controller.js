// server/src/modules/alerts/alerts.controller.js
const {
  recomputeAlertsForUser,
  listAlertsForUser,
  setAlertStatus,
  listAlertsAdmin,
} = require("./alerts.service");

async function recompute(req, res, next) {
  try {
    const userId = req.auth.userId;
    const windowHours = Number(req.body?.windowHours ?? 24);
    const result = await recomputeAlertsForUser(userId, { windowHours });
    res.json(result);
  } catch (e) {
    next(e);
  }
}

async function list(req, res, next) {
  try {
    const userId = req.auth.userId;
    const status = req.query?.status ?? "OPEN";
    const limit = req.query?.limit ?? 50;
    const result = await listAlertsForUser(userId, { status, limit });
    res.json(result);
  } catch (e) {
    next(e);
  }
}

async function listAdmin(req, res, next) {
  try {
    const status = req.query?.status ?? "OPEN";
    const limit = req.query?.limit ?? 200;
    const userId = req.query?.userId ?? null;
    const sinceHours = Number(req.query?.sinceHours ?? 24);

    const result = await listAlertsAdmin({ status, limit, userId, sinceHours });
    res.json(result);
  } catch (e) {
    next(e);
  }
}

async function patchStatus(req, res, next) {
  try {
    const userId = req.auth.userId;
    const alertId = req.params.id;
    const status = req.body?.status;
    const result = await setAlertStatus({ userId, alertId, status });
    res.json(result);
  } catch (e) {
    next(e);
  }
}

module.exports = { recompute, list, listAdmin, patchStatus };
