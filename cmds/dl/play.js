import { sendChannelMessage } from '../../lib/channel.js'
import axios from 'axios'
import yts from 'yt-search'
import { getBuffer } from '#serialize'

const YT = 'https://www.youtube.com'
const CNV = 'https://cnv.cx/v2'
const FRAME = 'https://frame.y2meta-uk.com'
const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36'
const FALLBACK = { key: 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8', version: '2.20261002.10.00' }

const MP4_QUALITIES = [1080, 720, 360, 240, 144]
const MP3_QUALITIES = [320, 256, 128]
const DEFAULT_MP4 = 720
const DEFAULT_MP3 = 128
const MAX_SECONDS = 30 * 60

const REGISTROS = new Map()
const DESCARGAS_ACTIVAS = new Set()
const SOCKETS_REGISTRADOS = new WeakSet()

const yt = axios.create({
  timeout: 30000,
  headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Origin: YT, Referer: YT + '/' }
})

const cnv = axios.create({
  timeout: 30000,
  headers: { 'User-Agent': UA, Referer: FRAME + '/', Origin: FRAME }
})

async function getConfig() {
  try {
    const res = await axios.get(YT + '/?hl=en', { timeout: 10000, headers: { 'User-Agent': UA, Cookie: 'CONSENT=YES+1; SOCS=CAI' } })
    const html = String(res.data)
    const key = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)
    const version = html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/)
    return { key: key ? key[1] : FALLBACK.key, version: version ? version[1] : FALLBACK.version }
  } catch { return FALLBACK }
}

const txt = (o) => (o ? o.simpleText || (o.runs ? o.runs.map((r) => r.text).join('') : null) : null) || null

function collect(node, out) {
  if (Array.isArray(node)) { for (const n of node) collect(n, out); return }
  if (!node || typeof node !== 'object') return
  if (node.videoRenderer) out.push(node.videoRenderer)
  for (const k in node) { if (k !== 'videoRenderer') collect(node[k], out) }
}

const toSeconds = (d) => (d ? d.split(':').reverse().reduce((a, v, i) => a + Number(v) * 60 ** i, 0) : 0)

function extractVideoId(input) {
  const s = String(input).trim()
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s
  const m = s.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/))([A-Za-z0-9_-]{11})/)
  return m ? m[1] : null
}

