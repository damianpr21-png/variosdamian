// Servidor principal: webhook de WhatsApp + panel del dueño + API.
import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  db, getSettings, saveSettings, listProducts, upsertProduct, deleteProduct, getConversation, updateConversation,
  getMessages, ordersForConv, getOrder, updateOrder, appendHistory, resetConversation, logEvent,
} from "./db.js";
import { receiveMessage, recordHumanReply } from "./agent.js";
import { sendToCustomer } from "./outbound.js";
import { setupChat, setupTranscript, resetSetup } from "./setup-assistant.js";
import { startFollowUpScheduler } from "./followups.js";
import * as wa from "./whatsapp.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, "..", "public");
const DATA_DIR = process.env.DATA_DIR || "./data";
const UPLOADS = path.join(DATA_DIR, "uploads"); // fotos de productos (públicas, WhatsApp las descarga)
const MEDIA = path.join(DATA_DIR, "media");     // archivos de clientes (privados, solo panel)
fs.mkdirSync(UPLOADS, { recursive: true });
fs.mkdirSync(MEDIA, { recursive: true });

const app = express();
app.disable("x-powered-by");

// ---------------- Públicos ----------------
app.get("/health", (_req, res) => res.json({ ok: true }));
app.use("/uploads", express.static(UPLOADS, { maxAge: "7d" }));

// Verificación del webhook (Meta la llama una vez al configurarlo)
app.get("/webhook", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(req.query["hub.challenge"]);
  }
  res.sendStatus(403);
});

app.post("/webhook", express.raw({ type: "*/*", limit: "5mb" }), async (req, res) => {
  if (!wa.validSignature(req.body, req.get("x-hub-signature-256"))) return res.sendStatus(401);
  res.sendStatus(200); // Meta exige respuesta rápida; procesamos después
  let body;
  try {
    body = JSON.parse(req.body.toString("utf8"));
  } catch {
    return;
  }
  for (const m of wa.parseWebhook(body)) {
    try {
      if (seen(m.id)) continue;
      wa.markRead(m.id);
      const msg = { phone: m.from, name: m.name, canal: "whatsapp", text: m.text || "", type: m.type };
      if (m.mediaId) {
        const media = await wa.downloadMedia(m.mediaId);
        const ext = m.isPdf ? "pdf" : (media.media_type.split("/")[1] || "jpg");
        const file = `${crypto.randomUUID()}.${ext}`;
        fs.writeFileSync(path.join(MEDIA, file), media.buffer);
        msg.mediaUrl = `/media/${file}`;
        if (m.isPdf) msg.pdfs = [{ base64: media.base64 }];
        else msg.images = [{ base64: media.base64, media_type: media.media_type }];
      }
      receiveMessage(msg);
    } catch (e) {
      console.error("[webhook]", e);
    }
  }
});

// Meta a veces reenvía el mismo mensaje: evitamos responder dos veces.
const recent = new Map();
function seen(id) {
  if (!id) return false;
  if (recent.has(id)) return true;
  recent.set(id, Date.now());
  if (recent.size > 5000) for (const [k, t] of recent) if (Date.now() - t > 3600_000) recent.delete(k);
  return false;
}

// ---------------- Panel (protegido con contraseña) ----------------
function auth(req, res, next) {
  const pass = process.env.PANEL_PASSWORD;
  if (!pass) return next();
  const [type, value] = (req.get("authorization") || "").split(" ");
  if (type === "Basic" && value) {
    const [, given] = Buffer.from(value, "base64").toString().split(/:(.*)/s);
    if (given && given.length === pass.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(pass))) return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="Vendedor IA"').status(401).send("Ingresa la contraseña del panel");
}
app.use(auth);
app.use(express.json({ limit: "25mb" }));
app.use("/media", express.static(MEDIA));
app.use(express.static(PUBLIC_DIR));

const api = express.Router();
app.use("/api", api);
const h = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error(e);
  res.status(400).json({ error: e.message });
});

