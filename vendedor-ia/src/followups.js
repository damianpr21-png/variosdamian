// Seguimiento automático: ningún cliente se da por perdido sin intentarlo.
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { client, MODEL } from "./claude.js";
import { db, getSettings, getMessages, updateConversation, appendHistory, logEvent, now } from "./db.js";
import { sendToCustomer } from "./outbound.js";
import { localHour, ecuadorNow } from "./prompt.js";

const FollowUp = z.object({
  enviar: z.boolean().describe("false si no tiene sentido escribirle (ya compró, dijo que no, pidió que no le escriban)"),
  mensaje: z.string().describe("Mensaje de seguimiento, 1-2 frases, natural, sin presión"),
  marcar_perdido: z.boolean().describe("true si el cliente claramente no va a comprar"),
});

const HOURS_24 = 24 * 3600_000;
const toDate = (s) => (s ? new Date(s.replace(" ", "T") + "Z") : null);

export function startFollowUpScheduler() {
  setInterval(() => tick().catch((e) => console.error("[seguimiento]", e)), 60_000);
}

export async function tick() {
  const s = getSettings();
  if (!s.seguimiento.activo || !s.bot.activo) return;
  const h = localHour();
  if (h < s.seguimiento.hora_inicio || h >= s.seguimiento.hora_fin) return;

  const horas = (s.seguimiento.horas || []).map(Number).filter((x) => x > 0);
  const candidates = db.prepare(`
    SELECT * FROM conversations
    WHERE modo = 'ia' AND etapa IN ('interesado', 'pedido')
      AND last_bot_at IS NOT NULL AND last_customer_at IS NOT NULL
      AND last_bot_at >= last_customer_at
  `).all();

  for (const conv of candidates) {
    const lastCustomer = toDate(conv.last_customer_at);
    const lastBot = toDate(conv.last_bot_at);
    // WhatsApp solo permite mensajes libres hasta 24 h después del último mensaje del cliente.
    if (conv.canal === "whatsapp" && Date.now() - lastCustomer.getTime() > HOURS_24 - 10 * 60_000) continue;

    let due = false;
    if (conv.next_followup_at) due = toDate(conv.next_followup_at).getTime() <= Date.now();
    else if (conv.followups_sent < horas.length) due = Date.now() - lastCustomer.getTime() >= horas[conv.followups_sent] * 3600_000;
    if (!due || Date.now() - lastBot.getTime() < 30 * 60_000) continue;

    await sendFollowUp(conv);
  }
}

async function sendFollowUp(conv) {
  const transcript = getMessages(conv.id, 40)
    .map((m) => `${m.role === "cliente" ? "CLIENTE" : "VENDEDOR"}: ${m.text || "(imagen)"}`)
    .join("\n");
  const n = getSettings().negocio;
  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 2000,
    output_config: { effort: "low", format: zodOutputFormat(FollowUp) },
    system: `Eres ${n.nombre_vendedor || "Sofi"}, vendedora de "${n.nombre || "el negocio"}" por WhatsApp. Tono: ${n.tono}. Escribe un seguimiento para un cliente que dejó de responder. Retoma exactamente lo que estaba en curso (producto, talla, pedido pendiente de pago), aporta algo útil (resolver una duda, recordar la disponibilidad real) y termina con una pregunta fácil de responder. Nunca inventes descuentos ni urgencias falsas. Si ya enviaste un seguimiento antes, este debe ser distinto y más breve.`,
    messages: [{
      role: "user",
      content: `Ahora: ${ecuadorNow()}\nSeguimientos ya enviados: ${conv.followups_sent}\n${conv.followup_motivo ? `Motivo agendado: ${conv.followup_motivo}\n` : ""}Notas del cliente: ${conv.notas || "-"}\n\nConversación:\n${transcript}`,
    }],
  });
  const out = response.parsed_output;
  const fields = { followups_sent: conv.followups_sent + 1, next_followup_at: null, followup_motivo: "" };
  if (!out || !out.enviar || !out.mensaje.trim()) {
    if (out?.marcar_perdido) fields.etapa = "perdido";
    updateConversation(conv.id, { ...fields, followups_sent: 99 });
    return;
  }
  await sendToCustomer(conv, { text: out.mensaje.trim() });
  appendHistory(conv.id, { role: "assistant", content: [{ type: "text", text: out.mensaje.trim() }] });
  if (out.marcar_perdido) fields.etapa = "perdido";
  updateConversation(conv.id, fields);
  logEvent("seguimiento_enviado", conv.id, { n: fields.followups_sent, at: now() });
}
