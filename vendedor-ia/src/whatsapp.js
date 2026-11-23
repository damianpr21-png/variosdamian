// Conexión con la API oficial de WhatsApp Business (Meta Cloud API).
import crypto from "node:crypto";

const GRAPH = `https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION || "v21.0"}`;
const TOKEN = () => process.env.WHATSAPP_TOKEN;
const PHONE_ID = () => process.env.WHATSAPP_PHONE_NUMBER_ID;

export const whatsappConfigured = () => Boolean(TOKEN() && PHONE_ID());

async function graph(pathname, body) {
  const res = await fetch(`${GRAPH}/${pathname}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${TOKEN()}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`WhatsApp API ${res.status}: ${JSON.stringify(data.error || data)}`);
  return data;
}

export const sendText = (to, text) =>
  graph(`${PHONE_ID()}/messages`, {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text, preview_url: true },
  });

export const sendImage = (to, link, caption = "") =>
  graph(`${PHONE_ID()}/messages`, {
    messaging_product: "whatsapp",
    to,
    type: "image",
    image: { link, ...(caption ? { caption } : {}) },
  });

export const markRead = (messageId) =>
  graph(`${PHONE_ID()}/messages`, { messaging_product: "whatsapp", status: "read", message_id: messageId }).catch(() => {});

// Descarga una imagen enviada por el cliente (comprobantes, fotos de referencia).
export async function downloadMedia(mediaId) {
  const meta = await graph(mediaId);
  const res = await fetch(meta.url, { headers: { Authorization: `Bearer ${TOKEN()}` } });
  if (!res.ok) throw new Error(`No se pudo descargar media ${mediaId}: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { base64: buf.toString("base64"), media_type: meta.mime_type?.split(";")[0] || "image/jpeg", buffer: buf };
}

// Verifica que el webhook realmente viene de Meta (si configuraste WHATSAPP_APP_SECRET).
export function validSignature(rawBody, header) {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) return true;
  if (!header) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  return expected.length === header.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(header));
}

// Convierte el payload del webhook en mensajes simples.
export function parseWebhook(body) {
  const out = [];
  for (const entry of body?.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const names = Object.fromEntries((value.contacts || []).map((c) => [c.wa_id, c.profile?.name || ""]));
      for (const m of value.messages || []) {
        const base = { id: m.id, from: m.from, name: names[m.from] || "", type: m.type };
        if (m.type === "text") out.push({ ...base, text: m.text?.body || "" });
        else if (m.type === "image") out.push({ ...base, text: m.image?.caption || "", mediaId: m.image?.id });
        else if (m.type === "document" && m.document?.mime_type === "application/pdf")
          out.push({ ...base, text: m.document?.caption || "", mediaId: m.document?.id, isPdf: true });
        else if (m.type === "button") out.push({ ...base, type: "text", text: m.button?.text || "" });
        else if (m.type === "interactive")
          out.push({ ...base, type: "text", text: m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || "" });
        else if (m.type === "location")
          out.push({ ...base, type: "text", text: `📍 Ubicación enviada: ${m.location?.name || ""} ${m.location?.address || ""} (https://maps.google.com/?q=${m.location?.latitude},${m.location?.longitude})` });
        else out.push(base); // audio, sticker, video, etc.
      }
    }
  }
  return out;
}
