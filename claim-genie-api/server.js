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

// =====================
// OPENAI SETUP
// =====================
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});
if (!process.env.OPENAI_API_KEY) {
  console.error("❌ Missing OPENAI_API_KEY");
  process.exit(1);
}

// =====================
// GLOBAL CONSTANTS
// =====================
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

// =====================
// SESSION STORE
// =====================
const sessions = {};

function newSession() {
  return {
    state: "awaiting_policy_number",
    policyNumber: null,
    userDetails: null,
    claimData: {},
    missingFields: [],
    lastClaimId: null
  };
}

function getSession(id) {
  if (!sessions[id]) sessions[id] = newSession();
  return sessions[id];
}

function generateSessionId() {
  return Math.random().toString(36).slice(2);
}

// FILE HELPERS
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

// Create Claim ID
async function generateClaimId() {
  const data = await loadClaims();
  const base = 1000 + (data.claims?.length || 0);
  return `CLM-${base}`;
}

// JSON PARSER
function safeParseJSON(msg) {
  try {
    return JSON.parse(
      msg.content.replace(/```json/g, "").replace(/```/g, "").trim()
    );
  } catch {
    return null;
  }
}

// VALIDATION
function validateClaimJS(data) {
  if (data.incident_date) {
    const d = new Date(data.incident_date);
    const now = new Date();
    now.setHours(0,0,0,0);

    if (d > now) {
      return {
        missing: ["incident_date"],
        errorMessage:
          "❌ The incident date cannot be in the future. Please enter a valid past date.",
        cleaned: data
      };
    }
  }

  const missing = REQUIRED_FIELDS.filter(f => !data[f]);
  return { missing, cleaned: data };
}

function formatSummary(data) {
  return REQUIRED_FIELDS.map(
    f => `${FIELD_LABELS[f]}: ${data[f] ?? "Not Provided"}`
  ).join("\n");
}

