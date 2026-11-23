// Asistente de configuración: el dueño le cuenta su negocio (o le manda foto de su lista de precios)
// y la IA arma el vendedor: datos del negocio, catálogo, pagos, políticas.
import { client, MODEL, fallbackParams, textOf } from "./claude.js";
import { getSettings, saveSettings, listProducts, upsertProduct, deleteProduct, getRaw, setRaw } from "./db.js";
import { catalogText } from "./prompt.js";

const obj = (properties, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });

const NEGOCIO_FIELDS = {
  nombre: "Nombre del negocio",
  rubro: "Qué vende, en pocas palabras",
  descripcion: "Descripción y diferenciadores (calidad, garantía, años en el mercado)",
  ciudad: "Ciudad o zona donde opera",
  horario_atencion: "Horario de atención humana",
  nombre_vendedor: "Nombre de la vendedora/vendedor virtual",
  tono: "Tono y estilo al escribir",
  metodos_pago: "Datos exactos de pago: Deuna, transferencias (banco, tipo y número de cuenta, titular, cédula), efectivo contra entrega, link de pago, etc.",
  entregas: "Cómo se entrega: retiro en local (dirección), envíos (zonas, costo, tiempo), contra entrega",
  politicas: "Cambios, garantías, descuentos permitidos, mayoristas",
  preguntas_frecuentes: "Respuestas a preguntas que siempre hacen",
  instrucciones_extra: "Cualquier otra regla especial para el vendedor",
};

const TOOLS = [
  {
    name: "guardar_negocio",
    description: "Guarda o actualiza datos del negocio. Envía solo los campos que cambian; en los demás manda cadena vacía.",
    strict: true,
    input_schema: obj(Object.fromEntries(Object.entries(NEGOCIO_FIELDS).map(([k, d]) => [k, { type: "string", description: d }]))),
  },
  {
    name: "guardar_productos",
    description: "Crea o actualiza productos del catálogo. Para actualizar, incluye el id existente; para crear, id = 0.",
    strict: true,
    input_schema: obj({
      productos: {
        type: "array",
        items: obj({
          id: { type: "integer" },
          nombre: { type: "string" },
          descripcion: { type: "string" },
          precio: { type: "number" },
          stock: { type: "integer", description: "-1 si no se controla el stock" },
          variantes: { type: "string", description: "Tallas, colores, sabores, tamaños disponibles" },
          activo: { type: "boolean" },
        }),
      },
    }),
  },
  {
    name: "eliminar_producto",
    description: "Elimina un producto del catálogo por id.",
    strict: true,
    input_schema: obj({ id: { type: "integer" } }),
  },
];

function systemPrompt() {
  const s = getSettings();
  const filled = Object.entries(NEGOCIO_FIELDS)
    .map(([k, d]) => `- ${k} (${d}): ${s.negocio[k]?.trim() ? s.negocio[k] : "⛔ VACÍO"}`)
    .join("\n");
  return `Eres el asistente de configuración de "Vendedor IA", una herramienta que crea un vendedor automático de WhatsApp para pequeños negocios de Ecuador y Latinoamérica. Hablas con el DUEÑO del negocio (no con clientes).

Tu objetivo: dejar el vendedor listo para vender en pocos minutos, haciendo el trabajo por el dueño.
- Cuando el dueño te cuente algo, guárdalo de inmediato con las herramientas. No pidas confirmación para cada dato.
- Si te manda una foto o PDF de su lista de precios, menú o catálogo, extrae todos los productos con precio y variantes y guárdalos.
- Completa con sentido común lo que sea obvio (por ejemplo, un tono adecuado al rubro), pero NUNCA inventes precios, datos de pago ni políticas.
- Después de guardar, resume en 2-3 líneas lo que quedó y pregunta por lo MÁS importante que falte, en este orden: productos y precios → datos de pago → entregas → nombre del negocio → políticas.
- Habla simple, cálido y breve, como un socio que ayuda. Sin tecnicismos.
- Cuando ya esté lo esencial (productos, pagos y entregas), dile que pruebe su vendedor en la pestaña "Probar".

Estado actual del negocio:
${filled}

Catálogo actual:
${catalogText(listProducts())}`;
}

async function runTool(name, input) {
  if (name === "guardar_negocio") {
    const values = Object.fromEntries(Object.entries(input).filter(([, v]) => typeof v === "string" && v.trim()));
    saveSettings("negocio", values);
    return { ok: true, guardados: Object.keys(values) };
  }
  if (name === "guardar_productos") {
    const saved = input.productos.map((p) =>
      upsertProduct({ ...p, id: p.id > 0 ? p.id : undefined, stock: p.stock < 0 ? null : p.stock })
    );
    return { ok: true, productos: saved.map((p) => `ID ${p.id}: ${p.nombre} $${p.precio}`) };
  }
  if (name === "eliminar_producto") {
    deleteProduct(input.id);
    return { ok: true };
  }
  return { error: "herramienta desconocida" };
}

/**
 * @param {{text?:string, images?:{base64:string, media_type:string}[], pdfs?:{base64:string}[]}} input
 */
export async function setupChat({ text, images = [], pdfs = [] }) {
  const history = getRaw("setup_history", []);
  const content = [
    ...images.map((i) => ({ type: "image", source: { type: "base64", media_type: i.media_type, data: i.base64 } })),
    ...pdfs.map((p) => ({ type: "document", source: { type: "base64", media_type: "application/pdf", data: p.base64 } })),
    { type: "text", text: text?.trim() || "(Te envío este archivo)" },
  ];
  history.push({ role: "user", content });
  const replies = [];

  for (let step = 0; step < 8; step++) {
    // El sistema se reconstruye en cada paso para que el asistente vea lo que acaba de guardar.
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 32000,
      output_config: { effort: "medium" },
      system: systemPrompt(),
      tools: TOOLS,
      messages: history,
      ...fallbackParams(),
    });
    const response = await stream.finalMessage();
    if (response.stop_reason === "refusal") {
      return { replies: ["No pude procesar eso. ¿Me lo cuentas de otra forma?"] }; // no se guarda este intento
    }
    history.push({ role: "assistant", content: response.content });
    const t = textOf(response.content);
    if (t) replies.push(t);
    if (response.stop_reason !== "tool_use") break;
    const results = [];
    for (const tu of response.content.filter((b) => b.type === "tool_use")) {
      let out;
      try {
        out = await runTool(tu.name, tu.input);
      } catch (e) {
        out = { error: e.message };
      }
      results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(out) });
    }
    history.push({ role: "user", content: results });
  }

  // Lo importante ya quedó guardado en la configuración; si la charla crece mucho, se empieza una nueva.
  setRaw("setup_history", history.length > 200 ? [] : history);
  return { replies };
}

export function setupTranscript() {
  return getRaw("setup_history", [])
    .filter((m) => m.role === "user" ? m.content.some?.((b) => b.type === "text") : true)
    .map((m) => ({
      role: m.role,
      text: Array.isArray(m.content)
        ? m.content.filter((b) => b.type === "text").map((b) => b.text).join("\n")
        : m.content,
      archivo: Array.isArray(m.content) && m.content.some((b) => b.type === "image" || b.type === "document"),
    }))
    .filter((m) => m.text || m.archivo);
}

export const resetSetup = () => setRaw("setup_history", []);