// Archivos enviados desde el panel como dataURL → { base64, media_type }
function parseDataUrl(dataUrl) {
  const m = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl || "");
  if (!m) return null;
  return { media_type: m[1], base64: m[2] };
}
function saveFile(dir, file) {
  const ext = file.media_type === "application/pdf" ? "pdf" : file.media_type.split("/")[1]?.replace("jpeg", "jpg") || "bin";
  const name = `${crypto.randomUUID()}.${ext}`;
  fs.writeFileSync(path.join(dir, name), Buffer.from(file.base64, "base64"));
  return name;
}

// ---- Estado ----
api.get("/status", (req, res) => {
  const base = process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`;
  res.json({
    claude: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
    whatsapp: wa.whatsappConfigured(),
    verify_token: Boolean(process.env.WHATSAPP_VERIFY_TOKEN),
    webhook_url: `${base.replace(/\/$/, "")}/webhook`,
    public_url: Boolean(process.env.PUBLIC_URL),
    productos: listProducts(true).length,
    pagos_configurados: Boolean(getSettings().negocio.metodos_pago?.trim()),
  });
});

// ---- Métricas ----
api.get("/dashboard", (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 7));
  const since = `datetime('now', '-${days} days')`;
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  // Las conversaciones del simulador no cuentan en las métricas reales.
  const REAL = "conv_id IN (SELECT id FROM conversations WHERE canal != 'simulador')";
  const convs = one(`SELECT COUNT(*) n FROM conversations WHERE canal != 'simulador' AND created_at >= ${since}`).n;
  const pedidos = one(`SELECT COUNT(*) n, COALESCE(SUM(total),0) monto FROM orders WHERE ${REAL} AND created_at >= ${since} AND estado != 'cancelado'`);
  const pagados = one(`SELECT COUNT(*) n, COALESCE(SUM(total),0) monto FROM orders WHERE ${REAL} AND estado = 'pagado' AND updated_at >= ${since}`);
  const recuperadas = one(`SELECT COUNT(DISTINCT o.id) n, COALESCE(SUM(o.total),0) monto FROM orders o
    WHERE o.${REAL} AND o.estado = 'pagado' AND o.updated_at >= ${since}
      AND EXISTS (SELECT 1 FROM events e WHERE e.conv_id = o.conv_id AND e.type = 'seguimiento_enviado' AND e.created_at <= o.created_at)`);
  const resp = one(`SELECT AVG(json_extract(data,'$.ms')) ms FROM events WHERE ${REAL} AND type='respuesta_ia' AND created_at >= ${since}`);
  const fueraHorario = one(`SELECT COUNT(*) n FROM messages WHERE ${REAL} AND role='cliente' AND created_at >= ${since}
    AND (CAST(strftime('%H', created_at, '-5 hours') AS INTEGER) >= 20 OR CAST(strftime('%H', created_at, '-5 hours') AS INTEGER) < 8)`);
  const embudo = Object.fromEntries(db.prepare(`SELECT etapa, COUNT(*) n FROM conversations WHERE canal != 'simulador' AND created_at >= ${since} GROUP BY etapa`).all().map((r) => [r.etapa, r.n]));
  const porDia = db.prepare(`SELECT date(updated_at, '-5 hours') dia, COUNT(*) n, SUM(total) monto FROM orders WHERE ${REAL} AND estado='pagado' AND updated_at >= ${since} GROUP BY dia ORDER BY dia`).all();
  const top = db.prepare(`SELECT json_extract(j.value,'$.nombre') nombre, SUM(json_extract(j.value,'$.cantidad')) unidades
    FROM orders o, json_each(o.items) j WHERE o.${REAL} AND o.estado='pagado' AND o.updated_at >= ${since} GROUP BY nombre ORDER BY unidades DESC LIMIT 5`).all();
  res.json({
    days,
    conversaciones: convs,
    pedidos: pedidos.n,
    monto_pedidos: pedidos.monto,
    ventas: pagados.n,
    monto_ventas: pagados.monto,
    conversion: convs ? pagados.n / convs : 0,
    ticket_promedio: pagados.n ? pagados.monto / pagados.n : 0,
    recuperadas_por_seguimiento: recuperadas,
    tiempo_respuesta_seg: resp.ms ? resp.ms / 1000 : null,
    mensajes_fuera_horario: fueraHorario.n,
    seguimientos: one(`SELECT COUNT(*) n FROM events WHERE ${REAL} AND type='seguimiento_enviado' AND created_at >= ${since}`).n,
    embudo,
    por_dia: porDia,
    top_productos: top,
    pendientes: {
      humano: one(`SELECT COUNT(*) n FROM conversations WHERE modo='humano'`).n,
      pagos_por_verificar: one(`SELECT COUNT(*) n FROM orders WHERE estado='por_verificar'`).n,
    },
    alertas: db.prepare(`SELECT a.*, c.nombre, c.phone FROM alerts a LEFT JOIN conversations c ON c.id = a.conv_id WHERE a.done = 0 ORDER BY a.id DESC LIMIT 20`).all(),
  });
});
api.post("/alerts/:id/done", (req, res) => {
  db.prepare("UPDATE alerts SET done = 1 WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// ---- Conversaciones ----
api.get("/conversations", (req, res) => {
  const q = `%${req.query.q || ""}%`;
  res.json(db.prepare(`
    SELECT c.*, (SELECT text FROM messages m WHERE m.conv_id = c.id ORDER BY id DESC LIMIT 1) ultimo,
           (SELECT MAX(created_at) FROM messages m WHERE m.conv_id = c.id) ultimo_at
    FROM conversations c WHERE c.nombre LIKE ? OR c.phone LIKE ?
    ORDER BY ultimo_at DESC NULLS LAST LIMIT 300`).all(q, q));
});
api.get("/conversations/:id", (req, res) => {
  const c = getConversation(req.params.id);
  if (!c) return res.status(404).json({ error: "No existe" });
  if (c.unread) updateConversation(c.id, { unread: 0 });
  res.json({ ...c, messages: getMessages(c.id), orders: ordersForConv(c.id).map((o) => ({ ...o, items: JSON.parse(o.items) })) });
});
api.post("/conversations/:id/reply", h(async (req, res) => {
  const c = getConversation(req.params.id);
  const text = String(req.body.text || "").trim();
  if (!c || !text) throw new Error("Falta el mensaje");
  await sendToCustomer(c, { text }, "humano");
  recordHumanReply(c.id, text);
  if (c.modo !== "humano") updateConversation(c.id, { modo: "humano", motivo_humano: "Atendido por el equipo" });
  res.json({ ok: true });
}));
api.post("/conversations/:id/mode", (req, res) => {
  const modo = req.body.modo === "humano" ? "humano" : "ia";
  updateConversation(req.params.id, { modo, ...(modo === "ia" ? { motivo_humano: "" } : {}) });
  if (modo === "ia") db.prepare("UPDATE alerts SET done = 1 WHERE conv_id = ? AND type IN ('humano','error')").run(req.params.id);
  logEvent(modo === "ia" ? "devuelto_a_ia" : "tomado_por_humano", Number(req.params.id));
  res.json({ ok: true });
});
api.post("/conversations/:id/stage", (req, res) => {
  const etapas = ["nuevo", "interesado", "pedido", "pagado", "perdido"];
  if (!etapas.includes(req.body.etapa)) return res.status(400).json({ error: "Etapa inválida" });
  updateConversation(req.params.id, { etapa: req.body.etapa });
  res.json({ ok: true });
});

// ---- Pedidos ----
api.get("/orders", (req, res) => {
  const estado = req.query.estado;
  const rows = db.prepare(`SELECT o.*, c.nombre, c.phone FROM orders o JOIN conversations c ON c.id = o.conv_id
    ${estado ? "WHERE o.estado = ?" : ""} ORDER BY o.id DESC LIMIT 300`).all(...(estado ? [estado] : []));
  res.json(rows.map((o) => ({ ...o, items: JSON.parse(o.items), pago_reportado: o.pago_reportado ? JSON.parse(o.pago_reportado) : null })));
});
api.post("/orders/:id/status", h(async (req, res) => {
  const o = getOrder(req.params.id);
  const estado = req.body.estado;
  if (!o || !["pagado", "cancelado", "pendiente_pago"].includes(estado)) throw new Error("Pedido o estado inválido");
  const c = getConversation(o.conv_id);
  if (estado === "cancelado" && o.estado !== "cancelado") {
    for (const it of JSON.parse(o.items)) db.prepare("UPDATE products SET stock = stock + ? WHERE id = ? AND stock IS NOT NULL").run(it.cantidad, it.product_id);
  }
  updateOrder(o.id, { estado });
  if (estado === "pagado") {
    updateConversation(c.id, { etapa: "pagado", next_followup_at: null });
    db.prepare("UPDATE alerts SET done = 1 WHERE conv_id = ? AND type = 'pago'").run(c.id);
    logEvent("pago_confirmado", c.id, { orderId: o.id, total: o.total });
    if (req.body.avisar !== false) {
      const s = getSettings().negocio;
      const text = `¡Listo${c.nombre ? ` ${c.nombre.split(" ")[0]}` : ""}! ✅ Confirmamos tu pago del pedido #${o.id} por $${o.total.toFixed(2)}. ${o.entrega ? `Entrega: ${o.entrega}. ` : ""}¡Gracias por tu compra en ${s.nombre || "nuestra tienda"}! 🙌`;
      await sendToCustomer(c, { text });
      appendHistory(c.id, { role: "assistant", content: [{ type: "text", text: `[Sistema: el equipo confirmó el pago del pedido #${o.id}] ${text}` }] });
    }
  }
  res.json({ ok: true });
}));

