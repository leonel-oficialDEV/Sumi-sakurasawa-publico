import yts from 'yt-search'
import { getBuffer } from '#serialize'
import fs from 'fs'
import path from 'path'

const YTDLP_PATH = '/home/container/yt-dlp'
const COOKIES_PATH = '/home/container/cookies.txt'
const TMP_DIR = '/home/container/tmp'
const MAX_INTENTOS_DESCARGA = 3
const REGISTROS = new Map()
const DESCARGAS_ACTIVAS = new Set()
const SOCKETS_REGISTRADOS = new WeakSet()

let ytDlp
let colaLimpieza = Promise.resolve()

process.env.TMPDIR = TMP_DIR
process.env.TMP = TMP_DIR
process.env.TEMP = TMP_DIR

function esperar(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function cargarYtDlp() {
  if (ytDlp) return ytDlp

  const modulo = await import('yt-dlp-wrap-plus')
  const YTDlpWrap =
    modulo.default?.default ||
    modulo.default ||
    modulo.YTDlpWrap

  if (!YTDlpWrap) {
    throw new Error('No se pudo cargar yt-dlp-wrap-plus.')
  }

  if (!fs.existsSync(YTDLP_PATH)) {
    throw new Error(`No se encontró el ejecutable: ${YTDLP_PATH}`)
  }

  try {
    fs.chmodSync(YTDLP_PATH, 0o755)
  } catch {}

  const instancia = new YTDlpWrap(YTDLP_PATH)
  await instancia.execPromise(['--version'])

  ytDlp = instancia
  return ytDlp
}

function limpiarTmp() {
  fs.mkdirSync(TMP_DIR, { recursive: true })

  let eliminados = 0
  let errores = 0

  for (const nombre of fs.readdirSync(TMP_DIR)) {
    const archivo = path.join(TMP_DIR, nombre)

    try {
      const stat = fs.lstatSync(archivo)

      if (stat.isSymbolicLink()) {
        fs.unlinkSync(archivo)
      } else {
        fs.rmSync(archivo, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 200
        })
      }

      eliminados++
    } catch {
      errores++
    }
  }

  return { eliminados, errores }
}

async function limpiarTmpSeguro() {
  const anterior = colaLimpieza

  let liberar
  colaLimpieza = new Promise(resolve => {
    liberar = resolve
  })

  await anterior

  try {
    return limpiarTmp()
  } finally {
    liberar()
  }
}

function desenvolverMensaje(msg) {
  let mensaje = msg?.message

  for (let i = 0; i < 8 && mensaje; i++) {
    const envoltura =
      mensaje.ephemeralMessage ||
      mensaje.viewOnceMessage ||
      mensaje.viewOnceMessageV2 ||
      mensaje.viewOnceMessageV2Extension ||
      mensaje.documentWithCaptionMessage ||
      mensaje.deviceSentMessage

    if (!envoltura?.message) break
    mensaje = envoltura.message
  }

  return mensaje || {}
}

function obtenerTexto(msg) {
  const m = desenvolverMensaje(msg)

  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    ''
  ).trim()
}

function obtenerContexto(msg) {
  const m = desenvolverMensaje(msg)

  return (
    m.extendedTextMessage?.contextInfo ||
    m.imageMessage?.contextInfo ||
    m.videoMessage?.contextInfo ||
    m.documentMessage?.contextInfo ||
    null
  )
}

function obtenerChatId(msg) {
  return msg?.key?.remoteJid || msg?.chat || ''
}

function normalizarJid(jid) {
  return String(jid || '').split(':')[0].trim().toLowerCase()
}

function obtenerJidUsuario(msg, sock) {
  const chatId = obtenerChatId(msg)

  if (msg?.key?.fromMe) {
    return normalizarJid(
      sock?.user?.id ||
      sock?.user?.jid ||
      msg?.key?.participant ||
      ''
    )
  }

  if (chatId.endsWith('@g.us')) {
    return normalizarJid(
      msg?.key?.participant ||
      msg?.participant ||
      msg?.key?.participantAlt ||
      ''
    )
  }

  return normalizarJid(
    msg?.key?.participant ||
    msg?.participant ||
    chatId
  )
}

