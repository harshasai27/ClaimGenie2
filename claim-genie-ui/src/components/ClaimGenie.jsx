import React, { useState } from "react";
import axios from "axios";
import "./ClaimGenie.css";

function formatExtractedData(data) {
    if (!data) return "";

    const mapper = {
        claimant_name: "Claimant Name",
        policy_number: "Policy Number",
        claim_type: "Claim Type",
        incident_date: "Incident Date",
        incident_location: "Incident Location",
        claim_amount: "Claim Amount",
        service_provider: "Service Provider",
        description_of_loss: "Description of Loss"
    };

    return Object.keys(mapper)
        .map((key) => {
            const label = mapper[key];
            const value = data[key] ?? "Not Provided";
            return `• ${label}: ${value}`;
        })
        .join("\n");
}

function formatValidationSummary(validation) {
    if (!validation) return "";

    const { missingFields, invalidFields, summary } = validation;

    let output = "";

    // if (missingFields?.length > 0) {
    //     output += `⚠️ The following required fields are missing:\n`;
    //     missingFields.forEach((f) => {
    //         output += `   - ${f}\n`;
    //     });
    //     output += `\n`;
    // }

    // if (invalidFields?.length > 0) {
    //     output += `❌ Invalid field values detected:\n`;
    //     invalidFields.forEach((f) => {
    //         output += `   - ${f.field}: ${f.reason}\n`;
    //     });
    //     output += `\n`;
    // }

    output += `📄 Summary:\n${summary}`;

    return output;
}

export default function ClaimGenie() {
    const [text, setText] = useState("");
    const [extracted, setExtracted] = useState(null);
    const [validation, setValidation] = useState(null);
    const [loading, setLoading] = useState(false);

    const processClaim = async () => {
        setLoading(true);
        setExtracted(null);
        setValidation(null);

        try {
            const extractRes = await axios.post("https://zany-engine-97w7wpjg94w93xgjj-5000.app.github.dev/api/extract", {
                text,
            });
            const extractedData = extractRes.data.extracted;
            setExtracted(extractedData);

            const validateRes = await axios.post(
                "https://zany-engine-97w7wpjg94w93xgjj-5000.app.github.dev/api/validate",
                { extracted: extractedData }
            );
            setValidation(validateRes.data.validation);
        } catch (err) {
            console.error("Processing error:", err);
            alert("Error processing claim. Check server logs.");
        }

        setLoading(false);
    };

    return (
        <div>
            <h1 className="title">ClaimGenie</h1>
            <div className="claim-genie-container">
                <textarea
                    className="input-box"
                    placeholder="Paste claim description text here..."
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                />

                <button className="submit-btn" onClick={processClaim} disabled={loading}>
                    {loading ? "Processing..." : "Validate Claim"}
                </button>

                {extracted && (
                    <div className="section">
                        <h2 className="section-title">Claim Details</h2>
                        <pre className="summary-box">
                            {formatExtractedData(extracted)}
                        </pre>
                    </div>
                )}

                {validation && (
                    <div className="section">
                        <h2 className="section-title">Summary</h2>
                        <pre className="summary-box">
                            {formatValidationSummary(validation)}
                        </pre>
                    </div>
                )}
            </div>
        </div>

    );
}