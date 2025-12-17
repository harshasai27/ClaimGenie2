import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import OpenAI from "openai";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

/* =========================
   BASIC SETUP
========================= */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const POLICIES_FILE = path.join(__dirname, "policies.json");
const CLAIMS_FILE = path.join(__dirname, "claims.json");

const app = express();
app.use(cors());
app.use(express.json());

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/* =========================
   CONSTANTS
========================= */
const FIELD_LABELS = {
  claimant_name: "Claimant Name",
  policy_number: "Policy Number",
  claim_type: "Claim Type",
  incident_date: "Incident Date",
  incident_location: "Incident Location",
  claim_amount: "Claim Amount",
  service_provider: "Service Provider",
  description_of_loss: "Description of Loss"
};

const REQUIRED_FIELDS = Object.keys(FIELD_LABELS);

/* =========================
   SESSION STORE
========================= */
const sessions = {};

function newSession() {
  return {
    state: "awaiting_policy_number",
    policyNumber: null,
    userDetails: null,
    claimData: {},
    missingFields: []
  };
}

function getSession(id) {
  if (!sessions[id]) sessions[id] = newSession();
  return sessions[id];
}

function generateSessionId() {
  return Math.random().toString(36).slice(2);
}

/* =========================
   FILE HELPERS
========================= */
async function loadPolicies() {
  try {
    return JSON.parse(await fs.readFile(POLICIES_FILE, "utf-8"));
  } catch {
    return {};
  }
}

async function loadClaims() {
  try {
    const raw = JSON.parse(await fs.readFile(CLAIMS_FILE, "utf-8"));
    return raw.claims ? raw : { claims: [] };
  } catch {
    return { claims: [] };
  }
}

async function saveClaims(data) {
  await fs.writeFile(CLAIMS_FILE, JSON.stringify(data, null, 2), "utf-8");
}

async function generateClaimId() {
  const data = await loadClaims();
  return `CLM-${1000 + data.claims.length}`;
}

/* =========================
   FORMATTERS
========================= */
function capitalize(text) {
  if (!text) return "N/A";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function formatClaimSummary(data) {
  return REQUIRED_FIELDS.map(
    f => `${FIELD_LABELS[f]}: ${data[f]}`
  ).join("\n");
}

function formatPolicyDetails(policy) {
  let out = "📄 Policy Details\n\n";

  out += "👤 Policy Holder\n";
  out += `Name: ${policy.name}\n`;
  if (policy.email) out += `Email: ${policy.email}\n`;
  if (policy.phoneNumber) out += `Phone: ${policy.phoneNumber}\n`;
  if (policy.address) out += `Address: ${policy.address}\n`;

  out += "\n📑 Policy Information\n";
  out += `Policy Type: ${policy.policyType}\n`;
  if (policy.policyStatus) out += `Policy Status: ${policy.policyStatus}\n`;
  out += `Valid Till: ${policy.validTill}\n`;
  if (policy.premium) out += `Premium: ₹${policy.premium}\n`;
  if (policy.sumInsured) out += `Sum Insured: ₹${policy.sumInsured}\n`;

  if (policy.policyType?.toLowerCase().includes("motor")) {
    out += "\n🚗 Vehicle Details\n";
    if (policy.vehicleModel) out += `Model: ${policy.vehicleModel}\n`;
    if (policy.registrationNumber) out += `Registration Number: ${policy.registrationNumber}\n`;
    if (policy.engineNumber) out += `Engine Number: ${policy.engineNumber}\n`;
    if (policy.chassisNumber) out += `Chassis Number: ${policy.chassisNumber}\n`;
    if (policy.yearOfManufacture) out += `Year of Manufacture: ${policy.yearOfManufacture}\n`;
    if (policy.fuelType) out += `Fuel Type: ${policy.fuelType}\n`;

    out += "\n🛡 Coverage\n";
    if (policy.coverage_ownDamage) out += `Own Damage: ${policy.coverage_ownDamage}\n`;
    if (policy.coverage_thirdParty) out += `Third Party: ${policy.coverage_thirdParty}\n`;
    if (policy.coverage_personalAccident)
      out += `Personal Accident: ${policy.coverage_personalAccident}\n`;
  }

  return out;
}

/* =========================
   AI HELPERS
========================= */
function safeParseJSON(msg) {
  try {
    return JSON.parse(
      msg.content.replace(/```json/g, "").replace(/```/g, "").trim()
    );
  } catch {
    return null;
  }
}

async function normalizeDate(raw) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return { date: raw };

  try {
    const out = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            "Convert date to ISO (YYYY-MM-DD). If ambiguous return {ambiguous:true}, if invalid return {invalid:true}. Return ONLY JSON."
        },
        { role: "user", content: raw }
      ]
    });
    return JSON.parse(out.choices[0].message.content);
  } catch {
    return { invalid: true };
  }
}

