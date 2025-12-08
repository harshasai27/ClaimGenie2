import { useState, useEffect, useRef } from "react";
import axios from "axios";
import "./ClaimGenie.css";

const API_URL = "https://zany-engine-97w7wpjg94w93xgjj-5000.app.github.dev/api/chat";

export default function ClaimGenie() {
  const [messages, setMessages] = useState([
    {
      from: "bot",
      text: "Hi, I am ClaimGenie. Please enter your policy number.",
    },
  ]);
  const [input, setInput] = useState("");
  const [sessionId, setSessionId] = useState(null);
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const sendMessage = async () => {
    if (!input.trim()) return;
    const text = input.trim();
    setInput("");

    setMessages((prev) => [...prev, { from: "user", text }]);

    try {
      const res = await axios.post(API_URL, {
        message: text,
        sessionId,
      });

      if (!sessionId) setSessionId(res.data.sessionId);

      setMessages((prev) => [...prev, { from: "bot", text: res.data.reply }]);
    } catch (err) {
      console.error(err);
      setMessages((prev) => [
        ...prev,
        {
          from: "bot",
          text: "Something went wrong while contacting the server. Please try again.",
        },
      ]);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <div className="cg-app">
      <div className="cg-chat-card">
        <div className="cg-header">ClaimGenie</div>

        <div className="cg-messages">
          {messages.map((m, idx) => (
            <div key={idx} className={`cg-bubble ${m.from}`}>
              {m.text}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        <div className="cg-input-row">
          <input
            className="cg-input"
            placeholder="Type a message..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <button className="cg-send-btn" onClick={sendMessage}>
            ▶
          </button>
        </div>
      </div>
    </div>
  );
}