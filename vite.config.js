import { defineConfig } from "vite";
// base задаётся при сборке для GitHub Pages: BASE=/moscow-reach/ npm run build
export default defineConfig({ base: process.env.BASE || "/", build: { target: "esnext" } });
