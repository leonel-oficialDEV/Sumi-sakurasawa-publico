import { createCanvas, loadImage } from '@napi-rs/canvas'
import fetch from 'node-fetch'

function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
  const words = text.split(' ')
  let line = ''
  const lines = []
  for (let n = 0; n < words.length; n++) {
    const testLine = line + words[n] + ' '
    const metrics = ctx.measureText(testLine)
    if (metrics.width > maxWidth && n > 0) {
      lines.push(line)
      line = words[n] + ' '
    } else {
      line = testLine
    }
  }
  lines.push(line)
  lines.forEach((l, i) => {
    ctx.fillText(l, x, y + (i * lineHeight))
  })
}

export default {
  command: ['mensaje', 'quote', 'frase', 'frases'],
  category: 'maker',
  run: async ({ sock, msg, text, args, usedPrefix, command }) => {
    const chatId = msg.chat || msg.key?.remoteJid
    const options = chatId.endsWith('@newsletter') ? undefined : { quoted: msg }

    const ctxInfo = msg.message?.extendedTextMessage?.contextInfo || msg.message?.imageMessage?.contextInfo || msg.message?.videoMessage?.contextInfo || null
    const quotedMsg = ctxInfo?.quotedMessage
    const quotedText = quotedMsg?.conversation || quotedMsg?.extendedTextMessage?.text || quotedMsg?.imageMessage?.caption || quotedMsg?.videoMessage?.caption || ''
    const quotedSender = ctxInfo?.participant || null

    const frase = (text || args?.join(' ') || quotedText || '').trim()
    if (!frase) return sock.sendMessage(chatId, { text: `*Uso:* ${usedPrefix + command} <frase o etiqueta un mensaje>` }, options)

    try {
      await sock.sendMessage(chatId, { react: { text: '🕒', key: msg.key } })

      const user = quotedSender || msg.key?.participant || msg.key?.remoteJid
      let name = msg.pushName || 'Usuario'
      try {
        const n = await sock.getName(user)
        if (n) name = n
      } catch {}

      const defaultImg = 'https://i.imgur.com/axnP93g.png'
      let imgUrl = defaultImg
      try { imgUrl = await sock.profilePictureUrl(user, 'image') } catch {}

      const avatarBuffer = await (await fetch(imgUrl)).buffer()
      const avatar = await loadImage(avatarBuffer)

      const bgBuffer = await (await fetch('https://files.catbox.moe/6tno0n.jpg')).buffer()
      const bgImage = await loadImage(bgBuffer)

      const width = 900, height = 500
      const canvas = createCanvas(width, height)
      const ctx = canvas.getContext('2d')

      ctx.drawImage(bgImage, 0, 0, width, height)
      ctx.fillStyle = 'rgba(0,0,0,0.5)'
      ctx.fillRect(0, 0, width, height)

      const avatarSize = 100
      const avatarX = 100
      const avatarY = height - 140
      ctx.save()
      ctx.beginPath()
      ctx.arc(avatarX + avatarSize / 2, avatarY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2, true)
      ctx.closePath()
      ctx.clip()
      ctx.drawImage(avatar, avatarX, avatarY, avatarSize, avatarSize)
      ctx.restore()

      ctx.fillStyle = '#ffffff'
      ctx.font = 'bold 28px sans-serif'
      wrapText(ctx, `"${frase}"`, 260, 100, 600, 36)

      ctx.fillStyle = '#dddddd'
      ctx.font = '20px sans-serif'
      ctx.fillText(`- ${name}`, 260, height - 50)

      await sock.sendMessage(chatId, {
        image: canvas.encode('png'),
        caption: `_Frase de ${name}_`,
        mentions: [user]
      }, options)

      await sock.sendMessage(chatId, { react: { text: '✅', key: msg.key } })
    } catch (e) {
      await sock.sendMessage(chatId, { text: `《✧》 Error: ${e.message}` }, options)
    }
  }
}