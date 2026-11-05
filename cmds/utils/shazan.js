export default {
  command: ['shazam', 'whatmusic'],
  category: 'tools',
  description: 'Identifica la música de un audio o video.',
  run: async ({ msg, sock, usedPrefix, command }) => {
    try {
      let acrcloud
      try {
        acrcloud = (await import('acrcloud')).default
      } catch {
        return msg.reply('✎ Falta instalar el paquete *acrcloud*.\nEscribe en la consola: `npm install acrcloud` y reinicia el bot.')
      }
      let acr = new acrcloud({
        host: 'identify-eu-west-1.acrcloud.com',
        access_key: 'c33c767d683f78bd17d4bd4991955d81',
        access_secret: 'bvgaIAEtADBTbLwiPGYlxupWqkNGIjT7J9Ag2vIu'
      })
      let q = msg.quoted ? msg.quoted : msg
      let mime = (q.msg || q).mimetype || q.mediaType || q.mimetype || ''
      if (!/video|audio/.test(mime)) {
        return msg.reply(`✎ Etiqueta un audio o video de poca duración con el comando *${usedPrefix + command}* para ver que música contiene.`)
      }
      let buffer = null
      if (typeof q.download === 'function') {
        buffer = await q.download()
      } else if (typeof msg.download === 'function' && !msg.quoted) {
        buffer = await msg.download()
      } else if (typeof sock.downloadMediaMessage === 'function') {
        buffer = await sock.downloadMediaMessage(q)
      } else if (typeof sock.downloadMedia === 'function') {
        buffer = await sock.downloadMedia(q)
      }
      if (!buffer) return msg.reply('✎ No pude descargar el audio/video, intenta de nuevo.')
      let { status, metadata } = await acr.identify(buffer)
      if (status.code !== 0) return msg.reply(`✎ No se pudo identificar: ${status.msg}`)
      if (!metadata?.music?.length) return msg.reply('✎ No se encontró ninguna canción en ese audio.')
      let { title, artists, album, genres, release_date } = metadata.music[0]
      let txt = '╭─⬣「 *Whatmusic Tools* 」⬣\n'
      txt += `│  ≡◦ *🍭 Titulo ∙* ${title}${artists ? `\n│  ≡◦ *👤 Artista ∙* ${artists.map(v => v.name).join(', ')}` : ''}`
      txt += `${album ? `\n│  ≡◦ *📚 Album ∙* ${album.name}` : ''}${genres ? `\n│  ≡◦ *🪴 Genero ∙* ${genres.map(v => v.name).join(', ')}` : ''}\n`
      txt += `│  ≡◦ *🕜 Fecha de lanzamiento ∙* ${release_date}\n`
      txt += `╰─⬣`
      await sock.sendMessage(msg.chat, { text: txt }, { quoted: msg })
    } catch (e) {
      await msg.reply(`> Ocurrió un error al ejecutar el comando *${usedPrefix + command}*.\n> [Error: *${e.message}*]`)
    }
  }
}