async function getInfoById(videoId) {
  try {
    const res = await axios.get(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`, { timeout: 10000 })
    return { videoId, title: res.data.title || 'Sin título', channel: res.data.author_name || 'Desconocido', duration: null, thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` }
  } catch {
    return { videoId, title: 'Sin título', channel: 'Desconocido', duration: null, thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` }
  }
}

async function getKey(videoId) {
  const res = await cnv.get(`${CNV}/sanity/key?id=${videoId}`)
  return res.data.key
}

async function convert(key, videoId, format, videoQuality, audioBitrate) {
  const res = await cnv.post(`${CNV}/converter`,
    new URLSearchParams({ link: `https://youtu.be/${videoId}`, format, audioBitrate: String(audioBitrate), videoQuality: String(videoQuality), filenameStyle: 'pretty', vCodec: 'h264' }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded', accept: '*/*', key } }
  )
  return (res.data && res.data.url) || null
}

async function convertWithFallback(videoId, isAudio, wanted) {
  const key = await getKey(videoId)
  const list = isAudio ? MP3_QUALITIES : MP4_QUALITIES
  const start = list.indexOf(wanted)
  const order = list.slice(start === -1 ? 0 : start)
  for (const q of order) {
    const url = isAudio
      ? await convert(key, videoId, 'mp3', 720, q).catch(() => null)
      : await convert(key, videoId, 'mp4', q, 128).catch(() => null)
    if (url) return { url, quality: isAudio ? `${q}kbps` : `${q}p` }
  }
  return null
}

function desenvolverMensaje(msg) {
  let mensaje = msg?.message
  for (let i = 0; i < 8 && mensaje; i++) {
    const envoltura = mensaje.ephemeralMessage || mensaje.viewOnceMessage || mensaje.viewOnceMessageV2 || mensaje.viewOnceMessageV2Extension || mensaje.documentWithCaptionMessage || mensaje.deviceSentMessage
    if (!envoltura?.message) break
    mensaje = envoltura.message
  }
  return mensaje || {}
}

function obtenerTexto(msg) {
  const m = desenvolverMensaje(msg)
  return (m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || m.documentMessage?.caption || '').trim()
}

function obtenerContexto(msg) {
  const m = desenvolverMensaje(msg)
  return (m.extendedTextMessage?.contextInfo || m.imageMessage?.contextInfo || m.videoMessage?.contextInfo || m.documentMessage?.contextInfo || null)
}

function obtenerChatId(msg) { return msg?.key?.remoteJid || msg?.chat || '' }
function normalizarJid(jid) { return String(jid || '').split(':')[0].trim().toLowerCase() }

function obtenerJidUsuario(msg, sock) {
  const chatId = obtenerChatId(msg)
  if (msg?.key?.fromMe) return normalizarJid(sock?.user?.id || sock?.user?.jid || msg?.key?.participant || '')
  if (chatId.endsWith('@g.us')) return normalizarJid(msg?.key?.participant || msg?.participant || msg?.key?.participantAlt || '')
  return normalizarJid(msg?.key?.participant || msg?.participant || chatId)
}

function mismoUsuario(a, b) {
  a = normalizarJid(a); b = normalizarJid(b)
  if (!a || !b) return false
  if (a === b) return true
  return a.split('@')[0] === b.split('@')[0]
}

function formatearDuracion(segundos = 0) {
  segundos = Number(segundos) || 0
  const horas = Math.floor(segundos / 3600)
  const minutos = Math.floor((segundos % 3600) / 60)
  const segundosRestantes = Math.floor(segundos % 60)
  return horas ? `${horas}:${String(minutos).padStart(2, '0')}:${String(segundosRestantes).padStart(2, '0')}` : `${minutos}:${String(segundosRestantes).padStart(2, '0')}`
}

function limpiarTexto(texto = '') {
  return String(texto).replace(/[\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80)
}

async function buscarVideo(texto) {
  const vid = extractVideoId(texto)
  if (vid) {
    const r = await yts(`https://www.youtube.com/watch?v=${vid}`)
    if (r.videos?.[0]) return r.videos[0]
    const info = await getInfoById(vid)
    return { videoId: info.videoId, title: info.title, author: { name: info.channel }, thumbnail: info.thumbnail, timestamp: info.duration || '', seconds: toSeconds(info.duration), url: `https://www.youtube.com/watch?v=${vid}` }
  }
  const resultado = await yts(texto)
  if (!resultado.videos?.length) throw new Error('No se encontraron resultados.')
  return resultado.videos[0]
}

async function procesarRespuesta(sock, msg) {
  const texto = obtenerTexto(msg).toLowerCase().trim()
  if (!['a', 'v'].includes(texto)) return
  const chatId = obtenerChatId(msg)
  const contexto = obtenerContexto(msg)
  const sentId = contexto?.stanzaId
  if (!chatId || !sentId) return
  const registro = REGISTROS.get(`${chatId}:${sentId}`)
  if (!registro) return
  if (!mismoUsuario(obtenerJidUsuario(msg, sock), registro.solicitante)) return
  const tipo = texto === 'a' ? 'audio' : 'video'
  const clave = `${chatId}:${sentId}:${tipo}`
  if (DESCARGAS_ACTIVAS.has(clave)) return
  DESCARGAS_ACTIVAS.add(clave)
  try {
    await sendChannelMessage(sock, chatId, { react: { text: '🕒', key: msg.key } })
    const isAudio = tipo === 'audio'
    const wanted = isAudio ? DEFAULT_MP3 : DEFAULT_MP4
    const result = await convertWithFallback(registro.videoId, isAudio, wanted)
    if (!result) throw new Error('No se pudo convertir.')
    const safeName = limpiarTexto(registro.titulo) || 'youtube'
    const send = (media) => sendChannelMessage(sock, chatId, isAudio
      ? { audio: media, mimetype: 'audio/mpeg', fileName: `${safeName}.mp3` }
      : { video: media, mimetype: 'video/mp4', fileName: `${safeName}.mp4`, caption: `📢 Canal: ${global.links?.channel || 'https://whatsapp.com/channel/0029Vagdmfv1SWt5nfdR4z3w'}\n\n➩ ${registro.titulo}\n✎ Calidad: ${result.quality}` }
      , { quoted: msg })
    try { await send({ url: result.url }) }
    catch {
      const res = await cnv.get(result.url, { responseType: 'arraybuffer', timeout: 180000 })
      await send(Buffer.from(res.data))
    }
    await sendChannelMessage(sock, chatId, { react: { text: '✅', key: msg.key } })
  } catch (error) {
    await sendChannelMessage(sock, chatId, { react: { text: '❌', key: msg.key } }).catch(() => {})
    await sendChannelMessage(sock, chatId, { text: `《✧》 No se pudo descargar el ${tipo}.\n\n> Error: ${String(error?.message || error).slice(0, 700)}` }, { quoted: msg }).catch(() => {})
  } finally {
    DESCARGAS_ACTIVAS.delete(clave)
  }
}

function registrarEscucha(sock) {
  if (!sock || SOCKETS_REGISTRADOS.has(sock)) return
  SOCKETS_REGISTRADOS.add(sock)
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages || []) {
      if (!msg?.message) continue
      try { await procesarRespuesta(sock, msg) } catch {}
    }
  })
}

