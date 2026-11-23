// Envío de mensajes al cliente (WhatsApp o simulador) y avisos al dueño.
import { addMessage, updateConversation, getSettings, addAlert, now } from "./db.js";
import * as wa from "./whatsapp.js";

export async function sendToCustomer(conv, { text, image_url, caption }, role = "ia") {
  if (conv.canal === "whatsapp" && wa.whatsappConfigured()) {
    if (image_url) await wa.sendImage(conv.phone, image_url, caption || "");
    else await wa.sendText(conv.phone, text);
  }
  addMessage(conv.id, role, image_url ? caption || "" : text, image_url || "");
  updateConversation(conv.id, { last_bot_at: now() });
}

// Alerta en el panel + WhatsApp al dueño (si configuró su número).
export async function notifyOwner(type, conv, text) {
  addAlert(type, conv?.id ?? null, text);
  const ownerPhone = getSettings()["dueño"].whatsapp?.replace(/\D/g, "");
  if (!ownerPhone || !wa.whatsappConfigured() || ownerPhone === conv?.phone) return;
  const who = conv ? `${conv.nombre || "Cliente"} (+${conv.phone})` : "";
  try {
    await wa.sendText(ownerPhone, `🔔 ${text}${who ? `\n👤 ${who}` : ""}`);
  } catch (e) {
    // Fuera de la ventana de 24 h WhatsApp exige plantilla; el aviso queda en el panel igual.
    console.warn("[aviso dueño] no enviado por WhatsApp:", e.message);
  }
}
