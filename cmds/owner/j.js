import fs from "fs";
import path from "path";

const confirmaciones = global.confirmacionesJ || (global.confirmacionesJ = new Map());
const BLOQUEADAS = [".", "./", "/", "..", "../", "../../"];

export default {
  command: ["j", "confi"],
  isOwner: true,
  description: 'Descargar en .txt cualquier archivo existente en el bot.',
  run: async ({ sock, msg, args, prefix, command }) => {
    const client = sock;
    const m = msg;
    const usedPrefix = prefix || ".";

    if (command === "j") {
      if (!args[0]) {
        return await client.sendMessage(m.chat, {
          text: `《✧》 Uso: tienes que especificar la ruta\n\n*Ejemplos:*\n${usedPrefix}j./cmd/owner/j.js\n${usedPrefix}j./cmds\n${usedPrefix}j /home/container/cmds`
        }, { quoted: m });
      }
      const ruta = args.join(" ").trim();
      if (BLOQUEADAS.includes(ruta)) {
        return await client.sendMessage(m.chat, { text: `❌ Esa ruta está protegida.\n\nRuta:\n${ruta}` }, { quoted: m });
      }
      const absoluta = path.resolve(ruta);
      if (!fs.existsSync(absoluta)) {
        return await client.sendMessage(m.chat, { text: `❌ La ruta no existe.\n\nRuta:\n${ruta}` }, { quoted: m });
      }
      const stat = fs.statSync(absoluta);
      if (stat.isDirectory()) {
        const files = fs.readdirSync(absoluta);
        return await client.sendMessage(m.chat, { text: `《✧》 Directorio: ${ruta}\nTotal: ${files.length}\n\n${files.map(f => `• ${f}`).join("\n")}` }, { quoted: m });
      }
      const msgConfirm = await client.sendMessage(m.chat, {
        text: `⚠️ CONFIRMACIÓN\n\nSe requiere confirmación del archivo\n\nRuta:\n${ruta}\n\nResponde a este mensaje con:\n\n${usedPrefix}confi\n\nTienes 30 segundos.`
      }, { quoted: m });
      confirmaciones.set(m.sender, { ruta, absoluta, messageId: msgConfirm.key.id });
      setTimeout(() => confirmaciones.delete(m.sender), 30000);
      return;
    }

    if (command === "confi") {
      const data = confirmaciones.get(m.sender);
      if (!data) return await client.sendMessage(m.chat, { text: `❌ No tienes ningún archivo pendiente.` }, { quoted: m });
      const quoted = m.message?.extendedTextMessage?.contextInfo?.stanzaId;
      if (!quoted || quoted !== data.messageId) {
        return await client.sendMessage(m.chat, { text: `❌ Debes responder al mensaje de confirmación.` }, { quoted: m });
      }
      try {
        await client.sendMessage(m.chat, { text: `Procesando petición......` }, { quoted: m });
        const contenido = fs.readFileSync(data.absoluta, "utf-8");
        await client.sendMessage(m.chat, {
          document: Buffer.from(contenido, "utf-8"),
          mimetype: "text/plain",
          fileName: path.basename(data.absoluta) + ".txt",
          caption: `《✧》 Ruta: ${data.ruta}`
        }, { quoted: m });
        confirmaciones.delete(m.sender);
      } catch (e) {
        confirmaciones.delete(m.sender);
        await client.sendMessage(m.chat, { text: `❌ Error: ${e.message}` }, { quoted: m });
      }
    }
  }
};