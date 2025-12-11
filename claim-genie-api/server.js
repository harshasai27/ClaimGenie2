import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import OpenAI from "openai";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const POLICIES_FILE = path.join(__dirname, "policies.json");
const CLAIMS_FILE = path.join(__dirname, "claims.json");


const app = express();
app.use(cors());
app.use(express.json());

// ---------- OpenAI client ----------
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

if (!process.env.OPENAI_API_KEY) {
  console.error("❌ Missing OPENAI_API_KEY in .env");
  process.exit(1);
}

// ---------- Labels & required fields ----------
const FIELD_LABELS = {
  claimant_name: "Claimant Name",
  policy_number: "Policy Number",
  claim_type: "Claim Type",
  incident_date: "Incident Date",
  incident_location: "Incident Location",
  claim_amount: "Claim Amount",
  service_provider: "Service Provider",
  description_of_loss: "Description of Loss",
};
const REQUIRED_FIELDS = Object.keys(FIELD_LABELS);

// ---------- Session store ----------
const sessions = {};

function newSession() {
  return {
    state: "awaiting_policy_number", // other states: confirm_new_claim, awaiting_claim_details, awaiting_missing, done, done_no_claim, awaiting_claim_id
    policyNumber: null,
    userDetails: null,
    claimData: {},
    missingFields: [],
    lastClaimId: null,
  };
}

function getSession(id) {
  if (!sessions[id]) sessions[id] = newSession();
  return sessions[id];
}

function generateSessionId() {
  return Math.random().toString(36).slice(2);
}

// ---------- JSON file helpers ----------
async function loadPolicies() {
  try {
    const raw = await fs.readFile(POLICIES_FILE, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    console.error("⚠ Could not read policies.json, using empty object:", err.message);
    return {}; // no policies → all policy numbers invalid
  }
}

async function loadClaims() {
  try {
    const raw = await fs.readFile(CLAIMS_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.claims)) return { claims: [] };
    return parsed;
  } catch (err) {
    console.error("⚠ Could not read claims.json, starting empty:", err.message);
    return { claims: [] };
  }
}

async function saveClaims(claimsObj) {
  try {
    await fs.writeFile(CLAIMS_FILE, JSON.stringify(claimsObj, null, 2), "utf-8");
  } catch (err) {
    console.error("❌ Failed to write claims.json:", err.message);
  }
}

// ---------- Utility: parse JSON from OpenAI ----------
function safeParseJSON(message) {
  if (!message) return null;
  if (message.parsed) return message.parsed;

  if (message.content) {
    try {
      const cleaned = message.content
        .replace(/```json/gi, "")
        .replace(/```/g, "")
        .trim();
      return JSON.parse(cleaned);
    } catch {
      console.log("⚠ JSON parse failed from content");
    }
  }
  return null;
}

// ---------- Validation / Summary helpers ----------
function validateClaimJS(data) {
  const missing = REQUIRED_FIELDS.filter((f) => !data[f]);
  return { missing, cleaned: data };
}

function formatSummary(data) {
  return REQUIRED_FIELDS
    .map((f) => `${FIELD_LABELS[f]}: ${data[f] ?? "Not Provided"}`)
    .join("\n");
}

// ---------- Generate Claim ID ----------
async function generateClaimId() {
  const claimsObj = await loadClaims();
  const base = 1000 + (claimsObj.claims?.length || 0);
  return `CLM-${base}`;
}

// ---------- AI: Flexible initial extraction ----------
async function extractClaimFlexible(text, defaults = {}) {
  try {
    const completion = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content: `
You extract claim fields from flexible user input.
User may describe an incident in a paragraph, or use labels like:
"Claimant Name: ", "Incident Date - ", etc.

Return ONLY JSON with:

{
  "claimant_name": string | null,
  "policy_number": string | null,
  "claim_type": string | null,
  "incident_date": string | null,
  "incident_location": string | null,
  "claim_amount": number | null,
  "service_provider": string | null,
  "description_of_loss": string | null
}

Infer values where possible. Use null if unknown.
`
        },
        { role: "user", content: text },
      ],
    });

    const parsed = safeParseJSON(completion.choices[0].message);

    const base = {
      claimant_name: null,
      policy_number: null,
      claim_type: null,
      incident_date: null,
      incident_location: null,
      claim_amount: null,
      service_provider: null,
      description_of_loss: null,
    };

    return { ...base, ...(parsed || {}), ...defaults };
  } catch (err) {
    console.error("🔥 extractClaimFlexible error:", err.message);
    return {
      claimant_name: defaults.claimant_name ?? null,
      policy_number: defaults.policy_number ?? null,
      claim_type: null,
      incident_date: null,
      incident_location: null,
      claim_amount: null,
      service_provider: null,
      description_of_loss: null,
    };
  }
}