// ---- Catálogo ----
api.get("/products", (req, res) => res.json(listProducts()));
api.post("/products", h((req, res) => {
  const p = { ...req.body };
  if (p.imagen_data) {
    const f = parseDataUrl(p.imagen_data);
    if (f) p.imagen_url = `/uploads/${saveFile(UPLOADS, f)}`;
    delete p.imagen_data;
  }
  res.json(upsertProduct(p));
}));
api.delete("/products/:id", (req, res) => {
  deleteProduct(req.params.id);
  res.json({ ok: true });
});

// ---- Configuración ----
api.get("/settings", (req, res) => res.json(getSettings()));
api.post("/settings/:section", h((req, res) => {
  if (!["negocio", "bot", "seguimiento", "dueño"].includes(req.params.section)) throw new Error("Sección inválida");
  res.json(saveSettings(req.params.section, req.body));
}));

// ---- Asistente de configuración ----
api.get("/setup/history", (req, res) => res.json(setupTranscript()));
api.post("/setup/reset", (req, res) => {
  resetSetup();
  res.json({ ok: true });
});
api.post("/setup/chat", h(async (req, res) => {
  const files = (req.body.files || []).map(parseDataUrl).filter(Boolean);
  res.json(await setupChat({
    text: req.body.text,
    images: files.filter((f) => f.media_type.startsWith("image/")),
    pdfs: files.filter((f) => f.media_type === "application/pdf"),
  }));
}));