function mismoUsuario(a, b) {
  a = normalizarJid(a)
  b = normalizarJid(b)

  if (!a || !b) return false
  if (a === b) return true

  const tipoA = a.split('@')[1]
  const tipoB = b.split('@')[1]

  return (
    tipoA === tipoB &&
    ['s.whatsapp.net', 'lid'].includes(tipoA) &&
    a.split('@')[0] === b.split('@')[0]
  )
}

function formatearDuracion(segundos = 0) {
  segundos = Number(segundos) || 0

  const horas = Math.floor(segundos / 3600)
  const minutos = Math.floor((segundos % 3600) / 60)
  const segundosRestantes = Math.floor(segundos % 60)

  return horas
    ? `${horas}:${String(minutos).padStart(2, '0')}:${String(segundosRestantes).padStart(2, '0')}`
    : `${minutos}:${String(segundosRestantes).padStart(2, '0')}`
}

function limpiarTexto(texto = '') {
  return String(texto)
    .replace(/[\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150)
}

async function buscarVideo(texto) {
  const resultado = await yts(texto)

  if (!resultado.videos?.length) {
    throw new Error('No se encontraron resultados.')
  }

  return resultado.videos[0]
}

async function obtenerUrlDirecta(url, tipo) {
  const downloader = await cargarYtDlp()
  let ultimoError

  for (let intento = 1; intento <= MAX_INTENTOS_DESCARGA; intento++) {
    try {
      await limpiarTmpSeguro()

      const argumentos = [
        '--ignore-config',
        '--no-playlist',
        '--no-warnings',
        '--no-cache-dir',
        '--retries', '5',
        '--fragment-retries', '5',
        '--extractor-retries', '3',
        '--js-runtimes', 'node',
        '--remote-components', 'ejs:github'
      ]

      if (fs.existsSync(COOKIES_PATH)) {
        argumentos.push('--cookies', COOKIES_PATH)
      }

      if (tipo === 'audio') {
        argumentos.push(
          '-f',
          'bestaudio[ext=m4a]/bestaudio',
          '--get-url'
        )
      } else {
        argumentos.push(
          '-f',
          'best[ext=mp4][height<=720]/best[height<=720]/best',
          '--get-url'
        )
      }

      argumentos.push(url)

      const resultado = await downloader.execPromise(argumentos)
      const urls = String(resultado || '')
        .split(/\r?\n/)
        .map(linea => linea.trim())
        .filter(linea => /^https?:\/\//i.test(linea))

      if (!urls.length) {
        throw new Error('yt-dlp no devolvió una URL directa.')
      }

      if (tipo === 'video' && urls.length > 1) {
        throw new Error(
          'El video requiere combinar varias pistas. No se puede garantizar el envío directo sin procesar archivos.'
        )
      }

      return urls[0]
    } catch (error) {
      ultimoError = error

      if (intento < MAX_INTENTOS_DESCARGA) {
        await esperar(intento * 1500)
      }
    } finally {
      await limpiarTmpSeguro().catch(() => {})
    }
  }

  throw new Error(
    `No se pudo obtener la URL después de ${MAX_INTENTOS_DESCARGA} intentos: ${String(ultimoError?.message || ultimoError).slice(0, 600)}`
  )
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

  if (!mismoUsuario(obtenerJidUsuario(msg, sock), registro.solicitante)) {
    return
  }

  const tipo = texto === 'a' ? 'audio' : 'video'
  const clave = `${chatId}:${sentId}:${tipo}`

  if (DESCARGAS_ACTIVAS.has(clave)) return

  DESCARGAS_ACTIVAS.add(clave)

  try {
    await sock.sendMessage(chatId, {
      react: { text: '🕒', key: msg.key }
    })

    const urlDirecta = await obtenerUrlDirecta(registro.url, tipo)
    const nombre = limpiarTexto(registro.titulo) || tipo
    const comoDocumento = Number(registro.duracion) > 1200

    if (tipo === 'audio') {
      await sock.sendMessage(
        chatId,
        comoDocumento
          ? {
              document: { url: urlDirecta },
              mimetype: 'audio/mp4',
              fileName: `${nombre}.m4a`,
              caption: `➩ ${registro.titulo}`
            }
          : {
              audio: { url: urlDirecta },
              mimetype: 'audio/mp4',
              fileName: `${nombre}.m4a`,
              ptt: false
            },
        { quoted: msg }
      )
    } else {
      await sock.sendMessage(
        chatId,
        comoDocumento
          ? {
              document: { url: urlDirecta },
              mimetype: 'video/mp4',
              fileName: `${nombre}.mp4`,
              caption: `➩ ${registro.titulo}`
            }
          : {
              video: { url: urlDirecta },
              mimetype: 'video/mp4',
              fileName: `${nombre}.mp4`,
              caption: `➩ ${registro.titulo}`
            },
        { quoted: msg }
      )
    }

    await sock.sendMessage(chatId, {
      react: { text: '✅', key: msg.key }
    })
  } catch (error) {
    await sock.sendMessage(chatId, {
      react: { text: '❌', key: msg.key }
    }).catch(() => {})

    await sock.sendMessage(
      chatId,
      {
        text: `《✧》 No se pudo obtener o enviar el ${tipo}.\n\n> Error: ${String(error?.message || error).slice(0, 700)}`
      },
      { quoted: msg }
    ).catch(() => {})
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

      try {
        await procesarRespuesta(sock, msg)
      } catch {}
    }
  })
}

