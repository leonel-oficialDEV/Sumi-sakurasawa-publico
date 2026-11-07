import db from '#db'
import { proto, generateWAMessageFromContent, prepareWAMessageMedia } from 'baileys'

const MAX_CARDS = 8
const COOLDOWN_MS = 8_000
const IMG_TIMEOUT_MS = 12_000
const IMG_MAX_BYTES = 3 * 1024 * 1024
const BIZ_NODE = true

const API_BASE = 'https://api.stellarwa.xyz'
const API_PATH = '/search/pinterest'
const API_KEY_PARAM = 'key'
const API_TIMEOUT_MS = 12_000
const API_COOLDOWN_MS = 10 * 60 * 1000 
const SCRAPE_TIMEOUT_MS = 15_000

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const IMG_HEADERS = { 'user-agent': UA, referer: 'https://www.pinterest.com/', accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' }

function pinUrl(value) {
  let url
  try { url = new URL(value) } catch { throw new Error('Enlace de Pinterest inválido') }
  const host = url.hostname.toLowerCase()
  if (url.protocol !== 'https:' || url.port || url.username || url.password ||
      !(host === 'pin.it' || /^(?:[a-z]{2,3}\.)?(?:www\.)?pinterest\.(?:com|co\.uk|ca|de|fr|es|it|com\.mx|com\.au|jp|pt)$/.test(host))) {
    throw new Error('Usa un enlace HTTPS de Pinterest o pin.it')
  }
  return url
}

async function resolvePin(value) {
  let url = pinUrl(value)
  for (let hop = 0; hop < 6; hop++) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), SCRAPE_TIMEOUT_MS)
    try {
      const res = await fetch(url, { method: 'GET', redirect: 'manual', headers: { 'user-agent': UA }, signal: ctrl.signal })
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = res.headers.get('location')
        await res.body?.cancel()
        if (!location) throw new Error('Redirección de Pinterest incompleta')
        const next = new URL(location, url)
        if (next.hostname === 'api.pinterest.com' && next.pathname === '/url_shortener/redirect/') {
          const target = next.searchParams.get('url')
          if (!target) throw new Error('El enlace corto no contiene un pin')
          url = pinUrl(target)
        } else url = pinUrl(next.href)
        continue
      }
      await res.body?.cancel()
      if (!res.ok) throw new Error('Pinterest no permitió abrir este enlace')
      const id = url.pathname.match(/^\/pin\/(?:[^/]*--)?(\d+)\/?$/)?.[1]
      if (!id) throw new Error('El enlace debe apuntar a un pin público, no a un perfil o tablero')
      return `https://www.pinterest.com/pin/${id}/`
    } finally { clearTimeout(timer) }
  }
  throw new Error('Demasiadas redirecciones en el enlace')
}

function pinMediaUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.port && !url.username && !url.password &&
      /(^|\.)pinimg\.com$/.test(url.hostname) && !/\.m3u8(?:$|\?)/i.test(url.href) ? url.href : ''
  } catch { return '' }
}

function pinDownloadMedia(data) {
  const source = data?.data
  if (!data?.status || !source) return []
  const downloads = Array.isArray(source.download) ? source.download :
    Array.isArray(source) ? source : [source.download || { url: source.dl, type: source.type }]
  const seen = new Set()
  return downloads.flatMap(item => {
    const url = pinMediaUrl(item?.url)
    if (!url || seen.has(url)) return []
    seen.add(url)
    return [{ type: /video/i.test(item.type || '') || /\.(mp4|mov|webm)(?:$|\?)/i.test(url) ? 'video' : 'image', url }]
  })
}

