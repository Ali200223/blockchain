const crypto = require("crypto");
const { pool } = require("../../config/mysql");
const { env } = require("../../config/env");
const { logSecurityEvent } = require("../security/securityLog.service");


const fs = require("fs");
const path = require("path");

function uploadsRoot() {
 // repo-root /uploads/kyc (not inside /src)
  return path.resolve(__dirname, "../../../../uploads/kyc");
}

async function storeKycDocument(userId, { docSide, file }, ctx) {
  const conn = await pool.getConnection();
  let absPath = null;
  try {
    // Ensure an application row exists even if the user uploads docs before /status or /submit
    await conn.query("INSERT IGNORE INTO kyc_applications (user_id) VALUES (?)", [userId]);

    const [apps] = await conn.query("SELECT id FROM kyc_applications WHERE user_id = ? LIMIT 1", [userId]);
    if (!apps.length) {
      const e = new Error("KYC application missing");
      e.status = 409;
      throw e;
    }
    const kycApplicationId = apps[0].id;

    const sha256 = crypto.createHash("sha256").update(file.buffer).digest("hex");
    const ext = file.mimetype === "application/pdf" ? "pdf" : (file.mimetype === "image/png" ? "png" : "jpg");

    const userDir = path.join(uploadsRoot(), String(userId));
    fs.mkdirSync(userDir, { recursive: true });

    const storageKey = String(userId) + "/" + Date.now() + "_" + docSide + "." + ext;
    absPath = path.join(uploadsRoot(), storageKey);

    fs.writeFileSync(absPath, file.buffer);

    const fileSize = typeof file.size === "number" ? file.size : (file.buffer ? file.buffer.length : 0);
    const [ins] = await conn.query(
      "INSERT INTO kyc_documents (kyc_application_id, doc_side, storage_key, mime_type, file_size, sha256) VALUES (?, ?, ?, ?, ?, ?)",
      [kycApplicationId, docSide, storageKey, file.mimetype, fileSize, sha256]
    );

    await logSecurityEvent({
      userId,
      eventType: "KYC_DOC_UPLOADED",
      ctx,
      metadata: { docSide, mimeType: file.mimetype, fileSize },
    });

    return { documentId: ins.insertId };
  } catch (e) {
    // best-effort cleanup if DB insert fails after write
    try {
      if (absPath && fs.existsSync(absPath)) fs.unlinkSync(absPath);
    } catch (_) {}
    throw e;
  } finally {
    conn.release();
  }
}

