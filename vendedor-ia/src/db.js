// Base de datos local (SQLite integrado en Node 22+). Un archivo: data/vendedor.db
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.DATA_DIR || "./data";
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(process.env.DB_PATH || path.join(DATA_DIR, "vendedor.db"));
db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS products (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre      TEXT NOT NULL,
  descripcion TEXT DEFAULT '',
  precio      REAL NOT NULL DEFAULT 0,
  stock       INTEGER,                -- NULL = sin control de stock
  variantes   TEXT DEFAULT '',        -- ej: "Tallas 38-43; Colores: blanco, negro"
  imagen_url  TEXT DEFAULT '',
  activo      INTEGER NOT NULL DEFAULT 1,
  updated_at  TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS conversations (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  phone            TEXT NOT NULL UNIQUE,
  nombre           TEXT DEFAULT '',
  canal            TEXT NOT NULL DEFAULT 'whatsapp',  -- whatsapp | simulador
  modo             TEXT NOT NULL DEFAULT 'ia',        -- ia | humano
  etapa            TEXT NOT NULL DEFAULT 'nuevo',     -- nuevo | interesado | pedido | pagado | perdido
  motivo_humano    TEXT DEFAULT '',
  notas            TEXT DEFAULT '',
  created_at       TEXT DEFAULT (datetime('now')),
  last_customer_at TEXT,
  last_bot_at      TEXT,
  followups_sent   INTEGER NOT NULL DEFAULT 0,
  next_followup_at TEXT,
  followup_motivo  TEXT DEFAULT '',
  unread           INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id    INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role       TEXT NOT NULL,          -- cliente | ia | humano | sistema
  text       TEXT DEFAULT '',
  media_url  TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conv_id, id);
-- Historial exacto que se envía a Claude (solo se agrega, nunca se edita)
CREATE TABLE IF NOT EXISTS llm_history (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  json    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_llm_conv ON llm_history(conv_id, id);
CREATE TABLE IF NOT EXISTS orders (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id          INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  items            TEXT NOT NULL,       -- JSON [{product_id,nombre,variante,cantidad,precio}]
  total            REAL NOT NULL,
  estado           TEXT NOT NULL DEFAULT 'pendiente_pago', -- pendiente_pago | por_verificar | pagado | cancelado
  cliente_nombre   TEXT DEFAULT '',
  entrega          TEXT DEFAULT '',
  notas            TEXT DEFAULT '',
  pago_reportado   TEXT DEFAULT '',     -- JSON con lo que leyó la IA del comprobante
  created_at       TEXT DEFAULT (datetime('now')),
  updated_at       TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT NOT NULL,
  conv_id    INTEGER,
  data       TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS alerts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT NOT NULL,           -- humano | pago | error
  conv_id    INTEGER,
  text       TEXT NOT NULL,
  done       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
`);

export const now = () => new Date().toISOString().replace("T", " ").slice(0, 19);

// ---------- Configuración del negocio ----------
export const DEFAULT_SETTINGS = {
  negocio: {
    nombre: "",
    rubro: "",
    descripcion: "",
    ciudad: "",
    horario_atencion: "",
    nombre_vendedor: "Sofi",
    tono: "Cercano, amable y directo. Tutea al cliente. Usa emojis con moderación.",
    metodos_pago: "",
    entregas: "",
    politicas: "",
    preguntas_frecuentes: "",
    instrucciones_extra: "",
  },
  bot: {
    activo: true,
    agrupar_mensajes_segundos: 4,
    mensaje_audio: "¡Hola! Por ahora no puedo escuchar audios 🙈 ¿Me lo escribes por aquí, porfa?",
  },
  seguimiento: {
    activo: true,
    horas: [3, 22],          // 1er seguimiento a las 3 h, 2do a las 22 h (dentro de la ventana de 24 h de WhatsApp)
    hora_inicio: 8,          // no escribir antes de las 8:00
    hora_fin: 21,            // ni después de las 21:00
  },
  dueño: {
    whatsapp: "",            // número del dueño para avisos (formato 5939XXXXXXXX)
  },
};

export function getSettings() {
  const out = structuredClone(DEFAULT_SETTINGS);
  for (const row of db.prepare("SELECT key, value FROM settings").all()) {
    out[row.key] = { ...(out[row.key] || {}), ...JSON.parse(row.value) };
  }
  return out;
}

export function saveSettings(section, values) {
  const current = getSettings()[section] || {};
  const merged = { ...current, ...values };
  db.prepare("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(section, JSON.stringify(merged));
  return merged;
}

export function getRaw(key, fallback = null) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? JSON.parse(row.value) : fallback;
}
export function setRaw(key, value) {
  db.prepare("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, JSON.stringify(value));
}

// ---------- Productos ----------
export const listProducts = (soloActivos = false) =>
  db.prepare(`SELECT * FROM products ${soloActivos ? "WHERE activo = 1" : ""} ORDER BY id`).all();
export const getProduct = (id) => db.prepare("SELECT * FROM products WHERE id = ?").get(id);

export function upsertProduct(p) {
  const fields = {
    nombre: String(p.nombre ?? "").trim(),
    descripcion: String(p.descripcion ?? ""),
    precio: Number(p.precio ?? 0),
    stock: p.stock === "" || p.stock === null || p.stock === undefined ? null : Number(p.stock),
    variantes: String(p.variantes ?? ""),
    imagen_url: String(p.imagen_url ?? ""),
    activo: p.activo === false || p.activo === 0 ? 0 : 1,
  };
  if (p.id) {
    const prev = getProduct(p.id);
    if (!prev) throw new Error("Producto no existe");
    const merged = { ...prev, ...Object.fromEntries(Object.entries(fields).filter(([k]) => k in p)) };
    db.prepare(`UPDATE products SET nombre=?, descripcion=?, precio=?, stock=?, variantes=?, imagen_url=?, activo=?, updated_at=datetime('now') WHERE id=?`)
      .run(merged.nombre, merged.descripcion, merged.precio, merged.stock, merged.variantes, merged.imagen_url, merged.activo, p.id);
    return getProduct(p.id);
  }
  if (!fields.nombre) throw new Error("El producto necesita nombre");
  const r = db.prepare(`INSERT INTO products(nombre, descripcion, precio, stock, variantes, imagen_url, activo) VALUES(?,?,?,?,?,?,?)`)
    .run(fields.nombre, fields.descripcion, fields.precio, fields.stock, fields.variantes, fields.imagen_url, fields.activo);
  return getProduct(Number(r.lastInsertRowid));
}
export const deleteProduct = (id) => db.prepare("DELETE FROM products WHERE id = ?").run(id);

// ---------- Conversaciones ----------
export function getOrCreateConversation(phone, nombre = "", canal = "whatsapp") {
  let c = db.prepare("SELECT * FROM conversations WHERE phone = ?").get(phone);
  if (!c) {
    db.prepare("INSERT INTO conversations(phone, nombre, canal) VALUES(?,?,?)").run(phone, nombre, canal);
    c = db.prepare("SELECT * FROM conversations WHERE phone = ?").get(phone);
    logEvent("conversacion_nueva", c.id);
  } else if (nombre && !c.nombre) {
    db.prepare("UPDATE conversations SET nombre = ? WHERE id = ?").run(nombre, c.id);
    c.nombre = nombre;
  }
  return c;
}
export const getConversation = (id) => db.prepare("SELECT * FROM conversations WHERE id = ?").get(id);

export function updateConversation(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  db.prepare(`UPDATE conversations SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`)
    .run(...keys.map((k) => fields[k]), id);
}

export function addMessage(conv_id, role, text, media_url = "") {
  db.prepare("INSERT INTO messages(conv_id, role, text, media_url) VALUES(?,?,?,?)").run(conv_id, role, text || "", media_url || "");
}

export const getMessages = (conv_id, limit = 500) =>
  db.prepare("SELECT * FROM (SELECT * FROM messages WHERE conv_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id").all(conv_id, limit);

export const getHistory = (conv_id) =>
  db.prepare("SELECT json FROM llm_history WHERE conv_id = ? ORDER BY id").all(conv_id).map((r) => JSON.parse(r.json));

export const appendHistory = (conv_id, message) =>
  db.prepare("INSERT INTO llm_history(conv_id, json) VALUES(?, ?)").run(conv_id, JSON.stringify(message));

export function resetConversation(conv_id) {
  db.prepare("DELETE FROM conversations WHERE id = ?").run(conv_id);
}

// ---------- Pedidos ----------
export const getOrder = (id) => db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
export const ordersForConv = (conv_id) => db.prepare("SELECT * FROM orders WHERE conv_id = ? ORDER BY id DESC").all(conv_id);

export function updateOrder(id, fields) {
  const keys = Object.keys(fields);
  db.prepare(`UPDATE orders SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = datetime('now') WHERE id = ?`)
    .run(...keys.map((k) => fields[k]), id);
}

// ---------- Eventos y alertas ----------
export const logEvent = (type, conv_id = null, data = "") =>
  db.prepare("INSERT INTO events(type, conv_id, data) VALUES(?,?,?)").run(type, conv_id, typeof data === "string" ? data : JSON.stringify(data));

export const addAlert = (type, conv_id, text) =>
  db.prepare("INSERT INTO alerts(type, conv_id, text) VALUES(?,?,?)").run(type, conv_id, text);