async function downloadPin(value) {
  const url = await resolvePin(value)
  const base = global.APIs?.delirius?.url || 'https://api.delirius.online'
  const data = await getJson(`${base.replace(/\/$/, '')}/download/pinterestdl?${new URLSearchParams({ url })}`,
    { 'user-agent': UA, accept: 'application/json' }, 45_000)
  const media = pinDownloadMedia(data)
  if (!media.length) throw new Error('El pin no tiene imágenes o videos públicos descargables')
  if (media.length > 30) throw new Error('El álbum supera el máximo de 30 archivos')
  return { media, title: clean(data.data?.title, 180), url }
}

async function downloadSearch(query) {
  const base = global.APIs?.delirius?.url || 'https://api.delirius.online'
  const data = await getJson(`${base.replace(/\/$/, '')}/search/pinterestv2?${new URLSearchParams({ text: query })}`,
    { 'user-agent': UA, accept: 'application/json' }, 25_000)
  return normalize(fromApi(data))
}

const IM = proto.Message.InteractiveMessage
const cooldown = new Map()
let apiDownUntil = 0

const clean = (v, max = 120) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, max)
const str = (v) => (typeof v === 'string' ? v : '')
const http = (v) => (/^https?:\/\/\S+$/i.test(str(v)) ? v : '')
const react = (sock, msg, text) => sock.sendMessage(msg.chat, { react: { text, key: msg.key } }).catch(() => {})

