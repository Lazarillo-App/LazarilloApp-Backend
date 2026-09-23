// utils/smsClient.js
//
// Envío de SMS y WhatsApp vía Twilio (usado por el registro por QR — Vista
// Operación). Mismo criterio que utils/mailer.js: si no hay credenciales
// configuradas, simula el envío y lo loguea en vez de romper.
//
// Variables de entorno:
//   TWILIO_ACCOUNT_SID
//   TWILIO_AUTH_TOKEN
//   TWILIO_FROM_SMS       (ej: +17372508034)
//   TWILIO_WHATSAPP_FROM  (ej: whatsapp:+17372508034)

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_FROM_SMS,
  TWILIO_WHATSAPP_FROM,
} = process.env;

let client = null;

function buildClient() {
  if (client) return client;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    console.warn('[smsClient] ⚠️  Twilio no configurado — SMS/WhatsApp se loguean por consola, no se envían realmente.');
    return null;
  }
  // require perezoso: si el paquete faltara en algún entorno, no rompe todo el server al bootear.
  const twilio = require('twilio');
  client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  console.log('[smsClient] ✅ Twilio listo');
  return client;
}

/**
 * Manda un código de confirmación por SMS o WhatsApp.
 * @param {string} canal   'celular' (SMS) | 'whatsapp'
 * @param {string} to      número en formato E.164 (+549...)
 * @param {string} texto
 * @returns {Promise<{ok:boolean, simulated:boolean, sid?:string, error?:string}>}
 */
async function sendCode(canal, to, texto) {
  const tw = buildClient();
  const from = canal === 'whatsapp' ? TWILIO_WHATSAPP_FROM : TWILIO_FROM_SMS;

  if (!tw || !from) {
    console.log('───── [smsClient:simulated] ─────');
    console.log('  CANAL:', canal);
    console.log('  TO:   ', to);
    console.log('  TEXTO:', texto);
    console.log('──────────────────────────────────');
    return { ok: true, simulated: true };
  }

  try {
    const toFinal = canal === 'whatsapp' ? `whatsapp:${to.replace(/^whatsapp:/, '')}` : to;
    const msg = await tw.messages.create({ from, to: toFinal, body: texto });
    return { ok: true, simulated: false, sid: msg.sid };
  } catch (e) {
    console.error('[smsClient] ❌ error enviando:', e.message);
    return { ok: false, simulated: false, error: e.message };
  }
}

module.exports = { sendCode };