// ---------- AI: Fill only missing fields ----------
async function fillMissingAI(currentData, missing, text) {
  try {
    const completion = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content: `
You fill ONLY missing fields of a claim JSON using user's follow-up message.

Rules:
- Only update fields listed in "missingFields".
- Never clear or overwrite existing non-null fields.
- Return FULL JSON with the same 8 keys.
`
        },
        {
          role: "user",
          content: `
Current JSON:
${JSON.stringify(currentData, null, 2)}

Missing fields:
${JSON.stringify(missing)}

User message:
"${text}"

Update only the clearly provided missing fields. Return ONLY the full JSON object.
`
        },
      ],
    });

    const parsed = safeParseJSON(completion.choices[0].message);
    if (!parsed || typeof parsed !== "object") return currentData;

    const updated = { ...currentData };
    REQUIRED_FIELDS.forEach((f) => {
      if (parsed[f] !== undefined && parsed[f] !== null) {
        updated[f] = parsed[f];
      }
    });
    return updated;
  } catch (err) {
    console.error("🔥 fillMissingAI error:", err.message);
    return currentData;
  }
}

// ---------- Policy number validation ----------
function isPolicyExpired(validTillStr) {
  if (!validTillStr) return false;
  const today = new Date();
  const validTill = new Date(validTillStr);
  return validTill < new Date(today.toISOString().slice(0, 10));
}

// ---------- Claim retrieval by ID ----------
async function retrieveClaimById(claimId) {
  const claimsObj = await loadClaims();
  const claim = claimsObj.claims.find(
    (c) => c.claimId?.toLowerCase() === claimId.toLowerCase()
  );
  return claim || null;
}

function formatClaimRetrieval(claim) {
  const lines = [
    `Claim ID: ${claim.claimId}`,
    `Policy Number: ${claim.policy_number}`,
    `Claimant Name: ${claim.claimant_name}`,
    `Claim Type: ${claim.claim_type}`,
    `Incident Date: ${claim.incident_date}`,
    `Incident Location: ${claim.incident_location}`,
    `Claim Amount: ${claim.claim_amount}`,
    `Service Provider: ${claim.service_provider}`,
    `Description of Loss: ${claim.description_of_loss}`,
    `Created At: ${claim.createdAt || "N/A"}`,
  ];
  return lines.join("\n");
}