function shuffle(list) {
  const copy = [...list]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

async function getJson(url, headers, timeout) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

function normalize(list) {
  const seen = new Set()
  const out = []
  for (const item of list) {
    if (!item?.image || seen.has(item.image)) continue
    seen.add(item.image)
    out.push(item)
  }
  return out
}

function fromApi(data) {
  const list = [data?.results, data?.result, data?.data, data].find(Array.isArray) || []
  return list.map((it) => {
    if (typeof it === 'string') return { image: http(it) }
    return {
      image: http(it?.image || it?.imageUrl || it?.img || it?.media || it?.url),
      title: str(it?.title || it?.grid_title),
      description: str(it?.description),
      username: str(it?.username || it?.author || it?.pinner?.username),
      link: http(it?.link || it?.pin || it?.source || it?.pinUrl),
    }
  })
}

function fromPinterest(data) {
  const list = data?.resource_response?.data?.results
  return (Array.isArray(list) ? list : []).map((it) => ({
    image: http(it?.images?.['474x']?.url || it?.images?.orig?.url),
    fallback: http(it?.images?.orig?.url),
    title: str(it?.grid_title || it?.title),
    description: str(it?.description),
    username: str(it?.pinner?.username),
    link: it?.id ? `https://www.pinterest.com/pin/${it.id}/` : '',
  }))
}

async function searchApi(query) {
  const key = process.env.STELLARWA_KEY || global.stellarKey || ''
  if (!key || Date.now() < apiDownUntil) return []
  try {
    const url = `${API_BASE}${API_PATH}?${new URLSearchParams({ query, [API_KEY_PARAM]: key })}`
    return normalize(fromApi(await getJson(url, { 'user-agent': UA, accept: 'application/json' }, API_TIMEOUT_MS)))
  } catch (err) {
    apiDownUntil = Date.now() + API_COOLDOWN_MS
    console.error('[ pinterest ] API falló, se usa descarga directa:', err?.message || err)
    return []
  }
}

async function searchDirect(query) {
  const data = {
    options: { isPrefetch: false, query, scope: 'pins', bookmarks: [''], no_fetch_context_on_resource: false, page_size: 40 },
    context: {},
  }
  const url = 'https://www.pinterest.com/resource/BaseSearchResource/get/?' + new URLSearchParams({
    source_url: `/search/pins/?q=${encodeURIComponent(query)}&rs=typed`,
    data: JSON.stringify(data),
    _: String(Date.now()),
  })
  const headers = {
    'user-agent': UA,
    accept: 'application/json, text/javascript, */*, q=0.01',
    'accept-language': 'en-US,en;q=0.9',
    referer: 'https://www.pinterest.com/',
    'x-requested-with': 'XMLHttpRequest',
    'x-pinterest-pws-handler': 'www/search/[scope].js',
  }
  return normalize(fromPinterest(await getJson(url, headers, SCRAPE_TIMEOUT_MS)))
}

async function searchPinterest(query) {
  const viaApi = await searchApi(query)
  if (viaApi.length) return viaApi

  try {
    const fallback = await downloadSearch(query)
    if (fallback.length) return fallback
  } catch (err) { console.error('[ pinterest ] búsqueda alternativa:', err?.message) }

  let direct = []
  try {
    direct = await searchDirect(query)
  } catch (err) {
    console.error('[ pinterest ] descarga directa falló:', err?.message || err)
  }
  if (!direct.length) throw new Error('No encontré imágenes para esa búsqueda')
  return direct
}

async function fetchImage(url) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), IMG_TIMEOUT_MS)
  try {
    const res = await fetch(url, { headers: IMG_HEADERS, signal: ctrl.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    if (!String(res.headers.get('content-type') || '').startsWith('image/')) throw new Error('No es una imagen')
    const buf = Buffer.from(await res.arrayBuffer())
    if (!buf.length || buf.length > IMG_MAX_BYTES) throw new Error('Tamaño de imagen inválido')
    return buf
  } finally {
    clearTimeout(timer)
  }
}

async function loadImage(item) {
  try {
    return await fetchImage(item.image)
  } catch (err) {
    if (!item.fallback || item.fallback === item.image) throw err
    return fetchImage(item.fallback)
  }
}

async function sendCarousel(sock, msg, { intro, footer, cards }) {
  const chat = msg.chat

  const built = await Promise.allSettled(cards.map(async (c) => {
    let timer
    const media = await Promise.race([
      prepareWAMessageMedia({ image: c.image }, { upload: sock.waUploadToServer }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Tiempo de preparación agotado')), 25_000) }),
    ]).finally(() => clearTimeout(timer))
    const buttons = [
      { name: 'cta_url', buttonParamsJson: JSON.stringify({ display_text: 'Abrir pin', url: c.url, merchant_url: c.url }) },
      { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'Ver más', id: c.more }) },
    ]
    return IM.create({
      header: IM.Header.create({ title: c.title, hasMediaAttachment: true, ...media }),
      body: IM.Body.create({ text: c.body }),
      footer: IM.Footer.create({ text: c.footer }),
      nativeFlowMessage: IM.NativeFlowMessage.create({ buttons, messageParamsJson: '' }),
    })
  }))

  const ready = built.filter((r) => r.status === 'fulfilled').map((r) => r.value)
  if (!ready.length) throw new Error('No se pudieron preparar las tarjetas')

  const message = generateWAMessageFromContent(chat, {
    viewOnceMessage: {
      message: {
        messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
        interactiveMessage: IM.create({
          header: IM.Header.create({ hasMediaAttachment: false }),
          body: IM.Body.create({ text: intro }),
          footer: IM.Footer.create({ text: footer }),
          carouselMessage: IM.CarouselMessage.create({ cards: ready, messageVersion: 1 }),
        }),
      },
    },
  }, { quoted: msg, userJid: sock.user.id })

  const additionalNodes = []
  if (BIZ_NODE) {
    additionalNodes.push({
      tag: 'biz',
      attrs: {},
      content: [{ tag: 'interactive', attrs: { type: 'native_flow', v: '1' }, content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }] }],
    })
    if (!chat.endsWith('@g.us')) additionalNodes.push({ tag: 'bot', attrs: { biz_bot: '1' } })
  }

  try {
    await sock.relayMessage(chat, message.message, { messageId: message.key.id, additionalNodes })
  } catch (err) {
    err.pinterestRelayAttempted = true
    throw err
  }
}

async function sendLoose(sock, msg, cards) {
  for (const c of cards.slice(0, 3)) {
    await sock.sendMessage(msg.chat, { image: c.image, caption: `*${c.title}*\n${c.url}` }, { quoted: msg })
  }
}

