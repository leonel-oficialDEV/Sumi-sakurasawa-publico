import { forwardAudioSticker, loadAudioSticker } from '../stickers/asticker.js'

const CHANNEL_JID = '120363429087298544@newsletter'

function isAnimatedWebp(buffer) {
  return buffer.includes(Buffer.from('ANIM')) || buffer.includes(Buffer.from('ANMF'))
}

function isQuotedSticker(q) {
  if (!q) return false
  const mime = String((q.msg || q)?.mimetype || q.mimetype || '').toLowerCase()
  return /webp/.test(mime) || q.mtype === 'stickerMessage' || q.type === 'sticker' || Boolean(q.message?.stickerMessage)
}

export default {
  command: ['4cs'],
  category: 'owner',
  description: 'Envía al canal el sticker citado.',
  isOwner: true,
  run: async ({ msg, sock, usedPrefix, command }) => {
    if (sock !== global.sock || !sock.isOwner) {
      return await sock.sendMessage(msg.chat, { text: global.mess.mainBot }, { quoted: msg })
    }

    const q = msg.quoted
    if (!isQuotedSticker(q)) {
      return await sock.sendMessage(msg.chat, {
        text: `《✧》 Responde a un sticker con *${usedPrefix + command}* para enviarlo al canal.`
      }, { quoted: msg })
    }

    await msg.react('⏳')
    try {
      const buffer = await q.download()
      if (!buffer?.length) {
        await msg.react('❌')
        return await sock.sendMessage(msg.chat, { text: '《✧》 No pude descargar el sticker.' }, { quoted: msg })
      }

      const animated = isAnimatedWebp(buffer)
      const stored = await loadAudioSticker(buffer)

      if (stored) {
        await forwardAudioSticker(sock, CHANNEL_JID, buffer, animated, stored)
      } else {
        await sock.sendMessage(CHANNEL_JID, { sticker: buffer, isAnimated: animated })
      }

      await msg.react('✅')
      await sock.sendMessage(msg.chat, {
        text: stored
          ? '☘︎Sticker con audio enviado con éxito☂︎'
          : '☘︎Sticker enviado con éxito☂︎'
      }, { quoted: msg })
    } catch (e) {
      await msg.react('❌')
      await sock.sendMessage(msg.chat, { text: `> Error en *${usedPrefix + command}*: ${e.message}` }, { quoted: msg })
    }
  }
}