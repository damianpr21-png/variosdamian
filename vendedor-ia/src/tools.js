// Herramientas que el vendedor IA puede usar. El precio y el total SIEMPRE los calcula el sistema.
import { db, getProduct, getOrder, updateOrder, updateConversation, getSettings, logEvent, now } from "./db.js";
import { sendToCustomer, notifyOwner } from "./outbound.js";

const obj = (properties, required = Object.keys(properties)) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

export const SELLER_TOOLS = [
  {
    name: "enviar_foto_producto",
    description: "Envía al cliente la foto de un producto del catálogo, con un texto corto. Úsala cuando muestre interés en un producto que tiene foto.",
    strict: true,
    input_schema: obj({
      product_id: { type: "integer", description: "ID del producto en el catálogo" },
      texto: { type: "string", description: "Texto corto que acompaña la foto (puede ir vacío)" },
    }),
  },
  {
    name: "crear_pedido",
    description: "Registra el pedido cuando el cliente ya decidió qué compra. Devuelve el número de pedido, el total calculado y los datos de pago que debes compartir.",
    strict: true,
    input_schema: obj({
      items: {
        type: "array",
        items: obj({
          product_id: { type: "integer" },
          cantidad: { type: "integer" },
          variante: { type: "string", description: "Talla, color, sabor, etc. Vacío si no aplica" },
        }),
      },
      cliente_nombre: { type: "string" },
      entrega: { type: "string", description: "Retiro en local o dirección/ciudad de envío, según lo que dijo el cliente" },
      notas: { type: "string" },
    }),
  },
  {
    name: "registrar_pago_reportado",
    description: "Registra que el cliente envió un comprobante de pago. Describe lo que ves en el comprobante. El equipo lo verificará.",
    strict: true,
    input_schema: obj({
      order_id: { type: "integer", description: "Número de pedido al que corresponde el pago" },
      monto_visto: { type: "number", description: "Monto que aparece en el comprobante (0 si no se ve)" },
      referencia: { type: "string", description: "Número de transacción/referencia si aparece" },
      banco_o_app: { type: "string", description: "Banco o app (Deuna, Pichincha, etc.)" },
      observaciones: { type: "string", description: "Cualquier cosa rara: monto distinto, fecha antigua, nombre de destinatario diferente, imagen borrosa" },
    }),
  },
  {
    name: "pasar_a_humano",
    description: "Pausa la IA en esta conversación y avisa al dueño para que atienda una persona.",
    strict: true,
    input_schema: obj({
      motivo: { type: "string", description: "Por qué necesita una persona, en una frase" },
      urgente: { type: "boolean" },
    }),
  },
  {
    name: "actualizar_cliente",
    description: "Guarda datos del cliente para el equipo: nombre, etapa de venta y notas (qué busca, talla, presupuesto, objeciones).",
    strict: true,
    input_schema: obj({
      nombre: { type: "string", description: "Vacío si no cambió" },
      etapa: { type: "string", enum: ["sin_cambio", "interesado", "pedido", "perdido"] },
      nota: { type: "string", description: "Nota breve para el equipo. Vacío si no hay" },
    }),
  },
  {
    name: "agendar_seguimiento",
    description: "Programa un mensaje de seguimiento si el cliente no responde. Úsala cuando diga 'lo pienso', 'después te aviso', 'cobro el viernes', etc.",
    strict: true,
    input_schema: obj({
      horas: { type: "number", description: "En cuántas horas escribirle (máximo 23 por las reglas de WhatsApp)" },
      motivo: { type: "string", description: "Qué retomar en el seguimiento" },
    }),
  },
];

const money = (n) => `$${Number(n).toFixed(2)}`;
const getConversationStage = (id) => db.prepare("SELECT etapa FROM conversations WHERE id = ?").get(id)?.etapa;

