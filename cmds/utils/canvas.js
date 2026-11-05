import { createCanvas, loadImage } from '@napi-rs/canvas'

function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
  const words = text.split(' ')
  let line = ''
  const lines = []
  for (let n = 0; n < words.length; n++) {
    const testLine = line + words[n] + ' '
    const metrics = ctx.measureText(testLine)
    const testWidth = metrics.width
    if (testWidth > maxWidth && n > 0) {
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
  description: 'Crea una imagen con una frase',
  run: async ({ msg, sock, text, usedPrefix, command }) => {
    try {
      const frase = text || (msg.quoted?.text || '')
      if (!frase) return sock.sendMessage(msg.chat, { text: `*Uso:* ${usedPrefix + command} <frase o etiqueta un mensaje>` }, { quoted: msg })
      const user = msg.quoted?.sender || msg.sender
      const name = msg.quoted?.pushName || msg.pushName || 'Usuario'
      const defaultImg = 'https://i.imgur.com/axnP93g.png'
      const imgUrl = await sock.profilePictureUrl(user, 'image').catch(() => defaultImg)
      let avatar
      try { avatar = await loadImage(imgUrl) } catch { avatar = await loadImage(defaultImg) }
      let bgImage
      try { bgImage = await loadImage('https://files.catbox.moe/6tno0n.jpg') } catch { bgImage = null }
      const width = 900, height = 500
      const canvas = createCanvas(width, height)
      const ctx = canvas.getContext('2d')
      if (bgImage) {
        ctx.drawImage(bgImage, 0, 0, width, height)
      } else {
        ctx.fillStyle = '#121a28'
        ctx.fillRect(0, 0, width, height)
      }
      ctx.fillStyle = 'rgba(0,0,0,0.5)'
      ctx.fillRect(0, 0, width, height)
      const avatarSize = 100
      ctx.save()
      ctx.beginPath()
      ctx.arc(100 + avatarSize / 2, height - 140 + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2, true)
      ctx.closePath()
      ctx.clip()
      ctx.drawImage(avatar, 100, height - 140, avatarSize, avatarSize)
      ctx.restore()
      ctx.fillStyle = '#ffffff'
      ctx.font = '28px sans-serif'
      wrapText(ctx, `"${frase}"`, 260, 100, 600, 36)
      ctx.fillStyle = '#dddddd'
      ctx.font = '20px sans-serif'
      ctx.fillText(`- ${name}`, 260, height - 50)
      const buf = await canvas.encode('png')
      await sock.sendMessage(msg.chat, {
        image: buf,
        caption: `_Frase de ${name}_`,
        mentions: [user]
      }, { quoted: msg })
    } catch (e) {
      console.log('ERROR MENSAJE:', e)
      await sock.sendMessage(msg.chat, { text: `Error real: ${e.message}\n${e.stack}` }, { quoted: msg })
    }
  }
}