export default {
  command: ['play', 'mp3', 'playaudio', 'ytaudio', 'play2', 'playvid'],
  category: 'downloader',

  async before({ sock }) {
    if (sock) registrarEscucha(sock)
  },

  run: async ({ sock, msg, args, text }) => {
    const chatId = obtenerChatId(msg)
    const opciones = chatId.endsWith('@newsletter')
      ? undefined
      : { quoted: msg }

    const consulta = (text || args?.join(' ') || '').trim()

    try {
      registrarEscucha(sock)

      if (!consulta) {
        return sock.sendMessage(
          chatId,
          {
            text: '《✧》 Escribe el nombre o la URL del video de YouTube.'
          },
          opciones
        )
      }

      await sock.sendMessage(chatId, {
        react: { text: '🕒', key: msg.key }
      })

      const video = await buscarVideo(consulta)
      const titulo = video.title || consulta
      const url = video.url
      const miniatura = video.thumbnail
      const duracion = Number(video.seconds) || 0

      let informacion = `➩ Descargando › ${titulo}\n\n`
      informacion += `> ❖ Canal › *${video.author?.name || 'Desconocido'}*\n`
      informacion += `> ⴵ Duración › *${video.timestamp || formatearDuracion(duracion)}*\n`
      informacion += `> ❀ Vistas › *${Number(video.views || 0).toLocaleString()}*\n`
      informacion += `> ❒ YouTube › *${url}*\n\n`
      informacion += '*Responde a este mensaje con:*\n'
      informacion += '> *a* para descargar audio\n'
      informacion += '> *v* para descargar video'

      let enviado

      if (miniatura) {
        try {
          enviado = await sock.sendMessage(
            chatId,
            {
              image: await getBuffer(miniatura),
              caption: informacion
            },
            opciones
          )
        } catch {
          enviado = await sock.sendMessage(
            chatId,
            { text: informacion },
            opciones
          )
        }
      } else {
        enviado = await sock.sendMessage(
          chatId,
          { text: informacion },
          opciones
        )
      }

      if (!enviado?.key?.id) {
        throw new Error('No se pudo registrar el mensaje de selección.')
      }

      REGISTROS.set(`${chatId}:${enviado.key.id}`, {
        url,
        titulo,
        duracion,
        solicitante: obtenerJidUsuario(msg, sock)
      })

      if (REGISTROS.size > 500) {
        const primeraClave = REGISTROS.keys().next().value
        if (primeraClave) REGISTROS.delete(primeraClave)
      }

      setTimeout(() => {
        REGISTROS.delete(`${chatId}:${enviado.key.id}`)
      }, 900000).unref?.()

      await sock.sendMessage(chatId, {
        react: { text: '✅', key: msg.key }
      })
    } catch (error) {
      await sock.sendMessage(chatId, {
        react: { text: '❌', key: msg.key }
      }).catch(() => {})

      await sock.sendMessage(
        chatId,
        {
          text: `《✧》 Error: ${String(error?.message || error).slice(0, 800)}`
        },
        opciones
      ).catch(() => {})
    }
  }
}