// ---------- Main chat logic ----------
async function handleMessage(session, message) {
  const msg = message.trim();

  // Global shortcuts
  if (/^(restart|reset)$/i.test(msg)) {
    Object.assign(session, newSession());
    return (
      "Conversation restarted.\n" +
      "Please enter your policy number.\n" +
      "You can also type 'retrieve claim' to look up an existing claim by Claim ID."
    );
  }

  // Global entry for retrieval
  if (
    session.state === "awaiting_policy_number" &&
    /retrieve/i.test(msg)
  ) {
    session.state = "awaiting_claim_id";
    return "Please enter your Claim ID (e.g., CLM-1001).";
  }

  // ---------------- Retrieval flow ----------------
  if (session.state === "awaiting_claim_id") {
    const id = msg.toUpperCase().trim();
    const claim = await retrieveClaimById(id);
    if (!claim) {
      return (
        `I could not find any claim with ID ${id}.\n` +
        `Please check the ID and try again, or type 'restart' to file a new claim.`
      );
    }
    // Stay in same state so user can query more IDs
    return (
      `Here are the details for Claim ID ${id}:\n\n` +
      formatClaimRetrieval(claim) +
      "\n\nYou can enter another Claim ID or type 'restart' to start over."
    );
  }

  //New claim flow :

  // STEP 1: awaiting policy number
  if (session.state === "awaiting_policy_number") {
    const policyNumber = msg.toUpperCase();
    const policies = await loadPolicies();
    const policy = policies[policyNumber];

    if (!policy) {
      return (
        `The policy number "${policyNumber}" was not found.\n` +
        `Please enter a valid policy number or type 'retrieve claim' to look up an existing claim.`
      );
    }

    // expiry check
    if (isPolicyExpired(policy.validTill)) {
      session.state = "done_no_claim";
      session.policyNumber = policyNumber;
      session.userDetails = policy;
      return (
        `Policy Number: ${policyNumber}\n` +
        `This policy has expired (Valid Till: ${policy.validTill}).\n` +
        `New claims cannot be filed on an expired policy.\n` +
        `If you think this is an error, please contact support.`
      );
    }

    // Valid & active policy
    session.policyNumber = policyNumber;
    session.userDetails = policy;
    session.state = "confirm_new_claim";

    let details=`Thank you! Here are your policy details:\n`;
    for(const[key, value] of Object.entries(policy)){
      const label = key 
          .replace(/([A-Z])/g," $1")
          .replace(/_/g," ")
          .replace(/^./,(c)=> c.toUpperCase());
      details+=`${label}: ${value}\n`;
    }

    details+=`Policy Number : ${session.policyNumber}\n`;
    details+=`\nWould you like to file a new claim? (yes/no)`;

    return details;
  }

  // STEP 2: confirm new claim
  if (session.state === "confirm_new_claim") {
    const lower = msg.toLowerCase();
    if (lower.startsWith("y")) {
      session.state = "awaiting_claim_details";
      return (
        "Great! Please provide your claim details in one message.\n\n" +
        "You can either:\n" +
        "• Describe the incident in a paragraph, OR\n" +
        "• Provide labeled fields like:\n\n" +
        "Claimant Name: \n" +
        "Incident Date: \n" +
        "Incident Location: \n" +
        "Claim Type: \n" +
        "Claim Amount: \n" +
        "Service Provider: \n" +
        "Description of Loss: \n\n" +
        "I will extract the required details automatically."
      );
    }
    if (lower.startsWith("n")) {
      session.state = "done_no_claim";
      return (
        "Okay, we will not file a new claim right now.\n" +
        "You can type 'restart' to start again or 'retrieve claim' to look up an existing claim."
      );
    }
    return "Please answer 'yes' or 'no'.";
  }

  // STEP 3: awaiting initial claim details
  if (session.state === "awaiting_claim_details") {
    const defaults = {
      claimant_name: session.userDetails?.name ?? null,
      policy_number: session.policyNumber ?? null,
    };

    const claimData = await extractClaimFlexible(msg, defaults);
    session.claimData = claimData;

    const { missing } = validateClaimJS(claimData);
    session.missingFields = missing;

    if (missing.length === 0) {
      // store and finish
      const claimId = await generateClaimId();
      session.lastClaimId = claimId;

      const claimsObj = await loadClaims();
      claimsObj.claims.push({
        claimId,
        ...claimData,
        createdAt: new Date().toISOString(),
      });
      await saveClaims(claimsObj);

      session.state = "done";

      return (
        formatSummary(claimData) +
        `\n\nYour Claim ID is: ${claimId}\n` +
        "Thank you! Your claim has been recorded. Please wait for further communication."
      );
    }

    session.state = "awaiting_missing";

    return (
      `Thank you! I captured most of your details.\n\n` +
      `However, I still need:\n` +
      `${missing.map((f) => FIELD_LABELS[f]).join(", ")}\n\n` +
      `Please provide these missing details in one message. For example:\n` +
      missing.map((f) => `${FIELD_LABELS[f]}: <value>`).join("\n")
    );
  }

  // STEP 4: awaiting missing fields
  if (session.state === "awaiting_missing") {
    const updated = await fillMissingAI(
      session.claimData,
      session.missingFields,
      msg
    );

    session.claimData = updated;

    const { missing } = validateClaimJS(updated);
    session.missingFields = missing;

    if (missing.length === 0) {
      const claimId = await generateClaimId();
      session.lastClaimId = claimId;

      const claimsObj = await loadClaims();
      claimsObj.claims.push({
        claimId,
        ...updated,
        createdAt: new Date().toISOString(),
      });
      await saveClaims(claimsObj);

      session.state = "done";

      return (
        formatSummary(updated) +
        `\n\nYour Claim ID is: ${claimId}\n` +
        "Thank you! Your claim has been recorded. Please wait for further communication."
      );
    }

    return (
      `Thanks! I still don't have complete information.\n\n` +
      `Still missing:\n` +
      `${missing.map((f) => FIELD_LABELS[f]).join(", ")}\n\n` +
      `Please provide only these remaining details in your next message.`
    );
  }

  // DONE states
  if (session.state === "done_no_claim") {
    return (
      "We are not filing a claim right now.\n" +
      "You can type 'restart' to start again or 'retrieve claim' to look up an existing claim."
    );
  }

  if (session.state === "done") {
    return (
      "Your claim has already been recorded.\n" +
      (session.lastClaimId
        ? `Your Claim ID is ${session.lastClaimId}.\n`
        : "") +
      "You can type 'retrieve claim' to view a claim, or 'restart' to file a new one."
    );
  }

  return "I'm not sure what to do. Please type 'restart' to start over.";
}

// ---------- API endpoint ----------
app.post("/api/chat", async (req, res) => {
  try {
    let { message, sessionId } = req.body;
    if (!sessionId) sessionId = generateSessionId();

    const session = getSession(sessionId);
    const reply = await handleMessage(session, message);

    res.json({ sessionId, reply });
  } catch (err) {
    console.error("🔥 API error:", err);
    res.status(500).json({ reply: "Internal server error" });
  }
});

// ---------- Start server ----------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 ClaimGenie API running on port ${PORT}`);
});