function normalizeDocNumber(v) {
  return String(v || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");

}


function getEncKey() {
  const key = Buffer.from(env.KYC_DOC_ENC_KEY_BASE64, "base64");
  if (key.length !== 32) throw new Error("KYC_DOC_ENC_KEY_BASE64 must decode to 32 bytes");
  return key;
}

function encryptDocNumber(docNumberNormalized) {
  const key = getEncKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(docNumberNormalized, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext, iv, tag };
}

function decryptDocNumber({ ciphertext, iv, tag }) {
  const key = getEncKey();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain.toString("utf8");
}


function hashDocNumber(docNumber) {
  //  env.js uses KYC_DOC_NUMBER_SALT
  const salt = env.KYC_DOC_NUMBER_SALT || "";
  const normalized = normalizeDocNumber(docNumber);
  return crypto.createHash("sha256").update(`${salt}:${normalized}`).digest("hex");
}

async function ensureKycRow(userId) {
  await pool.execute(`INSERT IGNORE INTO kyc_applications (user_id) VALUES (:userId)`, { userId });

  const [rows] = await pool.execute(
    `
    SELECT id, user_id, level, status, full_name, dob, country, doc_type, doc_number_hash,
           submitted_at, reviewed_by, review_notes, updated_at
    FROM kyc_applications
    WHERE user_id = :userId
    LIMIT 1
    `,
    { userId }
  );

  return rows[0] || null;
}

async function getKycStatus(userId) {
  const row = await ensureKycRow(userId);
  if (!row) throw Object.assign(new Error("KYC row not found"), { status: 500 });

  return {
    level: row.level,
    status: row.status,
    submittedAt: row.submitted_at,
    updatedAt: row.updated_at,
    reviewNotes: row.review_notes,
    docType: row.doc_type,
  };
}

async function submitKyc(userId, input, ctx) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    await conn.execute(`INSERT IGNORE INTO kyc_applications (user_id) VALUES (:userId)`, { userId });

    const [rows] = await conn.execute(
      `
      SELECT id, status
      FROM kyc_applications
      WHERE user_id = :userId
      FOR UPDATE
      `,
      { userId }
    );

    const app = rows[0];
    if (!app) throw Object.assign(new Error("KYC application missing"), { status: 500 });

    if (app.status === "PENDING" || app.status === "APPROVED") {
      throw Object.assign(new Error("KYC already submitted"), { status: 409 });
    }
    const enforcedDocType = "PASSPORT";
    const normalized = normalizeDocNumber(input.docNumber);
    const docHash = hashDocNumber(normalized);
    const last4 = normalized.slice(-4);
    const enc = encryptDocNumber(normalized);

await conn.execute(`
  UPDATE kyc_applications
  SET
    full_name = :fullName,
    dob = :dob,
    country = :country,
    doc_type = :docType,
    doc_number_hash = :docHash,
    doc_number_last4 = :last4,
    doc_number_enc = :enc,
    doc_number_iv = :iv,
    doc_number_tag = :tag,
    status = 'PENDING',
    submitted_at = NOW()
  WHERE user_id = :userId
`, {
  userId,
  fullName: input.fullName || null,
  dob: input.dob || null,
  country: input.country || null,
  docType: enforcedDocType || null,
  docHash,
  last4,
  enc: enc.ciphertext,
  iv: enc.iv,
  tag: enc.tag,
});


    await conn.commit();

    await logSecurityEvent({
      userId,
      eventType: "KYC_SUBMITTED",
      ctx,
      metadata: { docType: enforcedDocType|| null },
    });

    return { status: "PENDING" };
  } catch (e) {
    await conn.rollback();

    if (e && (e.code === "ER_DUP_ENTRY" || String(e.message || "").includes("Duplicate"))) {
      await logSecurityEvent({ userId, eventType: "KYC_SUBMIT_FAIL_DUPLICATE_DOC", ctx });
      throw Object.assign(new Error("Document already used"), { status: 409 });
    }

    await logSecurityEvent({
      userId,
      eventType: "KYC_SUBMIT_FAIL",
      ctx,
      metadata: { msg: e?.message || "unknown" },
    });

    throw e;
  } finally {
    conn.release();
  }
}

// ✅ Admin approve/reject + wallet gating
async function reviewKyc({ adminUserId, userId, decision, notes }, ctx) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // ensure row exists
    await conn.execute(`INSERT IGNORE INTO kyc_applications (user_id) VALUES (:userId)`, { userId });

    const [rows] = await conn.execute(
      `
      SELECT id, status
      FROM kyc_applications
      WHERE user_id = :userId
      FOR UPDATE
      `,
      { userId }
    );

    if (!rows.length) throw Object.assign(new Error("KYC application not found"), { status: 404 });

    const app = rows[0];
    if (app.status !== "PENDING") {
      throw Object.assign(new Error(`KYC is not pending (current=${app.status})`), { status: 409 });
    }

    const newStatus = decision === "APPROVE" ? "APPROVED" : "REJECTED";

    await conn.execute(
      `
      UPDATE kyc_applications
      SET status = :newStatus,
          reviewed_by = :adminUserId,
          review_notes = :notes
      WHERE user_id = :userId
      `,
      { userId, newStatus, adminUserId, notes: notes || null }
    );

    // Wallet enforcement (assumes defaults exist / columns exist as in your wallet module)
    await conn.execute(
      `INSERT IGNORE INTO wallets (user_id, balance, currency, status)
       VALUES (:userId, 0.00, :currency, 'LOCKED')`,

       { userId, currency: env.WALLET_CURRENCY }

    );

    if (newStatus === "APPROVED") {
      await conn.execute(`UPDATE wallets SET status='ACTIVE' WHERE user_id = :userId`, { userId });
    } else {
      await conn.execute(`UPDATE wallets SET status='LOCKED' WHERE user_id = :userId`, { userId });
    }

    await conn.commit();

    await logSecurityEvent({
      userId,
      eventType: newStatus === "APPROVED" ? "KYC_APPROVED" : "KYC_REJECTED",
      ctx,
      metadata: { reviewedBy: adminUserId },
    });

    return { status: newStatus };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

