import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import { installStorageShim } from "./lib/storage.js";
import "./index.css";

// Provide window.storage before the app renders, since App.jsx calls it
// synchronously in a couple of places.
installStorageShim();

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
