import { sendChannelMessage } from '../../lib/channel.js'
import fetch from 'node-fetch'
import { execFile } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import path from 'path'
import os from 'os'

const execFileAsync = promisify(execFile)

export default {
  command: ['pinterest', 'pin'],
  category: 'downloads',
  description: 'Buscar y descarga imágenes y videos de Pinterest.',
  run: async ({ msg, sock, args, usedPrefix, command }) => {
    const text = args.join(' ').trim()
    if (!text) return msg.reply('《✧》 Por favor, ingresa un término de búsqueda o un enlace de Pinterest.')

    const evogbUrl = global.APIs?.evogb?.url || global.links?.api
    const evogbKey = global.APIs?.evogb?.key
    const deliriusUrl = global.APIs?.delirius?.url
    const vredenUrl = global.APIs?.vreden?.url

    try {
      await sock.sendMessage(msg.chat, { text: '《✧》 Buscando en Pinterest, espera un momento…' }, { quoted: msg })
      if (/^https?:\/\//i.test(text)) {
        const data = await pinterestDownload(text, evogbUrl, evogbKey, deliriusUrl)
        if (!data?.url) return msg.reply('《✧》 No se pudo obtener el contenido del enlace.')

        const caption = `📢 Canal: ${global.links?.channel || 'https://whatsapp.com/channel/0029Vagdmfv1SWt5nfdR4z3w'}\n\nㅤ۟∩ ׅ ★ ׅ 🅟𝖨𝖭 🅓ownload ׄᰙ \n\n${data.title? `𖣣ֶㅤ֯⌗ ☆  ⬭ *Título* › ${data.title}\n` : ''}${data.author? `𖣣ֶㅤ֯⌗ ☆  ⬭ *Autor* › ${data.author}\n` : ''}${data.username? `𖣣ֶㅤ֯⌗ ☆  ⬭ *Usuario* › ${data.username}\n` : ''}${data.uploadDate? `𖣣ֶㅤ֯⌗ ☆  ⬭ *Fecha* › ${data.uploadDate}\n` : ''}𖣣ֶㅤ֯⌗ ☆  ⬭ *Enlace* › ${text}`

        const isVideo = data.type === 'video' || /\.(mp4|mov|webm)(\?|$)/i.test(data.url)

        if (isVideo) {
          const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinterest-'))
          const input = path.join(tempDir, 'input.mp4')
          const output = path.join(tempDir, 'output.mp4')
          try {
            const res = await fetch(data.url)
            if (!res.ok) throw new Error('No se pudo descargar el video')
            fs.writeFileSync(input, Buffer.from(await res.arrayBuffer()))
            try {
              await execFileAsync('ffmpeg', ['-y','-i',input,'-c:v','libx264','-preset','veryfast','-crf','23','-c:a','aac','-movflags','+faststart',output])
              await sendChannelMessage(sock, msg.chat, { video: fs.readFileSync(output), caption, mimetype:'video/mp4', fileName:'pinterest.mp4' }, { quoted: msg })
            } catch {
              // Si ffmpeg falla, manda el original igual como video
              await sendChannelMessage(sock, msg.chat, { video: fs.readFileSync(input), caption, mimetype:'video/mp4', fileName:'pinterest.mp4' }, { quoted: msg })
            }
          } finally { try { fs.rmSync(tempDir, { recursive:true, force:true }) } catch {} }
        } else {
          const buf = await getBuffer(data.url)
          await sendChannelMessage(sock, msg.chat, { image: buf? buf : { url: data.url }, caption }, { quoted: msg })
        }
      } else {
        const results = await pinterestSearch(text, deliriusUrl, vredenUrl)
        if (!results.length) return msg.reply(`《✧》 No se encontraron resultados para *${text}*.`)

        const seen = new Set()
        const picked = results.filter(r => {
          if (!/^https?:\/\//i.test(r.image || '') || seen.has(r.image)) return false
          seen.add(r.image)
          return true
        }).slice(0, 8)
        const loaded = await Promise.allSettled(picked.map(async item => {
          const image = await getBuffer(item.image.replace('/originals/', '/474x/')) || await getBuffer(item.image)
          if (!image) throw new Error('No se pudo descargar una imagen')
          return { item, image }
        }))
        const ready = loaded.filter(r => r.status === 'fulfilled').map(r => r.value)
        if (!ready.length) return msg.reply('《✧》 No se pudieron descargar las imágenes de Pinterest.')
        const cards = ready.map(({ item, image }, i) => ({
          image,
          title: String(item.title || text).slice(0, 60),
          caption: `Resultado ${i + 1} · ${String(item.title || text).slice(0, 100)}`,
          footer: 'Sumi Sakurasawa · Pinterest',
          nativeFlow: [
            { text: 'Abrir pin', url: item.link || item.image },
            { text: 'Ver más', id: `${usedPrefix || '.'}pinterest ${text}` }
          ]
        }))
        await sock.sendMessage(msg.chat, {
          text: `📌 *PINTEREST*\n\n🔎 ${text}\n🖼️ ${cards.length} imágenes · desliza para verlas`,
          footer: 'Sumi Sakurasawa · Pinterest',
          cards
        }, { quoted: msg, mediaUploadTimeoutMs: 25000 })
        if (ready.length < picked.length) await msg.reply(`《✧》 Se enviaron ${ready.length} de ${picked.length} imágenes; las restantes no se pudieron descargar.`)
      }
    } catch (e) {
      await msg.reply(`> Ocurrió un error al ejecutar el comando *${usedPrefix + command}*.\n> [Error: *${e.message}*]`)
    }
  }
}

async function pinterestDownload(url, evogbUrl, evogbKey, deliriusUrl) {
  const endpoints = []
  if (evogbUrl) endpoints.push(`${evogbUrl}/dl/pinterest?url=${encodeURIComponent(url)}${evogbKey? `&key=${evogbKey}` : ''}`)
  if (deliriusUrl) endpoints.push(`${deliriusUrl}/download/pinterestdl?url=${encodeURIComponent(url)}`)

  for (const endpoint of endpoints) {
    try {
      const r = await fetch(endpoint, { signal: AbortSignal.timeout(20000) })
      if (!r.ok) continue
      const res = await r.json()
      
      let dlUrl = null
      let rawType = 'image'
      let meta = {}

      if (res?.status && res?.data?.dl) {
        dlUrl = res.data.dl
        rawType = res.data.type
        meta = res.data
      } else if (res?.status && res?.data?.download?.url) {
        dlUrl = res.data.download.url
        rawType = res.data.download.type
        meta = res.data
      }

      if (dlUrl) {
        const isVideoByUrl = /\.(mp4|mov|webm|m3u8)(\?|$)/i.test(dlUrl) || dlUrl.includes('pinimg.com/videos') || dlUrl.includes('v.pinimg')
        const isVideoByType = String(rawType).toLowerCase().includes('video')
        const finalType = (isVideoByUrl || isVideoByType) ? 'video' : 'image'

        return { 
          type: finalType, 
          url: dlUrl, 
          title: meta.title, 
          author: meta.author || meta.author_name, 
          username: meta.username, 
          uploadDate: meta.uploadDate || meta.upload 
        }
      }
    } catch {}
  }
  return null
}

async function pinterestSearch(query, deliriusUrl, vredenUrl) {
  const endpoints = []
  if (deliriusUrl) {
    endpoints.push(`${deliriusUrl}/search/pinterestv2?text=${encodeURIComponent(query)}`)
    endpoints.push(`${deliriusUrl}/search/pinterest?text=${encodeURIComponent(query)}`)
  }
  if (vredenUrl) {
    endpoints.push(`${vredenUrl}/api/v1/search/pinterest?query=${encodeURIComponent(query)}`)
    endpoints.push(`${vredenUrl}/api/v2/search/pinterest?query=${encodeURIComponent(query)}&limit=10&type=videos`)
  }

  for (const endpoint of endpoints) {
    try {
      const r = await fetch(endpoint, { signal: AbortSignal.timeout(20000) })
      if (!r.ok) continue
      const res = await r.json()
      if (res?.data?.length) {
        const m = res.data.map(d => ({ image: d.hd || d.image || d.image_url, title: d.title || query })).filter(x=>x.image)
        if (m.length) return m
      }
      if (res?.response?.pins?.length) {
        const m = res.response.pins.map(p => ({ image: p.media?.images?.orig?.url })).filter(x=>x.image)
        if (m.length) return m
      }
      if (res?.results?.length) {
        const m = res.results.map(x => ({ image: typeof x === 'string'? x : x?.image || x?.url })).filter(x=>x.image)
        if (m.length) return m
      }
    } catch {}
  }
  return []
}

async function getBuffer(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12000), headers: { 'user-agent': 'Mozilla/5.0', 'referer': 'https://www.pinterest.com/' } })
    if (!res.ok) return null
    return Buffer.from(await res.arrayBuffer())
  } catch { return null }
}