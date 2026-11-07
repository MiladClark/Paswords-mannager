import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { StartupShell } from "./branding/StartupShell";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <StartupShell>
      <App />
    </StartupShell>
  </React.StrictMode>,
);