// ✅ Admin UI list (reads from VIEW for safety)
async function listApplications({ status, limit = 50, offset = 0 }) {
  const lim = Math.trunc(Math.max(1, Math.min(200, Number(limit) || 50)));
  const off = Math.trunc(Math.max(0, Number(offset) || 0));

  const [rows] = await pool.execute(
    `
    SELECT
      user_id, level, status, full_name, dob, country, doc_type,
      submitted_at, reviewed_by, review_notes, updated_at
    FROM v_admin_kyc_applications
    WHERE (:status IS NULL OR status = :status)
    ORDER BY
      CASE WHEN status = 'PENDING' THEN 0 ELSE 1 END,
      submitted_at DESC,
      updated_at DESC
    LIMIT ${lim} OFFSET ${off}
    `,
    { status: status ?? null }
  );

  return { limit: lim, offset: off, items: rows };


}

async function revealDocNumberForAdmin(adminUserId, userId, ctx) {
  const [rows] = await pool.execute(
    `SELECT doc_number_enc, doc_number_iv, doc_number_tag FROM kyc_applications WHERE user_id = :userId LIMIT 1`,
    { userId }
  );
  if (!rows.length) throw Object.assign(new Error("KYC application not found"), { status: 404 });

  const r = rows[0];
  if (!r.doc_number_enc || !r.doc_number_iv || !r.doc_number_tag) {
    throw Object.assign(new Error("No encrypted doc number stored"), { status: 409 });
  }

  const docNumber = decryptDocNumber({
    ciphertext: Buffer.from(r.doc_number_enc),
    iv: Buffer.from(r.doc_number_iv),
    tag: Buffer.from(r.doc_number_tag),
  });

  await logSecurityEvent({
    userId: adminUserId,
    eventType: "KYC_DOC_NUMBER_REVEALED",
    ctx,
    metadata: { targetUserId: userId },
  });

  return { docNumber };
}


// ✅ Admin: list KYC documents for a user (by userId)
async function listKycDocumentsForAdmin({ userId }) {
  const conn = await pool.getConnection();
  try {
    const [apps] = await conn.query(`SELECT id FROM kyc_applications WHERE user_id=? LIMIT 1`, [userId]);
    if (!apps.length) return { items: [] };

    const [rows] = await conn.query(
      `SELECT id, doc_side, mime_type, file_size, sha256, created_at
         FROM kyc_documents
        WHERE kyc_application_id=?
        ORDER BY created_at DESC`,
      [apps[0].id]
    );
    return { items: rows };
  } finally {
    conn.release();
  }
}

// ✅ Admin: get a readable file stream for a specific KYC document (by kyc_documents.id)
async function getKycDocumentFileForAdmin({ id }) {
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query(
      `SELECT storage_key, mime_type, file_size FROM kyc_documents WHERE id=? LIMIT 1`,
      [id]
    );
    if (!rows.length) throw Object.assign(new Error("Not found"), { status: 404 });

    const r = rows[0];
    const root = uploadsRoot();
    const absPath = path.resolve(root, r.storage_key);

    // simple path traversal guard
    if (!absPath.startsWith(root + path.sep)) {
      throw Object.assign(new Error("Invalid storage key"), { status: 400 });
    }
    if (!fs.existsSync(absPath)) throw Object.assign(new Error("File missing"), { status: 404 });

    return { mime_type: r.mime_type, file_size: r.file_size, stream: fs.createReadStream(absPath) };
  } finally {
    conn.release();
  }
}


module.exports = {
  submitKyc,
  getKycStatus,
  storeKycDocument,

  // Admin
  listApplications,
  reviewKyc,
  revealDocNumberForAdmin,
  listKycDocumentsForAdmin,
  getKycDocumentFileForAdmin,
};
