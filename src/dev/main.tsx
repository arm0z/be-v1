import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@/globals.css";
import "dockview/dist/styles/dockview.css";
import App from "./App.tsx";

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
