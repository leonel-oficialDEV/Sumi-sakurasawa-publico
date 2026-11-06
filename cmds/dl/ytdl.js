import { sendChannelMessage } from '../../lib/channel.js'
import yts from 'yt-search'
import axios from 'axios'
import { getBuffer } from '#serialize'

const YT = 'https://www.youtube.com'
const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36'
const FALLBACK = { key: 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8', version: '2.20261002.10.00' }
const MAX_RESULTS = 15

const yt = axios.create({
  timeout: 30000,
  headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Origin: YT, Referer: YT + '/' }
})

async function getConfig() {
  try {
    const res = await axios.get(YT + '/?hl=en', {
      timeout: 10000,
      headers: { 'User-Agent': UA, Cookie: 'CONSENT=YES+1; SOCS=CAI' }
    })
    const html = String(res.data)
    const key = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)
    const version = html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/)
    return { key: key ? key[1] : FALLBACK.key, version: version ? version[1] : FALLBACK.version }
  } catch {
    return FALLBACK
  }
}

const txt = (o) => (o ? o.simpleText || (o.runs ? o.runs.map((r) => r.text).join('') : null) : null) || null

function collect(node, out) {
  if (Array.isArray(node)) {
    for (const n of node) collect(n, out)
    return
  }
  if (!node || typeof node !== 'object') return
  if (node.videoRenderer) out.push(node.videoRenderer)
  for (const k in node) {
    if (k !== 'videoRenderer') collect(node[k], out)
  }
}

// Fuente principal: scraper de YouTube (Innertube)
async function scraperSearch(query) {
  const cfg = await getConfig()
  const res = await yt.post(
    `${YT}/youtubei/v1/search?key=${cfg.key}&prettyPrint=false`,
    {
      context: { client: { clientName: 'WEB', clientVersion: cfg.version, hl: 'es', gl: 'CO' } },
      query,
      params: 'EgIQAQ=='
    },
    { headers: { 'X-Youtube-Client-Name': '1', 'X-Youtube-Client-Version': cfg.version } }
  )
  const found = []
  collect(res.data, found)

  const seen = new Set()
  const results = []
  for (const v of found) {
    if (!v.videoId || seen.has(v.videoId)) continue
    seen.add(v.videoId)
    results.push({
      type: 'video',
      title: txt(v.title) || 'Sin título',
      duration: txt(v.lengthText) || 'En vivo',
      published: txt(v.publishedTimeText) || 'N/A',
      views: txt(v.viewCountText) || 'N/A',
      channel: txt(v.ownerText) || 'Desconocido',
      url: `https://www.youtube.com/watch?v=${v.videoId}`,
      thumbnail: `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`
    })
  }
  return results
}

async function ytsFallback(query) {
  const res = await yts(query)
  return res.all
    .map((v) => {
      if (v.type === 'video') {
        return {
          type: 'video',
          title: v.title,
          duration: v.timestamp,
          published: v.ago,
          views: v.views,
          channel: v.author?.name || null,
          url: v.url,
          thumbnail: v.image
        }
      }
      if (v.type === 'channel') {
        return {
          type: 'channel',
          name: v.name,
          url: v.url,
          subs: `${v.subCountLabel} (${v.subCount})`,
          videoCount: v.videoCount,
          thumbnail: v.image
        }
      }
      return null
    })
    .filter(Boolean)
}

function render(v) {
  if (v.type === 'video') {
    return `➩ *Título ›* *${v.title}*

> ⴵ *Duración ›* ${v.duration}
> ❖ *Subido ›* ${v.published}
> ✿ *Vistas ›* ${v.views}${v.channel ? `\n> ❀ *Canal ›* ${v.channel}` : ''}
> ❒ *Url ›* ${v.url}`.trim()
  }
  return `
> ❖ Canal › *${v.name}*
> ❒ Url › ${v.url}
> ❀ Subscriptores › ${v.subs}
> ✿ Videos totales › ${v.videoCount}`.trim()
}

export default {
  command: ['ytsearch', 'search', 'yts'],
  category: 'downloads',
  description: 'Buscar videos de YouTube.',
  run: async ({ msg, sock, args, usedPrefix, command }) => {
    if (!args || !args[0]) {
      return msg.reply('《✧》 Por favor, Ingrese el título de un vídeo.')
    }
    const query = args.join(' ')

    try {
      let results = await scraperSearch(query).catch(() => [])
      if (!results.length) results = await ytsFallback(query).catch(() => [])
      if (!results.length) return msg.reply('《✧》 No se encontraron resultados.')

      results = results.slice(0, MAX_RESULTS)

      const thumb = results.find((r) => r.thumbnail)?.thumbnail
      const Ibuff = thumb ? await getBuffer(thumb).catch(() => null) : null

      const teks2 = `📢 Canal: ${global.links?.channel || 'https://whatsapp.com/channel/0029Vagdmfv1SWt5nfdR4z3w'}\n\n` + results
        .map(render)
        .join('\n\n╾۪〬─ ┄۫╌ ׄ┄┈۪ ─〬 ׅ┄╌ ۫┈ ─ׄ─۪〬 ┈ ┄۫╌ ۫┈ ─ׄ─۪〬 ┈ ┄۫╌ ─ׄ〬╼\n\n')

      await sendChannelMessage(sock, 
        msg.chat,
        Ibuff ? { image: Ibuff, caption: teks2 } : { text: teks2 },
        { quoted: msg }
      )
    } catch (e) {
      msg.reply(`> An unexpected error occurred while executing command *${usedPrefix + command}*. Please try again or contact support if the issue persists.\n> [Error: *${e.message}*]`)
    }
  },
}