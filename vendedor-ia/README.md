# Vendedor IA para WhatsApp

Un vendedor automático que **responde, vende, cobra y hace seguimiento** por WhatsApp las 24 horas, con un panel para que el dueño mida y controle todo.

## Qué hace (y qué lo hace mejor que lo típico)

| Función | Cómo funciona |
|---|---|
| **Configuración hablando** | Le cuentas a la IA qué vendes, o le mandas **foto de tu lista de precios**, y ella arma el catálogo, los pagos y las políticas. |
| **Vende con proceso** | Pregunta, recomienda, manda fotos de productos, maneja objeciones y cierra. Nunca inventa precios, stock ni descuentos. |
| **Pedidos con total exacto** | El total lo calcula el sistema (no la IA) y se descuenta del stock automáticamente. |
| **Lee comprobantes** | El cliente manda foto o PDF del pago (Deuna, transferencia). La IA lee monto, banco y referencia, avisa si **no coincide**, y tú confirmas con un clic. El cliente recibe la confirmación solo. |
| **Pasa a una persona** | Si el cliente se molesta, pide un humano o pregunta algo que la IA no sabe, la IA se pausa en ese chat y te avisa. Tú respondes desde el panel y luego se lo devuelves. |
| **Seguimiento automático** | Si el cliente deja de responder, le escribe de nuevo retomando lo que estaba en curso (dentro de la ventana de 24 h de WhatsApp y en horario decente). |
| **Agrupa mensajes** | Si el cliente manda 3 mensajes seguidos, responde una sola vez y con sentido. |
| **Audios y stickers** | Responde con naturalidad pidiendo que lo escriba. |
| **Métricas** | Ventas confirmadas, conversión chat→venta, ticket promedio, ventas recuperadas por seguimiento, tiempo de respuesta, embudo y productos más vendidos. |
| **Simulador** | Prueba tu vendedor como si fueras cliente antes de conectarlo. |
| **WhatsApp oficial** | Usa la API oficial de Meta: sin riesgo de que bloqueen tu número. |

## Ponerlo a funcionar

Necesitas **Node.js 22.13 o más reciente** y una clave de la API de Claude ([console.anthropic.com](https://console.anthropic.com/settings/keys)).

```bash
cd vendedor-ia
npm install
cp .env.example .env      # y pon tu ANTHROPIC_API_KEY y una PANEL_PASSWORD
npm start
```

Abre **http://localhost:3000**, y luego:

1. **Configurar**: cuéntale a la IA qué vendes, cómo te pagan y cómo entregas.
2. **Probar**: chatea como cliente. Pide precios, di "está caro", compra y manda una foto de un comprobante.
3. **WhatsApp**: sigue los pasos de esa pestaña para conectar tu número (unos 20 minutos, una sola vez).

### Subirlo a internet

WhatsApp necesita una dirección pública con HTTPS para enviar los mensajes. Sirve cualquier servidor que ejecute Node, por ejemplo Railway, Render, Fly.io o un VPS. Guarda la carpeta `data/` en un disco persistente, porque ahí están la base de datos y las fotos. Después pon esa dirección en `PUBLIC_URL`.

## Costos aproximados

- **WhatsApp**: responder a un cliente que te escribió es gratis dentro de las 24 h (según las tarifas actuales de Meta).
- **IA**: por defecto usa `claude-opus-5-5` con esfuerzo bajo, que es el más inteligente. Si quieres bajar costos, prueba `IA_MODELO=claude-sonnet-5-5` o `claude-haiku-5-5` en el `.env` y compara la calidad en el simulador.

## Estructura

```
src/server.js           servidor, webhook de WhatsApp y API del panel
src/agent.js            motor del vendedor (agrupa mensajes, conversa, usa herramientas)
src/tools.js            herramientas: fotos, pedidos, pagos, pasar a humano, notas, seguimiento
src/prompt.js           instrucciones del vendedor (se arman desde tu configuración y catálogo)
src/setup-assistant.js  asistente que configura el negocio conversando
src/followups.js        seguimientos automáticos
src/whatsapp.js         conexión con la API oficial de WhatsApp
src/db.js               base de datos SQLite (archivo data/vendedor.db)
public/index.html       panel del dueño
```

## Próximos pasos sugeridos

- Varios negocios en una sola instalación (para venderlo como servicio).
- Plantillas de WhatsApp aprobadas, para hacer seguimiento después de 24 h y para campañas.
- Transcribir notas de voz.
- Integración con el catálogo de WhatsApp o Meta Ads, para medir qué anuncio trae ventas.
