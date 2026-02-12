const request = require("supertest");

const { pool } = require("../src/config/mysql");
const { app } = require("../src/app");

async function resetDb() {
  await pool.execute("SET FOREIGN_KEY_CHECKS=0");
  try {
    await pool.execute("DELETE FROM kyc_documents");
    await pool.execute("DELETE FROM kyc_applications");
    await pool.execute("DELETE FROM refresh_tokens");
    await pool.execute("DELETE FROM security_logs");
    await pool.execute("DELETE FROM user_devices");
    await pool.execute("DELETE FROM user_ip_history");
    await pool.execute("DELETE FROM users");
  } finally {
    await pool.execute("SET FOREIGN_KEY_CHECKS=1");
  }
}


function uniqEmail() {
  return `smoke_${Date.now()}_${Math.floor(Math.random() * 1e9)}@test.local`;
}

function uniqPhone() {
  return `+39${Math.floor(100000000 + Math.random() * 900000000)}`;
}

async function registerAndLogin({ deviceId }) {
  const email = uniqEmail();
  const password = "VeryStrongPassword!!12";
  const phone = uniqPhone();

  await request(app)
    .post("/api/auth/register")
    .set("x-device-id", deviceId)
    .send({ email, password, phone })
    .expect(201);

  const loginRes = await request(app)
    .post("/api/auth/login")
    .set("x-device-id", deviceId)
    .send({ email, password })
    .expect(200);

  const access = loginRes.body?.tokens?.access;
  expect(typeof access).toBe("string");

  return { email, password, phone, access };
}

describe("Smoke", () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await pool.end();
  });

  test("login -> features returns ok", async () => {
    const did = "jest-device-1";
    const { access } = await registerAndLogin({ deviceId: did });

    const featuresRes = await request(app)
      .get("/api/security/me/features")
      .set("Authorization", `Bearer ${access}`)
      .set("x-device-id", did)
      .expect(200);

    expect(featuresRes.body.ok).toBe(true);
    expect(featuresRes.body.features).toBeTruthy();
  });

  test("kyc submit duplicate doc -> 409", async () => {
    const docPayload = {
      fullName: "Test User",
      dob: "1990-01-01",
      country: "US",
      docType: "PASSPORT",
      docNumber: `AA${Date.now()}${Math.floor(Math.random() * 1000)}`,
    };

    const u1 = await registerAndLogin({ deviceId: "jest-device-dup-1" });
    await request(app)
      .post("/api/kyc/submit")
      .set("Authorization", `Bearer ${u1.access}`)
      .set("x-device-id", "jest-device-dup-1")
      .send(docPayload)
      .expect(200);

    const u2 = await registerAndLogin({ deviceId: "jest-device-dup-2" });
    const dup = await request(app)
      .post("/api/kyc/submit")
      .set("Authorization", `Bearer ${u2.access}`)
      .set("x-device-id", "jest-device-dup-2")
      .send(docPayload)
      .expect(409);

    expect(dup.body.ok).toBe(false);
  });
});
