import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base relativa: funciona en la raíz (localhost) y en subcarpetas (GitHub Pages /pulsera/)
export default defineConfig({ base: "./", plugins: [react()] });
