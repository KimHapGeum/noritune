import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import Boot from "./Boot";
import { TvView } from "./Tv";
import "./App.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {location.hash === "#tv" ? <TvView /> : <Boot><App /></Boot>}
  </React.StrictMode>,
);
