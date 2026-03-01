import "@/globals.css";
import "dockview/dist/styles/dockview.css";
import "./dev.css";

import App from "./App.tsx";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <App />
    </StrictMode>,
);
