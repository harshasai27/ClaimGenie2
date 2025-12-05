
import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import OpenAI from "openai";

const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

if (!process.env.OPENAI_API_KEY) {
    console.error("❌ ERROR: OPENAI_API_KEY is missing in .env");
    process.exit(1);
}

const claimSchema = {
    fields: {
        claimant_name: { required: true, type: "string" },
        policy_number: { required: true, type: "string" },
        claim_type: {
            required: true,
            type: "enum",
            values: ["motor", "health", "life", "property", "other"]
        },
        incident_date: { required: true, type: "date", format: "MM/DD/YYYY" },
        incident_location: { required: true, type: "string" },
        claim_amount: { required: true, type: "number" },
        service_provider: {
            required: true,
            type: "enum",
            values: ["garage", "hospital", "shop"]
        },
        description_of_loss: { required: true, type: "string" }
    }
};

async function extractFromText(text) {
    const prompt = `
    Extract the following fields from the user's unstructured claim text:
    Mandatory Fields:
    - claimant_name
    - policy_number
    - claim_type (motor, health, life, property, other)
    - incident_date (MM/DD/YYYY)
    - incident_location
    - claim_amount (Number)
    - service_provider (garage, hospital, shop)
    - description_of_loss

    If a field is missing, return null.
    Return STRICT JSON with ALL fields included.

    User Text: """${text}"""
    `;

    const res = await client.chat.completions.create({
        model: "gpt-4o-mini",
        response_format:{type:"json_object"},
        messages: [{ role: "user", content: prompt }]
    });

    return JSON.parse(res.choices[0].message.content);
}


async function validateClaimData(extracted) {
    const prompt = `
    Validate the extracted claim JSON against this schema:
    SCHEMA: ${JSON.stringify(claimSchema, null, 2)}
    EXTRACTED JSON: ${JSON.stringify(extracted, null, 2)}
    TASK:
    1. Identify missing fields.
    2. Identify invalid fields (invalid enum, bad date format, not a number).
    3. Identify valid fields.
    4. Fix fields where possible (e.g., convert date format).
    5. Return ONLY THIS JSON STRUCTURE:
    {
        "validFields": [],
        "missingFields": [],
        "invalidFields": [],
        "cleanedData": {},
        "summary": "text summary"
    }
    always give names of fields which are missing and "summary" by keeping end user in the mind, do not include any technical details in it.
    `;

    const res = await client.chat.completions.create({
        model: "gpt-4o-mini",
        response_format:{type:"json_object"},
        messages: [{ role: "user", content: prompt }]
    });

    return JSON.parse(res.choices[0].message.content);
}

const app = express();
app.use(cors());
app.use(express.json());

app.post("/api/extract", async (req, res) => {
    try {
        const extracted = await extractFromText(req.body.text);
        res.json({ success: true, extracted });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post("/api/validate", async (req, res) => {
    try {
        const validation = await validateClaimData(req.body.extracted);
        res.json({ success: true, validation });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () =>
    console.log(`🚀 Claim Genie API running at ${PORT}`)
);