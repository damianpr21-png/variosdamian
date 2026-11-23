// Cliente de Claude y parámetros comunes.
import Anthropic from "@anthropic-ai/sdk";

export const client = new Anthropic(); // usa ANTHROPIC_API_KEY del entorno
export const MODEL = process.env.IA_MODELO || "claude-opus-5-5";
// Esfuerzo bajo = respuestas rápidas y económicas, ideal para chat de ventas.
export const EFFORT = process.env.IA_ESFUERZO || "low";

// Si el modelo rechaza una solicitud por sus filtros de seguridad, la API reintenta
// automáticamente con el modelo de respaldo recomendado (solo modelos que lo admiten).
const SUPPORTS_FALLBACK = ["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-fable-5-2", "claude-fable-5-1"];
export function fallbackParams() {
  if (!SUPPORTS_FALLBACK.includes(MODEL) || process.env.IA_RESPALDO === "off") return {};
  return { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" };
}

export function textOf(content) {
  return content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}