export default {
  command: ['pinterest', 'pin', 'pint', 'pinterestimg', 'pinimg'],
  category: 'downloads',
  description: 'Busca imágenes en carrusel y descarga pins públicos de Pinterest',
  run: async ({ msg, sock, args, command, usedPrefix: prefix }) => {
    const input = (args || []).join(' ').trim()
    const isLink = /^https?:\/\//i.test(input)
    const query = isLink ? input : clean(input, 100)
    if (query.length > 2048) return sock.reply(msg.chat, '《✧》 El enlace es demasiado largo.', msg)

    if (!query) {
      return sock.reply(
        msg.chat,
        `《✧》 *PINTEREST*\n\nUso: *${prefix + command} <búsqueda o enlace>*\nEjemplo: *${prefix + command} paisajes de anime*\n\n_Recibirás un carrusel con varias imágenes._`,
        msg,
      )
    }

    const now = Date.now()
    if (now - (cooldown.get(msg.sender) || 0) < COOLDOWN_MS) {
      return sock.reply(msg.chat, '《✧》 Espera unos segundos antes de buscar de nuevo.', msg)
    }
    cooldown.set(msg.sender, now)
    if (cooldown.size > 500) for (const [k, t] of cooldown) if (now - t > COOLDOWN_MS) cooldown.delete(k)

    await react(sock, msg, '⏳')

    try {
      if (isLink) {
        const pin = await downloadPin(query)
        const caption = `📌 *PINTEREST*\n\n${pin.title ? pin.title + '\n' : ''}${pin.url}`
        if (pin.media.length > 1) {
          await sock.sendAlbumMessage(msg.chat, pin.media.map((item, index) => ({
            type: item.type, data: { url: item.url }, ...(index === 0 ? { caption } : {}),
          })), { quoted: msg })
        } else {
          const item = pin.media[0]
          await sock.sendMessage(msg.chat, { [item.type]: { url: item.url }, caption }, { quoted: msg })
        }
        await react(sock, msg, '✅')
        return
      }
      const results = await searchPinterest(query)
      const picked = shuffle(results).slice(0, MAX_CARDS + 2)
      const images = await Promise.allSettled(picked.map(loadImage))

      const loaded = picked
        .map((item, i) => ({ item, image: images[i].status === 'fulfilled' ? images[i].value : null }))
        .filter((e) => e.image)
        .slice(0, MAX_CARDS)

      if (!loaded.length) throw new Error('Las imágenes de Pinterest no están disponibles')

      const botId = sock.user.id.split(':')[0] + '@s.whatsapp.net'
      const settings = (await db.getSettings(botId)) || {}
      const botName = sock.subConfig?.name || settings.namebot || 'Bot'
      const footer = `${botName} · Pinterest`
      const more = `${prefix}${command} ${query}`

      const cards = loaded.map(({ item, image }, i) => ({
        image,
        title: clean(item.title, 60) || `📌 ${clean(query, 50)}`,
        body: clean(item.description, 120) || (item.username ? `👤 @${clean(item.username, 40)}` : `Resultado ${i + 1} · desliza para ver más`),
        footer,
        url: item.link || item.image,
        more,
      }))

      const intro = `📌 *PINTEREST*\n\n🔎 *${clean(query, 80)}*\n\n🖼️ ${cards.length} imágenes · desliza el carrusel`

      try {
        await sendCarousel(sock, msg, { intro, footer, cards })
      } catch (err) {
        console.error('[ pinterest ] carrusel:', err?.message || err)
        if (err.pinterestRelayAttempted) throw new Error('No se pudo confirmar el carrusel; no se reenviará para evitar duplicados')
        await sendLoose(sock, msg, cards)
      }

      await react(sock, msg, '✅')
    } catch (err) {
      await react(sock, msg, '❌')
      await sock.reply(msg.chat, `❌ No pude obtener el contenido de Pinterest: ${err?.message || 'error desconocido'}`, msg)
    }
  },
}
