import { useNavigate } from "react-router-dom";
import "./Home.css";

export default function Home() {
    const navigate = useNavigate();

    return (
        <div className="home-container">
            <div className="home-content">
                <div className="left-section">
                    <h1 className="main-title">CLAIMGENIE</h1>
                    <p className="subtitle">
                        Your AI-powered insurance assistant.
                        Fast, friendly and accurate claim handling.
                    </p>
                    <button
                        className="start-btn"
                        onClick={() => navigate("/chat")}
                    >
                        Get Started
                    </button>
                </div>
            </div>
        </div>
    );
}