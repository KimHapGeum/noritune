import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { TvView } from "./Tv";
import "./App.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {location.hash === "#tv" ? <TvView /> : <App />}
  </React.StrictMode>,
);
