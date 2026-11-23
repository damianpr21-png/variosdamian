// Motor del vendedor IA: recibe mensajes, agrupa ráfagas, conversa con Claude y ejecuta herramientas.
import Anthropic from "@anthropic-ai/sdk";
import { client, MODEL, EFFORT, fallbackParams, textOf } from "./claude.js";
import { SELLER_TOOLS, runSellerTool } from "./tools.js";
import { buildSystemPrompt, ecuadorNow } from "./prompt.js";
import { sendToCustomer, notifyOwner } from "./outbound.js";
import {
  getOrCreateConversation, getConversation, updateConversation, addMessage, getHistory, appendHistory,
  getSettings, logEvent, now,
} from "./db.js";

const MAX_STEPS = 8;
const pending = new Map(); // conv_id -> { items: [], timer }
const running = new Set();

/**
 * Punto de entrada para cualquier mensaje entrante.
 * @param {{phone:string, name?:string, canal?:string, text?:string, images?:{base64:string, media_type:string}[], pdfs?:{base64:string}[], type?:string, mediaUrl?:string}} msg
 */
export function receiveMessage(msg) {
  const conv = getOrCreateConversation(msg.phone, msg.name || "", msg.canal || "whatsapp");
  const settings = getSettings();
  const label = msg.text || (msg.images?.length ? "📷 Imagen" : msg.pdfs?.length ? "📄 PDF" : `[${msg.type || "mensaje"}]`);
  addMessage(conv.id, "cliente", label, msg.mediaUrl || "");
  updateConversation(conv.id, {
    last_customer_at: now(),
    unread: conv.unread + 1,
    followups_sent: 0,          // el cliente respondió: se reinicia el seguimiento
    next_followup_at: null,
    ...(conv.etapa === "nuevo" ? { etapa: "interesado" } : {}),
    ...(conv.etapa === "perdido" ? { etapa: "interesado" } : {}),
  });

  if (conv.modo !== "ia" || !settings.bot.activo) return; // lo atiende una persona

  // Audios, stickers, videos: la IA no los puede ver/escuchar, pero responde con naturalidad dentro de la misma conversación.
  if (!msg.text && !msg.images?.length && !msg.pdfs?.length) {
    const tipo = { audio: "una nota de voz", sticker: "un sticker", video: "un video", contacts: "un contacto" }[msg.type] || "un archivo";
    msg = {
      ...msg,
      text: `[El cliente envió ${tipo}, que no puedes ver ni escuchar.${msg.type === "audio" ? ` Pídele que lo escriba, con un mensaje parecido a: "${settings.bot.mensaje_audio}"` : msg.type === "sticker" ? " Tómalo como una reacción y sigue la conversación con naturalidad." : " Pídele amablemente que te lo cuente por escrito."}]`,
    };
  }

  const entry = pending.get(conv.id) || { items: [], timer: null };
  entry.items.push(msg);
  clearTimeout(entry.timer);
  const wait = (msg.canal === "simulador" ? 1.5 : Number(settings.bot.agrupar_mensajes_segundos) || 0) * 1000;
  entry.timer = setTimeout(() => flush(conv.id), wait);
  pending.set(conv.id, entry);
}

async function flush(convId) {
  if (running.has(convId)) {
    // Ya está respondiendo; se procesa al terminar.
    const entry = pending.get(convId);
    if (entry) entry.timer = setTimeout(() => flush(convId), 1000);
    return;
  }
  const entry = pending.get(convId);
  pending.delete(convId);
  if (!entry?.items.length) return;
  running.add(convId);
  const started = Date.now();
  try {
    await respond(convId, entry.items);
    logEvent("respuesta_ia", convId, { ms: Date.now() - started });
  } catch (err) {
    console.error(`[conv ${convId}] error:`, err);
    const conv = getConversation(convId);
    if (conv) {
      updateConversation(convId, { modo: "humano", motivo_humano: "Error técnico de la IA" });
      await notifyOwner("error", conv, `⚠️ La IA tuvo un error en un chat y lo pasó a modo humano: ${err.message?.slice(0, 200)}`);
      await sendToCustomer(conv, { text: "Dame un momentito, ya te atiendo 🙌" }).catch(() => {});
    }
  } finally {
    running.delete(convId);
  }
}