async function extractClaimFlexible(text, defaults = {}) {
  try {
    const out = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content: `
Extract claim fields from any kind of text (paragraph, labels, mixed).
Return ONLY JSON with these keys:
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
  } catch {
    return defaults;
  }
}

async function fillMissingAI(current, missing, text) {
  try {
    const out = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content: "Fill ONLY the missing fields based on user message."
        },
        {
          role: "user",
          content: `
Current JSON:
${JSON.stringify(current,null,2)}

Missing fields: ${missing}

User message:
${text}

Return FULL updated JSON.
`
        }
      ]
    });

    const parsed = safeParseJSON(out.choices[0].message);
    if (!parsed) return current;

    const updated = { ...current };
    for (const f of REQUIRED_FIELDS) {
      if (parsed[f] !== undefined && parsed[f] !== null) {
        updated[f] = parsed[f];
      }
    }
    return updated;
  } catch {
    return current;
  }
}

async function retrieveClaimById(id) {
  const claims = await loadClaims();
  return claims.claims.find(c => c.claimId?.toLowerCase() === id.toLowerCase()) || null;
}

function formatClaimRetrieval(c) {
  return `
Claim ID: ${c.claimId}
Policy Number: ${c.policy_number}
Claimant Name: ${c.claimant_name}
Claim Type: ${c.claim_type}
Incident Date: ${c.incident_date}
Incident Location: ${c.incident_location}
Claim Amount: ${c.claim_amount}
Service Provider: ${c.service_provider}
Description of Loss: ${c.description_of_loss}
Created At: ${c.createdAt}
`;
}


async function handleMessage(session, msg) {
  msg = msg.trim();

  if (/retrieve/i.test(msg)) {
    session.state = "awaiting_claim_id";
    return "Please enter your Claim ID (e.g., CLM-1001).";
  }

  if (/restart/i.test(msg)) {
    Object.assign(session, newSession());
    return (
      "Conversation restarted.\n\n" +
      "Please enter your Policy Number.\n" +
      "Or type \"Retrieve Claim\" to check an existing claim."
    );
  }


  // CLAIM RETRIEVAL MODE
  if (session.state === "awaiting_claim_id") {
    const claim = await retrieveClaimById(msg);

    if (!claim) {
      return `❌ No claim found with ID "${msg}". Try again or type "restart".`;
    }

    return (
      formatClaimRetrieval(claim) +
      "\nYou may enter another Claim ID or type \"restart\"."
    );
  }

  // STEP 1: ENTER POLICY NUMBER
  if (session.state === "awaiting_policy_number") {
    const policies = await loadPolicies();
    const policy = policies[msg.toUpperCase()];

    if (!policy) {
      return `❌ Invalid policy number "${msg}". Please try again.`;
    }

    const expiry = new Date(policy.validTill);
    const today = new Date();

    if (expiry < today) {
      session.state = "done_no_claim";
      return (
        `Policy Number: ${msg}\n` +
        `❌ This policy expired on ${policy.validTill}.\n` +
        `New claims cannot be filed.`
      );
    }

    // Valid Policy
    session.policyNumber = msg.toUpperCase();
    session.userDetails = policy;
    session.state = "confirm_new_claim";

    let details = "Thank you! Here are your policy details:\n";
    for (const [k,v] of Object.entries(policy)) {
      const label = k.replace(/_/g," ")
        .replace(/([A-Z])/g," $1")
        .replace(/^./, c=>c.toUpperCase());
      details += `${label}: ${v}\n`;
    }

    return details + "\nWould you like to file a new claim? (yes/no)";
  }

  // STEP 2: CONFIRM NEW CLAIM
  if (session.state === "confirm_new_claim") {
    if (msg.toLowerCase().startsWith("y")) {
      session.state = "awaiting_claim_details";
      return (
        "Great! Please provide your claim details.\n\n" +
        "You may describe the incident OR use labeled fields.\n\n" +
        "Example:\n" +
        "Claimant Name: \n" +
        "Incident Date: \n" +
        "Incident Location: \n" +
        "Claim Type: \n" +
        "Claim Amount: \n" +
        "Service Provider: \n" +
        "Description of Loss: \n"
      );
    }

    if (msg.toLowerCase().startsWith("n")) {
      session.state = "done_no_claim";
      return "Okay! Type \"restart\" anytime to start again.";
    }

    return "Please answer with yes or no.";
  }

  // STEP 3: INITIAL CLAIM DETAILS
  if (session.state === "awaiting_claim_details") {
    const defaults = {
      claimant_name: session.userDetails.name,
      policy_number: session.policyNumber
    };

    const extracted = await extractClaimFlexible(msg, defaults);
    session.claimData = extracted;

    const validation = validateClaimJS(extracted);

    // ❌ Future date invalid
    if (validation.errorMessage) {
      session.missingFields = ["incident_date"];
      session.state = "awaiting_missing";
      return validation.errorMessage +
        "\nExample: Incident Date: 10/10/2023";
    }

    const missing = validation.missing;
    session.missingFields = missing;

    if (missing.length === 0) {
      const claimId = await generateClaimId();
      session.lastClaimId = claimId;

      const allClaims = await loadClaims();
      allClaims.claims.push({
        claimId,
        ...extracted,
        createdAt: new Date().toISOString()
      });
      await saveClaims(allClaims);

      session.state = "done";

      return (
        formatSummary(extracted) +
        `\n\nYour Claim ID is: ${claimId}\n` +
        "Your claim has been recorded.\n" +
        "You may type \"retrieve claim\" anytime."
      );
    }

    // Missing fields exist → ask only for those
    session.state = "awaiting_missing";
   
    return (
      "Thank you! I still need:\n" +
     missing.map(f => '• ' + FIELD_LABELS[f]).join("\n") +
      "\nPlease provide these details."
    );
  }

  // STEP 4: MISSING FIELD LOOP
  if (session.state === "awaiting_missing") {
    const updated = await fillMissingAI(session.claimData, session.missingFields, msg);
    session.claimData = updated;

    const validation = validateClaimJS(updated);

    if (validation.errorMessage) {
      session.missingFields = ["incident_date"];
      return validation.errorMessage +
        "\nExample: Incident Date: 10/10/2023";
    }

    const missing = validation.missing;
    session.missingFields = missing;

    if (missing.length === 0) {
      const claimId = await generateClaimId();
      session.lastClaimId = claimId;

      const allClaims = await loadClaims();
      allClaims.claims.push({
        claimId,
        ...updated,
        createdAt: new Date().toISOString()
      });
      await saveClaims(allClaims);

      session.state = "done";

      return (
        formatSummary(updated) +
        `\n\nYour Claim ID is: ${claimId}\n` +
        "Your claim has been successfully recorded.\n" +
        "You may type \"retrieve claim\" anytime."
      );
    }

    return (
      "Still missing:\n" +
       missing.map(f => '• ' + FIELD_LABELS[f]).join("\n") +
      "\nPlease provide these details."
    );
  }

  // DONE STATES
  if (session.state === "done") {
    return (
      "Your claim is already recorded.\n" +
      "You may type \"retrieve claim\" or \"restart\"."
    );
  }

  if (session.state === "done_no_claim") {
    return (
      "We are not filing a claim.\n" +
      "Type \"restart\" to begin again or \"retrieve claim\" to look up existing claims."
    );
  }

  return "I'm not sure what you meant. Type \"restart\".";
}

// API ROUTE
app.post("/api/chat", async (req, res) => {
  try {
    let { message, sessionId } = req.body;
    if (!sessionId) sessionId = generateSessionId();

    const session = getSession(sessionId);
    const reply = await handleMessage(session, message);

    res.json({ sessionId, reply });

  } catch (err) {
    console.error("🔥 Server error:", err);
    res.status(500).json({ reply: "Internal server error." });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Backend running on port ${PORT}`));