// ---- Simulador (probar sin WhatsApp) ----
const SIM_PHONE = "simulador";
api.get("/sim", (req, res) => {
  const c = db.prepare("SELECT * FROM conversations WHERE phone = ?").get(SIM_PHONE);
  res.json(c ? { ...c, messages: getMessages(c.id), orders: ordersForConv(c.id).map((o) => ({ ...o, items: JSON.parse(o.items) })) } : { messages: [], orders: [] });
});
api.post("/sim/send", h((req, res) => {
  const f = parseDataUrl(req.body.file);
  const msg = { phone: SIM_PHONE, name: req.body.name || "Cliente de prueba", canal: "simulador", text: String(req.body.text || "") };
  if (f) {
    msg.mediaUrl = `/media/${saveFile(MEDIA, f)}`;
    if (f.media_type === "application/pdf") msg.pdfs = [{ base64: f.base64 }];
    else msg.images = [f];
  }
  receiveMessage(msg);
  res.json({ ok: true });
}));
api.post("/sim/reset", (req, res) => {
  const c = db.prepare("SELECT id FROM conversations WHERE phone = ?").get(SIM_PHONE);
  if (c) resetConversation(c.id);
  res.json({ ok: true });
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`\n✅ Vendedor IA funcionando en http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) console.log("⚠️  Falta ANTHROPIC_API_KEY en el archivo .env");
  if (!wa.whatsappConfigured()) console.log("ℹ️  WhatsApp aún no conectado: puedes probar todo en la pestaña 'Probar'.");
  startFollowUpScheduler();
});