function buildUserContent(items) {
  /** @type {Anthropic.Beta.BetaContentBlockParam[]} */
  const content = [{ type: "text", text: `[Fecha y hora: ${ecuadorNow()}]` }];
  for (const m of items) {
    for (const img of m.images || []) content.push({ type: "image", source: { type: "base64", media_type: img.media_type, data: img.base64 } });
    for (const pdf of m.pdfs || []) content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf.base64 } });
    if (m.text) content.push({ type: "text", text: m.text });
    else if (m.images?.length || m.pdfs?.length) content.push({ type: "text", text: "(El cliente envió este archivo sin texto)" });
  }
  return content;
}

async function respond(convId, items) {
  let conv = getConversation(convId);
  const ctx = { conv, handedOff: false, sentSomething: false };
  // Si una ejecución anterior se cortó a mitad de una herramienta, se cierra ese paso para que el historial sea válido.
  const last = getHistory(convId).at(-1);
  const orphan = last?.role === "assistant" && Array.isArray(last.content) ? last.content.filter((b) => b.type === "tool_use") : [];
  if (orphan.length) {
    appendHistory(convId, {
      role: "user",
      content: orphan.map((b) => ({ type: "tool_result", tool_use_id: b.id, content: '{"error":"interrumpido"}', is_error: true })),
    });
  }
  appendHistory(convId, { role: "user", content: buildUserContent(items) });

  const system = [{ type: "text", text: buildSystemPrompt(), cache_control: { type: "ephemeral" } }];

  for (let step = 0; step < MAX_STEPS; step++) {
    const messages = getHistory(convId);
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 4000,
      output_config: { effort: EFFORT },
      cache_control: { type: "ephemeral" }, // cachea también la conversación
      system,
      tools: SELLER_TOOLS,
      messages,
      ...fallbackParams(),
    });

    if (response.stop_reason === "refusal") {
      updateConversation(convId, { modo: "humano", motivo_humano: "La IA no pudo responder este mensaje" });
      await notifyOwner("humano", conv, "La IA no pudo responder un mensaje y pasó el chat a modo humano.");
      await sendToCustomer(conv, { text: "Te paso con una persona del equipo para ayudarte mejor 🙌" });
      return;
    }

    // Guardamos la respuesta completa (incluye bloques internos) sin modificarla.
    appendHistory(convId, { role: "assistant", content: response.content });

    const text = textOf(response.content);
    if (text) {
      for (const part of splitForWhatsApp(text)) await sendToCustomer(conv, { text: part });
      ctx.sentSomething = true;
    }

    if (response.stop_reason === "max_tokens") break;
    if (response.stop_reason === "pause_turn") continue;
    if (response.stop_reason !== "tool_use") break;

    const toolUses = response.content.filter((b) => b.type === "tool_use");
    const results = [];
    for (const tu of toolUses) {
      let out;
      try {
        out = await runSellerTool(tu.name, tu.input, ctx);
      } catch (e) {
        out = { error: e.message };
      }
      logEvent("herramienta", convId, { tool: tu.name });
      results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(out), ...(out?.error ? { is_error: true } : {}) });
    }
    appendHistory(convId, { role: "user", content: results });
    conv = getConversation(convId);
    ctx.conv = conv;
  }
}

// WhatsApp se lee mejor en mensajes cortos: separa por párrafos (máximo 3 burbujas).
function splitForWhatsApp(text) {
  const parts = text.replace(/\*\*(.+?)\*\*/g, "*$1*").split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  if (parts.length <= 3) return parts;
  return [parts[0], parts[1], parts.slice(2).join("\n\n")];
}

// Cuando una persona del equipo escribe desde el panel, la IA lo registra para tener contexto si retoma.
export function recordHumanReply(convId, text) {
  appendHistory(convId, { role: "assistant", content: [{ type: "text", text: `[Mensaje enviado por una persona del equipo]: ${text}` }] });
}
