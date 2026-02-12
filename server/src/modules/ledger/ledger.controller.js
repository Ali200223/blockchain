const validators = require("./ledger.validators");
const service = require("./ledger.service");

function requireAdmin(req) {
  if (!req.auth?.isAdmin) {
    const err = new Error("Forbidden");
    err.status = 403;
    throw err;
  }
}

function getIdempotencyKey(req, body) {
  return (
    (req.headers["idempotency-key"] || req.headers["x-idempotency-key"] || body?.idempotencyKey || "")
      .toString()
      .trim() || undefined
  );
}

function actorMeta(req) {
  return {
    requestId: req.ctx?.requestId,
    adminUserId: req.auth?.userId,
    ip: req.ip,
    userAgent: req.headers["user-agent"],
    deviceId: req.headers["x-device-id"],
  };
}

async function adminCommit(req, res, next) {
  try {
    requireAdmin(req);
    const body = validators.commitBodySchema.parse(req.body || {});
    const idempotencyKey = getIdempotencyKey(req, body);

    const out = await service.commitNextBlock({
      sealedByUserId: req.auth.userId,
      maxItems: body.maxItems ?? 500,
      idempotencyKey,
      meta: actorMeta(req),
    });

    res.json({ ok: true, ...out });
  } catch (e) {
    next(e);
  }
}

async function adminVerify(req, res, next) {
  try {
    requireAdmin(req);
    const q = validators.verifyQuerySchema.parse(req.query || {});
    const out = await service.verifyChain({ maxBlocks: q.maxBlocks ?? 2000 });
    res.json(out);
  } catch (e) {
    next(e);
  }
}

async function adminListBlocks(req, res, next) {
  try {
    requireAdmin(req);
    const q = validators.listBlocksQuerySchema.parse(req.query || {});
    const out = await service.listBlocks({ limit: q.limit ?? 50, offset: q.offset ?? 0 });
    res.json({ ok: true, ...out });
  } catch (e) {
    next(e);
  }
}

async function adminGetBlockByHeight(req, res, next) {
  try {
    requireAdmin(req);
    const p = validators.heightParamSchema.parse(req.params);
    const out = await service.getBlockByHeight(p.height, { includeItems: true });
    res.json({ ok: true, ...out });
  } catch (e) {
    next(e);
  }
}

async function adminListLocks(req, res, next) {
  try {
    requireAdmin(req);
    const out = await service.listLocks();
    res.json({ ok: true, ...out });
  } catch (e) {
    next(e);
  }
}

async function adminUnlock(req, res, next) {
  try {
    requireAdmin(req);
    const body = validators.unlockBodySchema.parse(req.body || {});
    const out = await service.adminUnlock(body);
    res.json({ ok: true, ...out });
  } catch (e) {
    next(e);
  }
}

async function adminFinalize(req, res, next) {
  try {
    requireAdmin(req);
    const p = validators.heightParamSchema.parse(req.params);
    const out = await service.finalizeBlock({
      height: p.height,
      finalizedByUserId: req.auth.userId,
      meta: actorMeta(req),
    });
    res.json({ ok: true, ...out });
  } catch (e) {
    next(e);
  }
}

async function adminListActions(req, res, next) {
  try {
    requireAdmin(req);
    const q = validators.listActionsQuerySchema.parse(req.query || {});
    const out = await service.listAdminActions({ limit: q.limit ?? 50, offset: q.offset ?? 0 });
    res.json({ ok: true, ...out });
  } catch (e) {
    next(e);
  }
}


// -------------------------
// Audit ledger (admin only)
// -------------------------

async function adminAuditCommit(req, res, next) {
  try {
    requireAdmin(req);
    const body = validators.commitBodySchema.parse(req.body || {});
    const idempotencyKey = getIdempotencyKey(req, body);

    const out = await service.commitNextAuditBlock({
      sealedByUserId: req.auth.userId,
      maxItems: body.maxItems ?? 500,
      idempotencyKey,
      meta: actorMeta(req),
    });

    res.json({ ok: true, ...out });
  } catch (e) {
    next(e);
  }
}

