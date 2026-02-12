const { submitKycSchema, reviewKycSchema } = require("./kyc.validators");
const service = require("./kyc.service");
const { z } = require("zod");

const revealSchema = z.object({ userId: z.uuid() });

const listQuerySchema = z.object({
  status: z.enum(["NOT_SUBMITTED", "PENDING", "APPROVED", "REJECTED"]).optional(),
  limit: z.coerce.number().finite().optional(),
  offset: z.coerce.number().finite().optional(),
});

const multer = require("multer");
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (_req, file, cb) => {
    const ok = ["image/jpeg", "image/png", "application/pdf"].includes(file.mimetype);
    cb(ok ? null : new Error("Invalid file type"), ok);
  },
});

function getCtx(req) {
  const raw = req.headers["x-device-id"];
  const deviceId = typeof raw === "string" && raw.trim() ? raw.trim().slice(0, 128) : null;

  return {
    ip: req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() || req.ip,
    ua: req.headers["user-agent"] || null,
    deviceId,
  };
}

function ensureAdmin(req) {
  if (!req.auth?.isAdmin) {
    const e = new Error("Forbidden");
    e.status = 403;
    throw e;
  }
}

async function uploadDocument(req, res, next) {
  upload.single("file")(req, res, async (err) => {
    try {
      if (err) throw Object.assign(err, { status: 400 });

      const docSide = String(req.body.docSide || "").toUpperCase();
      if (!["FRONT", "BACK", "SELFIE"].includes(docSide)) {
        throw Object.assign(new Error("Invalid docSide"), { status: 400 });
      }
      if (!req.file) throw Object.assign(new Error("Missing file"), { status: 400 });

      // service signature: (userId, { docSide, file }, ctx)
      const out = await service.storeKycDocument(req.auth.userId, { docSide, file: req.file }, getCtx(req));
      res.json({ ok: true, ...out }); // { documentId }
    } catch (e) {
      next(e);
    }
  });
}

async function submit(req, res, next) {
  try {
    const input = submitKycSchema.parse(req.body);
    const out = await service.submitKyc(req.auth.userId, input, getCtx(req));
    res.json({ ok: true, ...out });
  } catch (e) {
    next(e);
  }
}

async function status(req, res, next) {
  try {
    const out = await service.getKycStatus(req.auth.userId);
    res.json({ ok: true, kyc: out });
  } catch (e) {
    next(e);
  }
}

// ✅ Admin UI list
async function listApplications(req, res, next) {
  try {
    ensureAdmin(req);

    const q = listQuerySchema.parse(req.query);
    const out = await service.listApplications({
      status: q.status,
      limit: q.limit ?? 50,
      offset: q.offset ?? 0,
    });

    return res.json({ ok: true, ...out });
  } catch (e) {
    next(e);
  }
}

// ✅ Admin approve/reject
async function review(req, res, next) {
  try {
    ensureAdmin(req);

    const input = reviewKycSchema.parse(req.body);

    const out = await service.reviewKyc(
      {
        adminUserId: req.auth.userId,
        userId: input.userId,
        decision: input.decision,
        notes: input.notes ?? null,
      },
      getCtx(req)
    );

    res.json({ ok: true, ...out });
  } catch (e) {
    next(e);
  }
}

async function revealDocNumber(req, res, next) {
  try {
    ensureAdmin(req);

    const input = revealSchema.parse(req.body);
    const out = await service.revealDocNumberForAdmin(req.auth.userId, input.userId, getCtx(req));
    res.json({ ok: true, ...out }); // { docNumber: "...." }
  } catch (e) {
    next(e);
  }
}

// ✅ Admin: list documents for a userId
async function adminListDocuments(req, res, next) {
  try {
    ensureAdmin(req);

    const userId = String(req.query?.userId || "").trim();
    if (!userId) throw Object.assign(new Error("userId required"), { status: 400 });

    const out = await service.listKycDocumentsForAdmin({ userId });
    res.json({ ok: true, ...out }); // { items: [...] }
  } catch (e) {
    next(e);
  }
}

// ✅ Admin: download a specific document file by kyc_documents.id
async function adminDownloadDocument(req, res, next) {
  try {
    ensureAdmin(req);

    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) throw Object.assign(new Error("Invalid id"), { status: 400 });

    const out = await service.getKycDocumentFileForAdmin({ id });

    res.setHeader("Content-Type", out.mime_type);
    res.setHeader("Content-Length", String(out.file_size));

    out.stream.on("error", next);
    out.stream.pipe(res);
  } catch (e) {
    next(e);
  }
}


module.exports = {
  submit,
  status,

  // Keep both names for compatibility; routes use uploadKycDocument.
  uploadKycDocument: uploadDocument,
  uploadDocument,

  listApplications,
  review,
  revealDocNumber,
  adminListDocuments,
  adminDownloadDocument,
};