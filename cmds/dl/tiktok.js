import fetch from 'node-fetch'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36 Edg/149.0.0.0'
const SSS = 'https://ssstik.io'
const TIKWM = 'https://www.tikwm.com'
const EVO_URL = 'https://api.evogb.org'
const EVO_KEY = process.env.EVOGB_KEY || 'Alba070503'
const URL_REGEX = /(?:https?:\/\/)?(?:www\.|vm\.|vt\.|t\.|m\.)?tiktok\.com\/[^\s&]+/i

// ---------- Utilidades ----------
const decode = s => { try { return decodeURIComponent(escape(Buffer.from(s, 'base64').toString('binary'))) } catch { return '' } }
const clean = s => (s || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim()
const pick = (re, h) => (h.match(re) || [])[1] || ''
const fmt = n => Number(n || 0).toLocaleString()
const absUrl = u => (u && u.startsWith('/') ? TIKWM + u : u)

// ---------- Scraper de enlaces: ssstik.io (prefiere HD) ----------
async function bootstrap() {
  const r = await fetch(`${SSS}/en`, { headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', referer: `${SSS}/` } })
  const html = await r.text()
  const tt = pick(/s_tt\s*=\s*'([^']+)'/, html)
  const furl = pick(/s_furl\s*=\s*'([^']+)'/, html) || 'abc'
  if (!tt) throw new Error('token not found')
  return { tt, furl }
}

async function trace() {
  const r = await fetch(`${SSS}/cdn-cgi/trace`, { headers: { 'user-agent': UA, referer: `${SSS}/` } })
  const o = {}
  ;(await r.text()).trim().split('\n').forEach(l => {
    const i = l.indexOf('=')
    if (i > 0) o[l.slice(0, i)] = l.slice(i + 1)
  })
  return o
}

function parseSss(html) {
  const username = clean(pick(/<h2[^>]*>([\s\S]*?)<\/h2>/i, html))
  const caption = clean(pick(/class="maintext"[^>]*>([\s\S]*?)<\/p>/i, html))
  const anchors = [...html.matchAll(/<a\b([^>]*?)>/gi)].map(m => m[1])
  let video = '', videoHd = '', music = ''
  const images = []
  for (const a of anchors) {
    const cls = pick(/class="([^"]*)"/, a)
    const href = pick(/href="([^"]*)"/, a)
    if (!/download_link|dl-button/.test(cls)) continue
    if (/music/.test(cls) && href && href !== '#') music = href
    else if (/without_watermark_hd/.test(cls) && href && href.startsWith('http')) { if (!videoHd) videoHd = href }
    else if (/without_watermark/.test(cls) && href && href.startsWith('http')) { if (!video) video = href }
    else if (/photo|image|slide/.test(cls) && href && href.startsWith('http')) images.push(href)
  }
  if (!music) music = pick(/href="([^"]*\/m\/[A-Za-z0-9+/=]+)"/, html)
  if (!images.length) {
    for (const m of html.matchAll(/href="(https:\/\/tikcdn\.io\/ssstik\/p\/[^"]+)"/gi)) images.push(m[1])
  }
  return { username, caption, video: videoHd || video, hd: !!videoHd, music, images: [...new Set(images)] }
}