async function extractClaim(text, defaults = {}) {
  const out = await client.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0.1,
    messages: [
      {
        role: "system",
        content: `
You are an insurance claim data extractor.

Map labels to JSON keys:
Claimant Name → claimant_name
Policy Number → policy_number
Claim Type → claim_type
Incident Date → incident_date
Incident Location → incident_location
Claim Amount → claim_amount
Service Provider → service_provider
Description of Loss → description_of_loss

Labels may be inline or multiline.
Return ONLY valid JSON with ALL keys:
${JSON.stringify(REQUIRED_FIELDS)}
`
      },
      { role: "user", content: text }
    ]
  });

  const parsed = safeParseJSON(out.choices[0].message);

  return {
    claimant_name: null,
    policy_number: null,
    claim_type: null,
    incident_date: null,
    incident_location: null,
    claim_amount: null,
    service_provider: null,
    description_of_loss: null,
    ...(parsed || {}),
    ...defaults
  };
}

async function fillMissing(current, missing, text) {
  const out = await client.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0.1,
    messages: [
      { role: "system", content: "Fill ONLY missing claim fields. Return FULL JSON." },
      {
        role: "user",
        content: `Current:\n${JSON.stringify(current)}\nMissing:\n${missing}\nUser:\n${text}`
      }
    ]
  });

  const parsed = safeParseJSON(out.choices[0].message);
  return parsed ? { ...current, ...parsed } : current;
}

/* =========================
   VALIDATION
========================= */
async function validateClaim(data) {
  if (data.incident_date) {
    const norm = await normalizeDate(data.incident_date);
    if (norm.ambiguous)
      return { error: "❓ Incident Date is ambiguous. Please use YYYY-MM-DD.", missing: ["incident_date"] };
    if (norm.invalid)
      return { error: "❌ Incident Date is invalid.", missing: ["incident_date"] };

    const d = new Date(norm.date);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (d > today)
      return { error: "❌ Incident Date cannot be in the future.", missing: ["incident_date"] };

    data.incident_date = norm.date;
  }

  if (data.claim_amount) {
    const amt = Number(data.claim_amount);
    data.claim_amount = isNaN(amt) ? null : amt;
  }

  const missing = REQUIRED_FIELDS.filter(f => !data[f]);
  return { missing };
}

/* =========================
   RETRIEVAL
========================= */
async function getClaimById(id) {
  const data = await loadClaims();
  return data.claims.find(c => c.claimId.toLowerCase() === id.toLowerCase());
}

async function getClaimsByPolicy(policy) {
  const data = await loadClaims();
  return data.claims.filter(c => c.policy_number === policy);
}

/* =========================
   INTENT
========================= */
function detectIntent(msg) {
  const t = msg.toLowerCase().trim();

  if (t === "exit") return "EXIT";
  if (t === "restart") return "RESTART";
  if (t.includes("retrieve claim")) return "RETRIEVE_CLAIM";
  if (t.includes("view my claims") || t.includes("all claims")) return "VIEW_POLICY_CLAIMS";
  if (t.includes("file a new claim") || t === "new claim") return "FILE_NEW_CLAIM";

  return "CONTINUE";
}

