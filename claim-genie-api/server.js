// ClaimGenie Chatbot - FINAL WORKING BACKEND (Manual JSON Parser + Intelligent Extraction)
// ---------------------------------------------------------------------------------------

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
  console.error("❌ Missing OPENAI_API_KEY in .env");
  process.exit(1);
}

const sessions = {};

function newSession() {
  return {
    state: "awaiting_policy_number",
    policyNumber: null,
    userDetails: null,
    extracted: null,
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

const mockPolicyData = {
  name: "Policy Holder",
  policyType: "Motor Insurance",
  validTill: "2030-01-01",
};


function formatSummary(data) {
  const labels = {
    claimant_name: "Claimant Name",
    policy_number: "Policy Number",
    claim_type: "Claim Type",
    incident_date: "Incident Date",
    incident_location: "Incident Location",
    claim_amount: "Claim Amount",
    service_provider: "Service Provider",
    description_of_loss: "Description of Loss",
  };

  return Object.keys(labels)
    .map((key) => `${labels[key]}: ${data[key] ?? "Not Provided"}`)
    .join("\n");
}


function safeParseJSON(message) {
  if (!message) return null;

  if (message.parsed) {
    return message.parsed;
  }

  if (message.content) {
    try {
      const txt = message.content
        .replace(/```json/gi, "")
        .replace(/```/g, "")
        .trim();
      return JSON.parse(txt);
    } catch (e) {
      console.log("Could not parse message.content manually");
    }
  }

  return null;
}

async function extractClaim(text) {
  try {
    const completion = await client.chat.completions.create({
      model: "gpt-4.1-mini", 
      temperature: 0.1,
      max_tokens: 400,
      messages: [
        {
          role: "system",
          content: `
You are an insurance claims extraction engine.
Always return ONLY a valid JSON object. No explanations.
Infer missing values intelligently.
`
        },
        {
          role: "user",
          content: `
Extract the claim information using exactly this structure:

{
  "claimant_name": "",
  "policy_number": "",
  "claim_type": "",
  "incident_date": "",
  "incident_location": "",
  "claim_amount": "",
  "service_provider": "",
  "description_of_loss": ""
}

Rules:
- Infer claim_type from context (bike accident → motor).
- Convert amounts like "10k", "5000 rupees", "five thousand" → number.
- Accept ANY date format.
- Convert "garage/workshop/mechanic" → service_provider.
- Summarize the damage in 1 line.

Text:
"${text}"

Return ONLY THE JSON OBJECT.
`
        }
      ]
    });

    const parsed = safeParseJSON(completion.choices[0].message);

    if (!parsed) {
      console.log("⚠️ Extraction fallback triggered");
      return {
        claimant_name: null,
        policy_number: null,
        claim_type: null,
        incident_date: null,
        incident_location: null,
        claim_amount: null,
        service_provider: null,
        description_of_loss: null
      };
    }

    return parsed;

  } catch (err) {
    console.error("🔥 extractClaim failed:", err.message);

    return {
      claimant_name: null,
      policy_number: null,
      claim_type: null,
      incident_date: null,
      incident_location: null,
      claim_amount: null,
      service_provider: null,
      description_of_loss: null
    };
  }
}

async function validateClaim(extracted) {
  try {
    // Determine missing fields directly
    const required = [
      "claimant_name",
      "policy_number",
      "claim_type",
      "incident_date",
      "incident_location",
      "claim_amount",
      "service_provider",
      "description_of_loss"
    ];

    const missing = required.filter(f => !extracted[f]);

    return {
      validFields: required.filter(f => extracted[f]),
      missingFields: missing,
      cleanedData: extracted   // NEVER override extracted values
    };

  } catch (err) {
    console.error("🔥 validateClaim() failed:", err.message);

    const required = [
      "claimant_name",
      "policy_number",
      "claim_type",
      "incident_date",
      "incident_location",
      "claim_amount",
      "service_provider",
      "description_of_loss"
    ];

    return {
      validFields: required.filter(f => extracted[f]),
      missingFields: required.filter(f => !extracted[f]),
      cleanedData: extracted
    };
  }
}


async function fillMissingFields(extracted, missingFields, userMsg) {
  try {
    const completion = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "user",
          content: `
Fill ONLY the missing fields:

Missing:
${JSON.stringify(missingFields)}

Current JSON:
${JSON.stringify(extracted, null, 2)}

User text:
"${userMsg}"

Return updated JSON only.
`
        }
      ]
    });

    const parsed = safeParseJSON(completion.choices[0].message);

    if (!parsed) return extracted;
    return parsed;

  } catch (err) {
    console.error("🔥 fillMissingFields failed:", err.message);
    return extracted;
  }
}


async function handleMessage(session, message) {
  const msg = message.trim();

  if (/^(restart|reset)$/i.test(msg)) {
    Object.assign(session, newSession());
    return "Conversation restarted.\nPlease enter your policy number.";
  }

  if (session.state === "awaiting_policy_number") {
    session.policyNumber = msg;

    session.userDetails = {
      ...mockPolicyData,
      policyNumber: msg
    };

    session.state = "confirm_new_claim";

    return (
      `Here are your policy details:\n` +
      `Name: ${session.userDetails.name}\n` +
      `Policy Type: ${session.userDetails.policyType}\n` +
      `Policy Number: ${session.policyNumber}\n` +
      `Valid Till: ${session.userDetails.validTill}\n\n` +
      `Would you like to file a new claim? (yes/no)`
    );
  }

  if (session.state === "confirm_new_claim") {
    if (msg.toLowerCase().startsWith("y")) {
      session.state = "awaiting_incident_text";
      return "Please describe the incident in one message.";
    }
    if (msg.toLowerCase().startsWith("n")) {
      return "Okay. Type restart anytime.";
    }
    return "Please answer yes or no.";
  }

  if (session.state === "awaiting_incident_text") {
    const extracted = await extractClaim(msg);

    extracted.claimant_name =
      extracted.claimant_name || session.userDetails.name;

    extracted.policy_number =
      extracted.policy_number || session.policyNumber;

    session.extracted = extracted;

    const validation = await validateClaim(extracted);
    session.missingFields = validation.missingFields;

    if (session.missingFields.length === 0) {
      session.state = "done";
      return (
        formatSummary(validation.cleanedData) +
        "\n\nThank you! Please wait for further communication."
      );
    }

    session.state = "awaiting_missing_fields";
    return `I still need the following fields:\n${session.missingFields.join(
      ", "
    )}\n\nPlease provide them in one message.`;
  }

  if (session.state === "awaiting_missing_fields") {
    const updated = await fillMissingFields(
      session.extracted,
      session.missingFields,
      msg
    );

    session.extracted = updated;

    const validation = await validateClaim(updated);
    session.missingFields = validation.missingFields;

    if (session.missingFields.length === 0) {
      session.state = "done";
      return (
        formatSummary(validation.cleanedData) +
        "\n\nThank you! Please wait for further communication."
      );
    }

    return (
      `Thank you. Still missing: ${session.missingFields.join(
        ", "
      )}\n\nPlease provide them in one message.`
    );
  }

  return "Your claim is complete. Type restart to begin again.";
}


app.post("/api/chat", async (req, res) => {
  try {
    let { message, sessionId } = req.body;
    if (!sessionId) sessionId = generateSessionId();

    const session = getSession(sessionId);
    const reply = await handleMessage(session, message);

    res.json({ sessionId, reply });

  } catch (err) {
    console.error("🔥 Chat handler error:", err);
    res.status(500).json({ reply: "Internal server error" });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`ClaimGenie backend running at ${PORT}`);
});