async function adminAuditVerify(req, res, next) {
  try {
    requireAdmin(req);
    const q = validators.verifyQuerySchema.parse(req.query || {});
    const out = await service.verifyAuditChain({ maxBlocks: q.maxBlocks ?? 2000 });
    res.json(out);
  } catch (e) {
    next(e);
  }
}

async function adminAuditListBlocks(req, res, next) {
  try {
    requireAdmin(req);
    const q = validators.listBlocksQuerySchema.parse(req.query || {});
    const out = await service.listAuditBlocks({ limit: q.limit ?? 50, offset: q.offset ?? 0 });
    res.json({ ok: true, ...out });
  } catch (e) {
    next(e);
  }
}

async function adminAuditGetBlockByHeight(req, res, next) {
  try {
    requireAdmin(req);
    const p = validators.heightParamSchema.parse(req.params);
    const out = await service.getAuditBlockByHeight(p.height, { includeItems: true });
    res.json({ ok: true, ...out });
  } catch (e) {
    next(e);
  }
}

async function adminAuditListLocks(req, res, next) {
  try {
    requireAdmin(req);
    const out = await service.listAuditLocks();
    res.json({ ok: true, ...out });
  } catch (e) {
    next(e);
  }
}

async function adminAuditUnlock(req, res, next) {
  try {
    requireAdmin(req);
    const body = validators.unlockBodySchema.parse(req.body || {});
    const out = await service.adminAuditUnlock(body);
    res.json({ ok: true, ...out });
  } catch (e) {
    next(e);
  }
}

async function adminAuditFinalize(req, res, next) {
  try {
    requireAdmin(req);
    const p = validators.heightParamSchema.parse(req.params);
    const out = await service.finalizeAuditBlock({
      height: p.height,
      finalizedByUserId: req.auth.userId,
      meta: actorMeta(req),
    });
    res.json({ ok: true, ...out });
  } catch (e) {
    next(e);
  }
}

async function adminAuditListActions(req, res, next) {
  try {
    requireAdmin(req);
    const q = validators.listActionsQuerySchema.parse(req.query || {});
    const out = await service.listAuditActions({ limit: q.limit ?? 50, offset: q.offset ?? 0 });
    res.json({ ok: true, ...out });
  } catch (e) {
    next(e);
  }
}

async function walletReceipt(req, res, next) {
  try {
    const p = validators.txIdParamSchema.parse(req.params);
    const out = await service.getWalletReceipt({
      txId: p.txId,
      requesterUserId: req.auth?.userId,
      requesterRole: req.auth?.role,
    });
    res.json({ ok: true, ...out });
  } catch (e) {
    next(e);
  }
}

async function securityReceipt(req, res, next) {
  try {
    const p = validators.logIdParamSchema.parse(req.params);
    const out = await service.getSecurityReceipt({
      logId: p.logId,
      requesterUserId: req.auth?.userId,
      requesterRole: req.auth?.role,
    });
    res.json({ ok: true, ...out });
  } catch (e) {
    next(e);
  }
}

async function tradeReceipt(req, res, next) {
  try {
    const p = validators.tradeIdParamSchema.parse(req.params);
    const out = await service.getTradeReceipt({
      tradeId: p.tradeId,
      requesterUserId: req.auth?.userId,
      requesterRole: req.auth?.role,
    });
    res.json({ ok: true, ...out });
  } catch (e) {
    next(e);
  }
}



module.exports = {
  // Settlement ledger
  adminCommit,
  adminVerify,
  adminListBlocks,
  adminGetBlockByHeight,
  adminListLocks,
  adminUnlock,
  adminFinalize,
  adminListActions,

  // Audit ledger
  adminAuditCommit,
  adminAuditVerify,
  adminAuditListBlocks,
  adminAuditGetBlockByHeight,
  adminAuditListLocks,
  adminAuditUnlock,
  adminAuditFinalize,
  adminAuditListActions,

  // Receipts
  walletReceipt,
  securityReceipt,
  tradeReceipt,
};