/* =========================
   MAIN HANDLER
========================= */
async function handleMessage(session, msg) {
  const intent = detectIntent(msg);

  if (intent === "EXIT") {
    Object.assign(session, newSession());
    return "👋 Thank you for using ClaimGenie!\nHave a nice day 😊";
  }

  if (intent === "RESTART") {
    Object.assign(session, newSession());
    return "🔄 Session restarted.\n\nPlease enter your Policy Number.";
  }

  if (intent === "FILE_NEW_CLAIM") {
    session.claimData = {};
    session.missingFields = [];
    session.state = "awaiting_claim_details";

    return (
      "Sure 👍 Let’s file a new claim for your policy.\n\n" +
      "You may describe the incident or use labelled fields.\n\n" +
      "📌 Example:\nIncident Date: 2025-10-20\nIncident Location: Kondapur\nClaim Type: Bike Accident\nClaim Amount: 5000\nService Provider: TATA Motors\nDescription of Loss: Headlight damage\n\n" +
      "Please enter your claim details."
    );
  }

  if (intent === "RETRIEVE_CLAIM") {
    session.state = "awaiting_claim_id";
    return "Please enter your Claim ID.";
  }

  if (intent === "VIEW_POLICY_CLAIMS") {
    session.state = "awaiting_policy_for_claims";
    return "Please enter your Policy Number.";
  }

  if (session.state === "awaiting_claim_id") {
    const claim = await getClaimById(msg);
    if (!claim) return "❌ Claim not found.";
    return (
      "📄 Claim Details:\n\n" +
      formatClaimSummary(claim) +
      `\n\nClaim Status: ${claim.claim_status ?? "Filed"}\nPending With: ${claim.pending_with ?? "Claims Verification Team"}`
    );
  }

  if (session.state === "awaiting_policy_for_claims") {
    const claims = await getClaimsByPolicy(msg.toUpperCase());
    if (!claims.length) return "No claims found for this policy.";

    session.state = "done";
    return (
      "📂 Claims for this policy:\n\n" +
      claims.map(c =>
        `${c.claimId} | ${capitalize(c.claim_type)} | Claim Status: ${c.claim_status ?? "Filed"} | Pending With: ${c.pending_with ?? "Claims Verification Team"}`
      ).join("\n") +
      "\n\n👉 Enter a Claim ID to view details\n👉 Or type restart"
    );
  }

  if (session.state === "awaiting_policy_number") {
    const policies = await loadPolicies();
    const policy = policies[msg.toUpperCase()];
    if (!policy) return "❌ Invalid Policy Number.";

    session.policyNumber = msg.toUpperCase();
    session.userDetails = policy;
    session.state = "confirm_new_claim";

    return (
      "✅ Policy verified successfully.\n\n" +
      formatPolicyDetails(policy) +
      "\nWould you like to file a new claim? (yes/no)"
    );
  }

  if (session.state === "confirm_new_claim") {
    if (msg.toLowerCase().startsWith("y")) {
      session.state = "awaiting_claim_details";
      return (
        "Great 👍 Let’s file your claim.\n\n" +
        "You may describe the incident or use labelled fields.\n\n" +
        "📌 Example:\nClaimant Name: John\nIncident Date: 2025-10-20\nIncident Location: Kondapur\nClaim Type: Bike Accident\nClaim Amount: 5000\nService Provider: TATA Motors\nDescription of Loss: Headlight damage\n\n" +
        "Please enter your claim details."
      );
    }
    if (msg.toLowerCase().startsWith("n")) {
      session.state = "done";
      return "Okay 👍 Type restart anytime to begin again.";
    }
    return "Please reply with yes or no.";
  }

  if (session.state === "awaiting_claim_details") {
    session.claimData = await extractClaim(msg, {
      policy_number: session.policyNumber,
      claimant_name: session.userDetails.name
    });

    const v = await validateClaim(session.claimData);
    if (v.error) {
      session.missingFields = v.missing;
      session.state = "awaiting_missing";
      return v.error;
    }

    if (!v.missing.length) {
      const id = await generateClaimId();
      const all = await loadClaims();

      all.claims.push({
        claimId: id,
        ...session.claimData,
        claim_status: "In Review",
        pending_with: "Claims Verification Team",
        createdAt: new Date().toISOString()
      });

      await saveClaims(all);
      session.state = "done";

      return (
        "✅ Claim created successfully!\n\n" +
        formatClaimSummary(session.claimData) +
        `\n\n🆔 Claim ID: ${id}\n\n` +
        "What would you like to do next?\n" +
        "• Retrieve Claim\n" +
        "• View My Claims\n" +
        "• File a New Claim\n" +
        "• Restart\n" +
        "• Exit"
      );
    }

    session.missingFields = v.missing;
    session.state = "awaiting_missing";
    return "Missing fields:\n" + v.missing.map(f => `• ${FIELD_LABELS[f]}`).join("\n");
  }

  if (session.state === "awaiting_missing") {
    session.claimData = await fillMissing(session.claimData, session.missingFields, msg);
    const v = await validateClaim(session.claimData);
    if (v.error) return v.error;

    if (!v.missing.length) {
      const id = await generateClaimId();
      const all = await loadClaims();

      all.claims.push({
        claimId: id,
        ...session.claimData,
        claim_status: "In Review",
        pending_with: "Claims Verification Team",
        createdAt: new Date().toISOString()
      });

      await saveClaims(all);
      session.state = "done";

      return (
        "✅ Claim created successfully!\n\n" +
        formatClaimSummary(session.claimData) +
        `\n\n🆔 Claim ID: ${id}\n\n` +
        "What would you like to do next?\n" +
        "• Retrieve Claim\n" +
        "• View My Claims\n" +
        "• File a New Claim\n" +
        "• Restart\n" +
        "• Exit"
      );
    }

    session.missingFields = v.missing;
    return "Still missing:\n" + v.missing.map(f => `• ${FIELD_LABELS[f]}`).join("\n");
  }

  return "Type restart or exit to continue.";
}

/* =========================
   API ROUTE
========================= */
app.post("/api/chat", async (req, res) => {
  try {
    let { message, sessionId } = req.body;
    if (!sessionId) sessionId = generateSessionId();

    const session = getSession(sessionId);
    const reply = await handleMessage(session, message);

    res.json({ sessionId, reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ reply: "Server error" });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () =>
  console.log(`🚀 ClaimGenie backend running on port ${PORT}`)
);