export default {
  command: ['play', 'mp3', 'playaudio', 'ytaudio', 'ytmp3', 'yta', 'play2', 'playvid', 'ytmp4', 'mp4', 'ytv', 'ytdl'],
  category: 'downloader',
  async before({ sock }) { if (sock) registrarEscucha(sock) },
  run: async ({ sock, msg, args, text, command }) => {
    const chatId = obtenerChatId(msg)
    const opciones = chatId.endsWith('@newsletter') ? undefined : { quoted: msg }
    const consulta = (text || args?.join(' ') || '').trim()
    try {
      registrarEscucha(sock)
      if (!consulta) {
        return sendChannelMessage(sock, chatId, { text: `《✧》 Uso: *${command}* <nombre o link>\n\n> Ej: ${command} diles - Bad Bunny` }, opciones)
      }
      const isAudioCommand = ['play', 'mp3', 'playaudio', 'ytaudio', 'ytmp3', 'yta'].includes(command)
      const isVideoCommand = ['play2', 'playvid', 'ytmp4', 'mp4', 'ytv', 'ytdl'].includes(command)
      await sendChannelMessage(sock, chatId, { react: { text: '🕒', key: msg.key } })
      const video = await buscarVideo(consulta)
      const videoId = video.videoId || extractVideoId(video.url) || extractVideoId(consulta)
      if (!videoId) throw new Error('No se pudo obtener el ID del video.')
      const secs = Number(video.seconds) || toSeconds(video.timestamp)
      if (secs && secs > MAX_SECONDS) {
        return sendChannelMessage(sock, chatId, { text: `ꕤ El video dura *${video.timestamp}* y supera el límite de *${MAX_SECONDS / 60} min*.` }, opciones)
      }
      let informacion = `📢 Canal: ${global.links?.channel || 'https://whatsapp.com/channel/0029Vagdmfv1SWt5nfdR4z3w'}\n\n➩ *${video.title}*\n\n`
      informacion += `> ❖ Canal › *${video.author?.name || 'Desconocido'}*\n`
      informacion += `> ⴵ Duración › *${video.timestamp || formatearDuracion(secs)}*\n`
      informacion += `> ❀ Vistas › *${Number(video.views || 0).toLocaleString()}*\n`
      informacion += `> ❒ Link › ${video.url}\n\n`
      informacion += `> _Descargando ${isAudioCommand ? 'audio' : 'video'} espera..._`
      try {
        await sendChannelMessage(sock, chatId, { image: await getBuffer(video.thumbnail), caption: informacion }, opciones)
      } catch {
        await sendChannelMessage(sock, chatId, { text: informacion }, opciones)
      }
      if (isAudioCommand) {
        const result = await convertWithFallback(videoId, true, DEFAULT_MP3)
        if (!result) throw new Error('No se pudo convertir el audio.')
        const safeName = limpiarTexto(video.title) || 'youtube'
        try {
          await sendChannelMessage(sock, chatId, { audio: { url: result.url }, mimetype: 'audio/mpeg', fileName: `${safeName}.mp3`, ptt: false }, opciones)
        } catch {
          const res = await cnv.get(result.url, { responseType: 'arraybuffer', timeout: 180000 })
          await sendChannelMessage(sock, chatId, { audio: Buffer.from(res.data), mimetype: 'audio/mpeg', fileName: `${safeName}.mp3` }, opciones)
        }
        await sendChannelMessage(sock, chatId, { react: { text: '✅', key: msg.key } })
        return
      }
      if (isVideoCommand) {
        const result = await convertWithFallback(videoId, false, DEFAULT_MP4)
        if (!result) throw new Error('No se pudo convertir el video.')
        const safeName = limpiarTexto(video.title) || 'youtube'
        try {
          await sendChannelMessage(sock, chatId, { video: { url: result.url }, mimetype: 'video/mp4', fileName: `${safeName}.mp4`, caption: `📢 Canal: ${global.links?.channel || 'https://whatsapp.com/channel/0029Vagdmfv1SWt5nfdR4z3w'}\n\n➩ ${video.title}\n✎ Calidad: ${result.quality}` }, opciones)
        } catch {
          const res = await cnv.get(result.url, { responseType: 'arraybuffer', timeout: 180000 })
          await sendChannelMessage(sock, chatId, { video: Buffer.from(res.data), mimetype: 'video/mp4', fileName: `${safeName}.mp4`, caption: `📢 Canal: ${global.links?.channel || 'https://whatsapp.com/channel/0029Vagdmfv1SWt5nfdR4z3w'}\n\n➩ ${video.title}` }, opciones)
        }
        await sendChannelMessage(sock, chatId, { react: { text: '✅', key: msg.key } })
        return
      }
      let infoSelect = `📢 Canal: ${global.links?.channel || 'https://whatsapp.com/channel/0029Vagdmfv1SWt5nfdR4z3w'}\n\n➩ Descargando › ${video.title}\n\n`
      infoSelect += `> ❖ Canal › *${video.author?.name || 'Desconocido'}*\n`
      infoSelect += `> ⴵ Duración › *${video.timestamp || formatearDuracion(secs)}*\n`
      infoSelect += `> ❀ Vistas › *${Number(video.views || 0).toLocaleString()}*\n`
      infoSelect += `> ❒ YouTube › *${video.url}*\n\n`
      infoSelect += '*Responde a este mensaje con:*\n'
      infoSelect += '> *a* para audio\n'
      infoSelect += '> *v* para video'
      let enviado
      try {
        enviado = await sendChannelMessage(sock, chatId, { image: await getBuffer(video.thumbnail), caption: infoSelect }, opciones)
      } catch {
        enviado = await sendChannelMessage(sock, chatId, { text: infoSelect }, opciones)
      }
      if (!enviado?.key?.id) throw new Error('No se pudo registrar el mensaje.')
      REGISTROS.set(`${chatId}:${enviado.key.id}`, { url: video.url, videoId, titulo: video.title, duracion: secs, solicitante: obtenerJidUsuario(msg, sock) })
      if (REGISTROS.size > 500) {
        const primera = REGISTROS.keys().next().value
        if (primera) REGISTROS.delete(primera)
      }
      setTimeout(() => { REGISTROS.delete(`${chatId}:${enviado.key.id}`) }, 900000).unref?.()
      await sendChannelMessage(sock, chatId, { react: { text: '✅', key: msg.key } })
    } catch (error) {
      await sendChannelMessage(sock, chatId, { react: { text: '❌', key: msg.key } }).catch(() => {})
      await sendChannelMessage(sock, chatId, { text: `《✧》 Error: ${String(error?.message || error).slice(0, 800)}` }, opciones).catch(() => {})
    }
  }
}