import React, { useState, useEffect, useRef } from "react";
import axios from "axios";
import "./ClaimGenie.css";

export default function ClaimGenie() {
    const [messages, setMessages] = useState([
        { sender: "bot", text: "Hi, I am ClaimGenie. Please enter your policy number." }
    ]);
    const [input, setInput] = useState("");
    const [sessionId, setSessionId] = useState(null);

    const chatEnd = useRef(null);

    useEffect(() => {
        chatEnd.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages]);

    async function sendMessage() {
        if (!input.trim()) return;

        setMessages(prev => [...prev, { sender: "user", text: input }]);

        const payload = {
            message: input,
            sessionId: sessionId
        };

        setInput("");

        try {
            const res = await axios.post("https://zany-engine-97w7wpjg94w93xgjj-5000.app.github.dev/api/chat", payload);
            const { reply, sessionId: returnedId } = res.data;

            if (!sessionId) setSessionId(returnedId);

            setMessages(prev => [...prev, { sender: "bot", text: reply }]);
        } catch (err) {
            setMessages(prev => [...prev, {
                sender: "bot",
                text: "Something went wrong."
            }]);
        }
    }

    return (
        <div className="chat-container">
            <div className="header">ClaimGenie</div>
            <div className="chat-body">
                {messages.map((msg, index) => (
                    <div key={index} className={`bubble ${msg.sender}`}>
                        {msg.text.split("\n").map((line, i) => (
                            <div key={i}>{line}</div>
                        ))}
                    </div>
                ))}
                <div ref={chatEnd}></div>
            </div>

            <div className="input-area">
                <input
                    className="chat-input"
                    value={input}
                    placeholder="Type a message..."
                    onChange={e => setInput(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && sendMessage()}
                />
                <button className="send-btn" onClick={sendMessage}>➤</button>
            </div>
        </div>
    );
}