export async function runSellerTool(name, input, ctx) {
  const { conv } = ctx;
  switch (name) {
    case "enviar_foto_producto": {
      const p = getProduct(input.product_id);
      if (!p || !p.activo) return { error: "Ese producto no existe en el catálogo." };
      if (!p.imagen_url) return { error: "Ese producto no tiene foto cargada. Descríbelo con palabras." };
      await sendToCustomer(conv, { image_url: absoluteUrl(p.imagen_url), caption: input.texto || "" });
      ctx.sentSomething = true;
      return { ok: true, nota: "Foto enviada. No repitas el texto que ya acompañó la foto." };
    }

    case "crear_pedido": {
      if (!input.items?.length) return { error: "El pedido no tiene productos." };
      const lines = [];
      for (const it of input.items) {
        const p = getProduct(it.product_id);
        if (!p || !p.activo) return { error: `El producto ID ${it.product_id} no existe.` };
        const qty = Math.max(1, Math.floor(it.cantidad || 1));
        if (p.stock !== null && p.stock < qty) return { error: `${p.nombre}: solo hay ${p.stock} en stock. Ofrece otra cantidad o alternativa.` };
        lines.push({ product_id: p.id, nombre: p.nombre, variante: it.variante || "", cantidad: qty, precio: p.precio });
      }
      const total = Math.round(lines.reduce((s, l) => s + l.precio * l.cantidad, 0) * 100) / 100;
      // Si ya hay un pedido pendiente en esta conversación, se reemplaza (el cliente cambió de idea).
      db.prepare("UPDATE orders SET estado = 'cancelado', updated_at = datetime('now') WHERE conv_id = ? AND estado = 'pendiente_pago'").run(conv.id);
      const r = db.prepare("INSERT INTO orders(conv_id, items, total, cliente_nombre, entrega, notas) VALUES(?,?,?,?,?,?)")
        .run(conv.id, JSON.stringify(lines), total, input.cliente_nombre || conv.nombre || "", input.entrega || "", input.notas || "");
      const orderId = Number(r.lastInsertRowid);
      // Reservar stock
      for (const l of lines) db.prepare("UPDATE products SET stock = stock - ? WHERE id = ? AND stock IS NOT NULL").run(l.cantidad, l.product_id);
      updateConversation(conv.id, { etapa: "pedido", ...(input.cliente_nombre && !conv.nombre ? { nombre: input.cliente_nombre } : {}) });
      logEvent("pedido_creado", conv.id, { orderId, total });
      const pago = getSettings().negocio.metodos_pago?.trim();
      return {
        order_id: orderId,
        detalle: lines.map((l) => `${l.cantidad} x ${l.nombre}${l.variante ? ` (${l.variante})` : ""} — ${money(l.precio * l.cantidad)}`),
        total: money(total),
        datos_de_pago: pago || "No hay métodos de pago configurados: dile que un asesor le envía los datos y usa pasar_a_humano.",
        siguiente_paso: "Comparte el resumen, el total y los datos de pago; pide la foto del comprobante.",
      };
    }

    case "registrar_pago_reportado": {
      const o = getOrder(input.order_id);
      if (!o || o.conv_id !== conv.id) return { error: "No encuentro ese pedido en esta conversación." };
      if (o.estado === "pagado") return { ok: true, nota: "Ese pedido ya estaba pagado y confirmado." };
      const coincide = Math.abs(Number(input.monto_visto) - o.total) < 0.01;
      updateOrder(o.id, { estado: "por_verificar", pago_reportado: JSON.stringify({ ...input, coincide_monto: coincide, at: now() }) });
      logEvent("pago_reportado", conv.id, { orderId: o.id, coincide });
      await notifyOwner(
        "pago",
        conv,
        `💰 Pago reportado — Pedido #${o.id} por ${money(o.total)}. Comprobante: ${money(input.monto_visto)} ${input.banco_o_app || ""} ref ${input.referencia || "-"}.${coincide ? " ✅ Monto coincide." : " ⚠️ EL MONTO NO COINCIDE."}${input.observaciones ? ` Obs: ${input.observaciones}` : ""} Confírmalo en el panel.`
      );
      return {
        ok: true,
        monto_coincide: coincide,
        nota: coincide
          ? "Dile que recibiste el comprobante y que en breve le confirmas. No digas que está confirmado."
          : `El monto del comprobante (${money(input.monto_visto)}) no coincide con el total (${money(o.total)}). Pregunta amablemente por la diferencia.`,
      };
    }

    case "pasar_a_humano": {
      updateConversation(conv.id, { modo: "humano", motivo_humano: input.motivo });
      logEvent("pasado_a_humano", conv.id, input.motivo);
      await notifyOwner("humano", conv, `${input.urgente ? "🚨 URGENTE — " : ""}Un cliente necesita atención humana: ${input.motivo}`);
      ctx.handedOff = true;
      return { ok: true, nota: "La IA queda en pausa en este chat. Despídete con un mensaje corto diciendo que una persona del equipo le escribe enseguida." };
    }

    case "actualizar_cliente": {
      const fields = {};
      if (input.nombre?.trim()) fields.nombre = input.nombre.trim();
      const cur = getConversationStage(conv.id);
      const rank = { nuevo: 0, interesado: 1, pedido: 2, pagado: 3 };
      const downgrade = input.etapa === "interesado" && rank[cur] > 1;
      if (input.etapa && input.etapa !== "sin_cambio" && cur !== "pagado" && !downgrade) fields.etapa = input.etapa;
      if (input.nota?.trim()) fields.notas = [conv.notas, `• ${input.nota.trim()}`].filter(Boolean).join("\n").slice(-2000);
      updateConversation(conv.id, fields);
      Object.assign(conv, fields);
      return { ok: true };
    }

    case "agendar_seguimiento": {
      const horas = Math.min(23, Math.max(0.25, Number(input.horas) || 3));
      const at = new Date(Date.now() + horas * 3600_000).toISOString().replace("T", " ").slice(0, 19);
      updateConversation(conv.id, { next_followup_at: at, followup_motivo: input.motivo || "" });
      return { ok: true, programado_para: `${horas} horas` };
    }

    default:
      return { error: `Herramienta desconocida: ${name}` };
  }
}

export function absoluteUrl(url) {
  if (/^https?:\/\//.test(url)) return url;
  const base = (process.env.PUBLIC_URL || "").replace(/\/$/, "");
  return `${base}${url.startsWith("/") ? "" : "/"}${url}`;
}