async function ssstik(url) {
  const { tt, furl } = await bootstrap()
  const t = await trace()
  const body = new URLSearchParams({ id: url, locale: 'en', tt, debug: `ab=0&loc=${t.loc || 'US'}&ip=${t.ip || ''}` })
  const r = await fetch(`${SSS}/${furl}?url=dl`, {
    method: 'POST',
    headers: {
      'user-agent': UA, accept: '*/*', 'accept-language': 'en-US,en;q=0.9',
      'content-type': 'application/x-www-form-urlencoded',
      'hx-current-url': `${SSS}/`, 'hx-request': 'true', 'hx-target': 'target', 'hx-trigger': '_gcaptcha_pt',
      origin: SSS, referer: `${SSS}/`
    },
    body
  })
  const html = await r.text()
  if (/error|Cuoldn't|couldn|Wrong/i.test(html) && !/result_overlay/.test(html)) throw new Error('ssstik error: ' + clean(html).slice(0, 120))
  const data = parseSss(html)
  if (!data.video && !data.music && !data.images.length) throw new Error('no media found')
  return {
    type: data.images.length && !data.video ? 'image' : 'video',
    author: data.username,
    title: data.caption,
    video: data.video,
    hd: data.hd,
    images: data.images,
    music: data.music
  }
}

// ---------- Respaldo de enlaces: tikwm.com (HD) ----------
async function tikwmDownload(url) {
  const r = await fetch(`${TIKWM}/api/?url=${encodeURIComponent(url)}&hd=1`, { headers: { 'user-agent': UA } })
  const j = await r.json()
  const d = j?.data
  if (!d) throw new Error('tikwm sin datos')
  const images = Array.isArray(d.images) ? d.images : []
  return {
    type: images.length ? 'image' : 'video',
    author: d.author?.nickname || d.author?.unique_id || '',
    title: d.title || '',
    video: absUrl(d.hdplay || d.play),
    hd: !!d.hdplay,
    images,
    music: absUrl(d.music),
    stats: { likes: d.digg_count, comments: d.comment_count, views: d.play_count, shares: d.share_count },
    duration: d.duration
  }
}

async function downloadTikTok(url) {
  try {
    return await ssstik(url)
  } catch {
    return await tikwmDownload(url)
  }
}

// ---------- Busqueda: api.evogb.org ----------
async function searchTikTok(query) {
  const r = await fetch(`${EVO_URL}/search/tiktok?query=${encodeURIComponent(query)}&key=${EVO_KEY}`, {
    headers: { 'user-agent': UA }
  })
  if (!r.ok) throw new Error(`El servidor respondio con ${r.status}`)
  const j = await r.json()
  if (!j?.status || !Array.isArray(j.data)) throw new Error(j?.message || 'Sin resultados')
  return j.data
}

export default {
  command: ['tiktok', 'tt', 'tts'],
  category: 'downloads',
  description: 'Buscar o descargar videos de TikTok en HD. Usa #tts <busqueda> para buscar y #tiktok / #tt <enlace> para descargar.',
  run: async ({ msg, sock, args, usedPrefix, command }) => {
    if (!args.length) {
      return msg.reply(
        `[!] Ingresa un termino de busqueda o un enlace de TikTok.\n\n` +
        `Ejemplos:\n` +
        `> ${usedPrefix}tts Ibai\n` +
        `> ${usedPrefix}tiktok https://vt.tiktok.com/xxxxxx/\n` +
        `> ${usedPrefix}tt https://www.tiktok.com/@usuario/video/123`
      )
    }

    const text = args.join(' ').trim()
    const urlMatch = text.match(URL_REGEX)
    const isUrl = !!urlMatch

    try {
      // ===== Descarga por enlace: usa el scraper =====
      if (isUrl) {
        const link = /^https?:\/\//i.test(urlMatch[0]) ? urlMatch[0] : `https://${urlMatch[0]}`
        const data = await downloadTikTok(link)

        const lines = [
          '*TikTok Download*',
          '',
          `*Titulo:* ${data.title || 'Sin titulo'}`,
          `*Autor:* ${data.author || 'Desconocido'}`
        ]
        if (data.duration) lines.push(`*Duracion:* ${data.duration}s`)
        if (data.stats) {
          lines.push(`*Likes:* ${fmt(data.stats.likes)}`)
          lines.push(`*Comentarios:* ${fmt(data.stats.comments)}`)
          lines.push(`*Vistas:* ${fmt(data.stats.views)}`)
          lines.push(`*Compartidos:* ${fmt(data.stats.shares)}`)
        }
        if (data.type === 'video') lines.push(`*Calidad:* ${data.hd ? 'HD' : 'Estandar'}`)
        const caption = lines.join('\n')

        if (data.type === 'image') {
          if (!data.images.length) return msg.reply('[!] Enlace invalido o sin contenido descargable.')
          const medias = data.images.slice(0, 10).map((u, i) => ({ type: 'image', data: { url: u }, caption: i === 0 ? caption : '' }))
          await sock.sendAlbumMessage(msg.chat, medias, { quoted: msg })
          if (data.music) {
            await sock.sendMessage(msg.chat, { audio: { url: data.music }, mimetype: 'audio/mp4', fileName: 'tiktok_audio.mp4' }, { quoted: msg })
          }
        } else {
          if (!data.video) return msg.reply('[!] Enlace invalido o sin contenido descargable.')
          await sock.sendMessage(msg.chat, { video: { url: data.video }, mimetype: 'video/mp4', caption }, { quoted: msg })
        }
        return
      }

      // ===== Busqueda: usa la API de evogb =====
      const results = (await searchTikTok(text)).filter(v => typeof v.dl === 'string' && v.dl.startsWith('http'))
      if (!results.length) return msg.reply('[!] No se encontro contenido valido en TikTok.')

      const medias = results.slice(0, 10).map(v => {
        const caption = [
          '*TikTok Search*',
          '',
          `*Titulo:* ${v.title || 'Sin titulo'}`,
          `*Autor:* ${v.author?.fullname || v.author?.nickname || 'Desconocido'}${v.author?.nickname ? ` @${v.author.nickname}` : ''}`,
          `*Duracion:* ${v.duration || 'N/A'}`,
          `*Likes:* ${fmt(v.stats?.likes)}`,
          `*Comentarios:* ${fmt(v.stats?.comments)}`,
          `*Vistas:* ${fmt(v.stats?.views)}`,
          `*Compartidos:* ${fmt(v.stats?.shares)}`,
          `*Fecha:* ${v.taken_at || 'N/A'}`,
          `*Audio:* ${v.music?.title || 'original sound'}`
        ].join('\n')
        // Se prefiere un enlace HD si la API lo entrega; si no, el enlace sin marca de agua
        return { type: 'video', data: { url: v.hd || v.dl, mimetype: 'video/mp4' }, caption }
      })

      if (medias.length === 1) {
        await sock.sendMessage(msg.chat, { video: medias[0].data, caption: medias[0].caption }, { quoted: msg })
      } else {
        await sock.sendAlbumMessage(msg.chat, medias, { quoted: msg })
      }
    } catch (e) {
      await msg.reply(`> Ocurrio un error al ejecutar el comando *${usedPrefix + command}*. Intenta de nuevo o contacta a soporte si el problema persiste.\n> [Error: *${e.message}*]`)
    }
  },
}