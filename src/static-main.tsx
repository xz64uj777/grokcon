import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MineScreen } from "@/components/mine-screen";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Ridge Ore root element is missing");

createRoot(root).render(
  <StrictMode>
    <MineScreen />
  </StrictMode>,
);
