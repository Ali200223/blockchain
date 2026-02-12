const walletService = require("./wallet.service");
const { adminAdjustSchema, listTxQuerySchema, depositSchema, withdrawSchema, bankSchema } = require("./wallet.validators");
const ledgerService = require("../ledger/ledger.service");

function validationResponse(req, res, zodError) {
  return res.status(400).json({
    ok: false,
    error: "Validation error",
    requestId: req.ctx?.requestId,
    details: zodError.issues || zodError.errors,
  });
}

function buildMeta(req) {
  return {
    requestId: req.ctx?.requestId,
    actorUserId: req.auth?.userId,
    actorRole: req.auth?.role,
    ip: req.ctx?.ip || req.ip,
    userAgent: req.headers["user-agent"],
    deviceId: req.ctx?.deviceId || req.headers["x-device-id"],
  };
}

async function me(req, res, next) {
  try {
    const w = await walletService.getWallet(req.auth.userId);
    if (!w) return res.status(404).json({ ok: false, error: "Wallet not found", requestId: req.ctx?.requestId });
    return res.json({ ok: true, wallet: w });
  } catch (e) {
    return next(e);
  }
}

async function balance(req, res, next) {
  try {
    const w = await walletService.getWallet(req.auth.userId);
    if (!w) return res.status(404).json({ ok: false, error: "Wallet not found", requestId: req.ctx?.requestId });
    return res.json({ ok: true, balance: w.balance, currency: w.currency, status: w.status });
  } catch (e) {
    return next(e);
  }
}

async function myTransactions(req, res, next) {
  try {
    const parsed = listTxQuerySchema.safeParse(req.query);
    if (!parsed.success) return validationResponse(req, res, parsed.error);

    const out = await walletService.listMyTransactions(req.auth.userId, parsed.data.limit);
    return res.json({ ok: true, ...out });
  } catch (e) {
    return next(e);
  }
}

async function deposit(req, res, next) {
  try {
    const parsed = depositSchema.safeParse(req.body);
    if (!parsed.success) return validationResponse(req, res, parsed.error);

    const body = parsed.data;

    const out = await walletService.depositAtomic({
      userId: req.auth.userId,
      amount: body.amount,
      source: body.source || "Unknown",
      referenceId: body.referenceId || null,
      meta: buildMeta(req),
    });

    // Best-effort mine for instant receipt UX (autocommit job also covers it)
    let ledgerCommit = null;
    try {
      ledgerCommit = await ledgerService.commitNextBlock({
        sealedByUserId: req.auth.userId,
        maxItems: 50,
        idempotencyKey: `auto:${req.ctx?.requestId || body.referenceId || Date.now()}`,
        meta: buildMeta(req),
      });
    } catch (e) {
      ledgerCommit = { committed: false, reason: e.message, status: e.status || 500 };
    }

    return res.json({ ok: true, ...out, ledgerCommit });
  } catch (e) {
    if (e && e.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ ok: false, error: "Duplicate referenceId/requestId", requestId: req.ctx?.requestId });
    }
    return next(e);
  }
}

async function withdraw(req, res, next) {
  try {
    const parsed = withdrawSchema.safeParse(req.body);
    if (!parsed.success) return validationResponse(req, res, parsed.error);

    const body = parsed.data;

    const out = await walletService.withdrawAtomic({
      userId: req.auth.userId,
      amount: body.amount,
      referenceId: body.referenceId || null,
      meta: buildMeta(req),
    });

    let ledgerCommit = null;
    try {
      ledgerCommit = await ledgerService.commitNextBlock({
        sealedByUserId: req.auth.userId,
        maxItems: 50,
        idempotencyKey: `auto:${req.ctx?.requestId || body.referenceId || Date.now()}`,
        meta: buildMeta(req),
      });
    } catch (e) {
      ledgerCommit = { committed: false, reason: e.message, status: e.status || 500 };
    }

    return res.json({ ok: true, ...out, ledgerCommit });
  } catch (e) {
    if (e && e.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ ok: false, error: "Duplicate referenceId/requestId", requestId: req.ctx?.requestId });
    }
    return next(e);
  }
}

async function getBank(req, res, next) {
  try {
    const bank = await walletService.getWithdrawalAccount(req.auth.userId);
    return res.json({ ok: true, bank: bank || null });
  } catch (e) {
    return next(e);
  }
}

async function saveBank(req, res, next) {
  try {
    const parsed = bankSchema.safeParse(req.body);
    if (!parsed.success) return validationResponse(req, res, parsed.error);

    const body = parsed.data;

    const bank = await walletService.upsertWithdrawalAccount({
      userId: req.auth.userId,
      bankName: body.bankName,
      accountNumber: body.accountNumber,
      iban: body.iban || null,
      bic: body.bic || null,
      ifscCode: body.ifscCode || null,
    });

    return res.json({ ok: true, bank });
  } catch (e) {
    return next(e);
  }
}

async function adminAdjust(req, res, next) {
  try {
    if (!req.auth.isAdmin) {
      return res.status(403).json({ ok: false, error: "Forbidden", requestId: req.ctx?.requestId });
    }

    const parsed = adminAdjustSchema.safeParse(req.body);
    if (!parsed.success) return validationResponse(req, res, parsed.error);

    const body = parsed.data;

    const out = await walletService.adjustWalletAtomic({
      userId: body.userId,
      type: body.type,
      amount: body.amount,
      description: body.description,
      referenceId: body.referenceId,
      meta: {
        ...buildMeta(req),
        actorRole: "admin",
      },
    });

    let ledgerCommit = null;
    try {
      ledgerCommit = await ledgerService.commitNextBlock({
        sealedByUserId: req.auth.userId,
        maxItems: 50,
        idempotencyKey: `auto:${req.ctx?.requestId || body.referenceId || Date.now()}`,
        meta: {
          requestId: req.ctx?.requestId,
          adminUserId: req.auth?.userId,
          ip: req.ip,
          userAgent: req.headers["user-agent"],
          deviceId: req.headers["x-device-id"],
        },
      });
    } catch (e) {
      ledgerCommit = { committed: false, reason: e.message, status: e.status || 500 };
    }

    return res.json({ ok: true, ...out, ledgerCommit });
  } catch (e) {
    if (e && e.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ ok: false, error: "Duplicate referenceId/requestId", requestId: req.ctx?.requestId });
    }
    return next(e);
  }
}

module.exports = {
  me,
  balance,
  myTransactions,
  deposit,
  withdraw,
  getBank,
  saveBank,
  adminAdjust,
};
