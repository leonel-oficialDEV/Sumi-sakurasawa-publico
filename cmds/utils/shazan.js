export default {
  command: ['whatmusic', 'shazam'],
  category: 'tools',
  description: 'Identifica la música de un audio o video.',
  run: async ({ msg, sock, usedPrefix, command }) => {
    try {
      let acrcloud
      try {
        acrcloud = (await import('acrcloud')).default
      } catch {
        return msg.reply('✎ Falta instalar el paquete *acrcloud*.\nEscribe en el panel: `acrcloud` y reinicia el bot.')
      }
      const acr = new acrcloud({
        host: 'identify-ap-southeast-1.acrcloud.com',
        access_key: 'ee1b81b47cf98cd73a0072a761558ab1',
        access_secret: 'ya9OPe8onFAnNkyf9xMTK8qRyMGmsghfuHrIMmUI'
      })
      let q = msg.quoted ? msg.quoted : msg
      let mime = (q.msg || q).mimetype || q.mediaType || q.mimetype || ''
      if (!/video|audio/.test(mime)) {
        return msg.reply(`✎ Etiqueta un audio o video de poca duración con el comando *${usedPrefix + command}* para ver que música contiene.`)
      }
      await sock.sendMessage(msg.chat, { react: { text: '🕒', key: msg.key } }).catch(() => {})
      let buffer = null
      if (typeof q.download === 'function') buffer = await q.download()
      else if (typeof msg.download === 'function' && !msg.quoted) buffer = await msg.download()
      else if (typeof sock.downloadMediaMessage === 'function') buffer = await sock.downloadMediaMessage(q)
      else if (typeof sock.downloadMedia === 'function') buffer = await sock.downloadMedia(q)
      if (!buffer) return msg.reply('✎ No pude descargar el audio/video, intenta de nuevo.')
      let { status, metadata } = await acr.identify(buffer)
      if (status.code !== 0) return msg.reply(`✎ No se pudo identificar: ${status.msg}`)
      if (!metadata?.music?.length) return msg.reply('✧ No se encontraron datos de la canción')
      let cap = '乂 S H A Z A M - M U S I C 乂\n\n'
      for (let result of metadata.music) {
        let artist = result.artists?.map(v => v.name).join(', ') || 'Desconocido'
        let links = Object.keys(result.external_metadata || {}).map(i =>
          i === 'youtube'
            ? 'https://youtu.be/' + result.external_metadata[i].vid
            : i === 'deezer'
              ? 'https://www.deezer.com/us/track/' + result.external_metadata[i].track.id
              : i === 'spotify'
                ? 'https://open.spotify.com/track/' + result.external_metadata[i].track.id
                : ''
        ).filter(Boolean)
        cap += `> ✐ Título » ${result.title}\n`
        cap += `> ✦ Artista » ${artist}\n`
        if (result.album?.name) cap += `> 📚 Album » ${result.album.name}\n`
        if (result.genres?.length) cap += `> 🪴 Genero » ${result.genres.map(v => v.name).join(', ')}\n`
        if (result.duration_ms) cap += `> ⴵ Duración » ${toTime(result.duration_ms)}\n`
        if (result.release_date) cap += `> 🕜 Fecha de lanzamiento » ${result.release_date}\n`
        if (links.length) cap += `> 🜸 Enlace » ${links.map(i => `\n${i}`).join('\n')}\n`
        cap += '\n'
      }
      let thumbnail = null
      try {
        let thumbRes = await fetch('https://raw.githubusercontent.com/The-King-Destroy/Adiciones/main/Contenido/1742781294508.jpeg')
        if (thumbRes.ok) thumbnail = Buffer.from(await thumbRes.arrayBuffer())
      } catch {}
      await sock.sendMessage(msg.chat, {
        text: cap,
        contextInfo: {
          externalAdReply: {
            title: '✧ Whats • Music ✧',
            mediaType: 1,
            previewType: 0,
            renderLargerThumbnail: true,
            thumbnail: thumbnail,
            sourceUrl: ''
          }
        }
      }, { quoted: msg })
      await sock.sendMessage(msg.chat, { react: { text: '✅', key: msg.key } }).catch(() => {})
    } catch (e) {
      await msg.reply(`> Ocurrió un error al ejecutar el comando *${usedPrefix + command}*.\n> [Error: *${e.message}*]`)
    }
  }
}

function toTime(ms) {
  let m = Math.floor(ms / 60000) % 60
  let s = Math.floor(ms / 1000) % 60
  return [m, s].map(v => v.toString().padStart(2, '0')).join(':')
}