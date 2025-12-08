import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();
app.use(cors());
app.use(express.json());

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

if (!process.env.OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY in .env");
  process.exit(1);
}

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


const sessions = {};

function newSession() {
  return {
    state: "awaiting_policy_number",
    policyNumber: null,
    userDetails: null,
    claimData: {},
    missingFields: [],
  };
}

function getSession(id) {
  if (!sessions[id]) sessions[id] = newSession();
  return sessions[id];
}

function generateSessionId() {
  return Math.random().toString(36).slice(2);
}

const mockPolicyData = {
  name: "Policy Holder",
  policyType: "Motor Insurance",
  validTill: "2030-01-01",
};


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

function validateClaimJS(data) {
  const missing = REQUIRED_FIELDS.filter((f) => !data[f]);
  return { missing, cleaned: data };
}

function formatSummary(data) {
  return REQUIRED_FIELDS
    .map((f) => `${FIELD_LABELS[f]}: ${data[f] ?? "Not Provided"}`)
    .join("\n");
}

async function extractClaimFlexible(text, defaults = {}) {
  try {
    const completion = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content: `
You extract claim fields from flexible user input. User may:
- describe incident in a paragraph
- use labels like "Claimant Name:", "Incident Date - 10/10/2025"
- mix labels & natural language

Return ONLY JSON with keys:

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

Infer values where possible. If unknown, use null.
`
        },
        {
          role: "user",
          content: text,
        },
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
- Return FULL JSON with all 8 keys.
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

Update only clearly provided missing fields. Return ONLY the full JSON object.
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


async function handleMessage(session, message) {
  const msg = message.trim();

  if (/^(restart|reset)$/i.test(msg)) {
    Object.assign(session, newSession());
    return "Conversation restarted.\nPlease enter your Policy Number.";
  }

  if (session.state === "awaiting_policy_number") {
    session.policyNumber = msg;
    session.userDetails = {
      ...mockPolicyData,
      policyNumber: msg,
    };
    session.state = "confirm_new_claim";

    return (
      `Thank you! Here are your policy details:\n` +
      `Name: ${session.userDetails.name}\n` +
      `Policy Type: ${session.userDetails.policyType}\n` +
      `Policy Number: ${session.policyNumber}\n` +
      `Valid Till: ${session.userDetails.validTill}\n\n` +
      `Would you like to file a new claim? (yes/no)`
    );
  }

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
        "Incident Location:\n" +
        "Claim Type: \n" +
        "Claim Amount:\n" +
        "Service Provider: \n" +
        "Description of Loss: \n\n" +
        "I will extract the required details automatically."
      );
    }
    if (lower.startsWith("n")) {
      session.state = "done_no_claim";
      return "Okay, I will not file a new claim. If you change your mind, type 'restart' to begin again.";
    }
    return "Please answer 'yes' or 'no'.";
  }

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
      session.state = "done";
      return (
        formatSummary(claimData) +
        "\n\nThank you! Your claim has been recorded. Please wait for further communication."
      );
    }

    session.state = "awaiting_missing";

    return (
      `Thank you! I captured most of your details.\n\n` +
      `However, I still need:\n` +
      `${missing.map((f) => FIELD_LABELS[f]).join(", ")}\n\n` +
      `Please provide these missing details in one message. For example:\n` +
      missing.map((f) => `${FIELD_LABELS[f]}: `).join("\n")
    );
  }

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
      session.state = "done";
      return (
        formatSummary(updated) +
        "\n\nThank you! Your claim has been recorded. Please wait for further communication."
      );
    }

    return (
      `Thanks! I still don't have complete information.\n\n` +
      `Still missing:\n` +
      `${missing.map((f) => FIELD_LABELS[f]).join(", ")}\n\n` +
      `Please provide only these remaining details in your next message.`
    );
  }

  if (session.state === "done_no_claim") {
    return "We are not filing a claim right now. Type 'restart' if you want to start again.";
  }

  if (session.state === "done") {
    return "Your claim has already been recorded. Type 'restart' to file another claim.";
  }

  return "I'm not sure what to do. Please type 'restart' to start over.";
}


app.post("/api/chat", async (req, res) => {
  try {
    let { message, sessionId } = req.body;
    if (!sessionId) sessionId = generateSessionId();

    const session = getSession(sessionId);
    const reply = await handleMessage(session, message);

    res.json({ sessionId, reply });
  } catch (err) {
    console.error("API error:", err);
    res.status(500).json({ reply: "Internal server error" });
  }
});


const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(` ClaimGenie API running at port ${PORT}`);
});