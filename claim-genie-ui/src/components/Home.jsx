import { useNavigate } from "react-router-dom";
import "./Home.css";

export default function Home() {
    const navigate = useNavigate();

    return (
        <div className="home-container">
            <div className="home-content">
                <div className="left-section fade-in-up" >
                    <h1 className="main-title">CLAIMGENIE</h1>
                    <p className="subtitle">
                        Your <b>AI-powered</b> insurance assistant
                        Fast, friendly and accurate claim handling.
                    </p>
                    <button
                        className="start-btn"
                        onClick={() => navigate("/chat")}
                    >
                        Get Started
                    </button>
                 
        <div className="features">
<span className="feature-item">⚡ Fast</span>
<span className="feature-item">🔒 Secure</span>
<span className="feature-item">🤖 AI-Powered</span>
</div>
                </div>




                <div className="right-section fade-in-up delay-1">
<div className="chat-preview">
<div className="chat bot">
<span>🤖</span>
<p>Hi! I’ll help you file your claim.</p>
</div>
<div className="chat user">
<span>👤</span>
<p>My car met with an accident</p>
</div>
<div className="chat bot typing">
<span>🤖</span>
<p>Analyzing details…</p>
</div>
</div>
</div>
 
            </div>

            <div className="footer">
 © {new Date().getFullYear()} ClaimGenie • Powered by GenAI
</div>
        </div>
    );
}