
import fetch from 'node-fetch'
import yts from 'yt-search'
import fs from 'fs'
import os from 'os'
import { spawn } from 'child_process'
import { pipeline } from 'stream/promises'
import { Readable } from 'stream'

const BASE = () => String(global.APIs?.evogb?.url || global.links?.api || 'https://api.evogb.org').replace(/\/$/, '')
const KEY = () => global.APIs?.evogb?.key

const route = (name) => global.APIs?.evogb?.routes?.[name]

export const QUALITIES = ['144p', '240p', '360p', '480p', '720p', '1080p']
export const DEFAULT_QUALITY = '480p'
export const MAX_SECONDS = 25 * 60

const MAX_BYTES = 120 * 1024 * 1024
const API_TIMEOUT = 60000
const SEARCH_TIMEOUT = 20000
const DL_TIMEOUT = 5 * 60 * 1000

export const isYT = (t) => /(youtube\.com|youtu\.be)\//i.test(t)

const tooBig = () => {
  const e = new Error('El archivo supera los 120 MB')
  e.code = 'TOO_BIG'
  return e
}

const toSeconds = (d) => {
  if (d === undefined || d === null || d === '') return 0
  if (typeof d === 'number') return d
  const s = String(d).trim()
  if (/^\d+$/.test(s)) return Number(s)
  const p = s.split(':').map(Number)
  if (p.some(isNaN)) return 0
  return p.reduce((a, v) => a * 60 + v, 0)
}

async function api(path, params) {
  const key = KEY()
  if (!key) {
    console.error('[yt] Falta global.APIs.evogb.key en settings.js')
    return null
  }
  if (!path) {
    console.error('[yt] Falta una ruta en global.APIs.evogb.routes (settings.js)')
    return null
  }
  const qs = new URLSearchParams({ ...params, key }).toString()
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), API_TIMEOUT)
  try {
    const res = await fetch(`${BASE()}${path}?${qs}`, {
      headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' },
      signal: ctrl.signal
    })
    if (!res.ok) {
      console.error(`[yt] ${path} respondió ${res.status}`)
      return null
    }
    const json = await res.json()
    const d = json?.data || json?.result || null
    if (!d) console.error(`[yt] ${path} sin data: ${JSON.stringify(json).slice(0, 200)}`)
    return d
  } catch (e) {
    console.error(`[yt] ${path} falló: ${e.name === 'AbortError' ? `sin respuesta en ${API_TIMEOUT / 1000}s` : e.message}`)
    return null
  } finally {
    clearTimeout(t)
  }
}

async function media(path, params) {
  const d = await api(path, params)
  if (!d) return null
  if (Array.isArray(d)) {
    console.error(`[yt] ${path} devolvió una lista, se esperaba un objeto: ${JSON.stringify(d).slice(0, 200)}`)
    return null
  }
  const dl = d.dl || d.download || d.url || d.video || d.audio
  if (!dl || typeof dl !== 'string') {
    console.error(`[yt] ${path} sin link de descarga`)
    return null
  }
  return {
    dl,
    title: d.title || d.name || 'sin título',
    quality: d.quality || d.calidad || params.quality,
    seconds: toSeconds(d.seconds ?? d.duration ?? d.timestamp ?? d.lengthSeconds)
  }
}

export async function search(query, limit = 10) {
  let timer
  try {
    const res = await Promise.race([
      yts(query),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), SEARCH_TIMEOUT) })
    ])
    return (res.videos || []).slice(0, limit).map((v) => ({
      title: v.title,
      url: v.url,
      seconds: v.seconds || 0,
      author: v.author?.name || ''
    }))
  } catch (e) {
    console.error(`[yt] búsqueda falló: ${e.message}`)
    return []
  } finally {
    clearTimeout(timer)
  }
}

async function toUrl(input) {
  if (isYT(input)) return input
  const [first] = await search(input, 1)
  if (!first) console.error(`[yt] la búsqueda no devolvió videos para: ${input}`)
  return first?.url || null
}

const fallbackOf = (q) => {
  if (QUALITIES.indexOf(q) > QUALITIES.indexOf('480p')) return '480p'
  if (q === '480p') return '360p'
  return null
}

export async function resolveVideo(input, quality) {
  const url = await toUrl(input)
  if (!url) return null
  const order = [quality]
  const fb = fallbackOf(quality)
  if (fb) order.push(fb)
  for (const q of order) {
    const data = await media(route('ytmp4'), { url, quality: q })
    if (data) return { ...data, asked: quality, tried: q }
  }
  return null
}

export async function resolveAudio(input) {
  const url = await toUrl(input)
  if (!url) return null
  return media(route('ytmp3'), { url })
}

export async function download(url, dest) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), DL_TIMEOUT)
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: ctrl.signal })
    if (!res.ok) throw new Error(`Descarga ${res.status}`)
    const len = Number(res.headers.get('content-length') || 0)
    if (len && len > MAX_BYTES) throw tooBig()

    let bytes = 0
    const limit = async function* (src) {
      for await (const chunk of src) {
        bytes += chunk.length
        if (bytes > MAX_BYTES) throw tooBig()
        yield chunk
      }
    }
    const body = typeof res.body.pipe === 'function' ? res.body : Readable.fromWeb(res.body)
    await pipeline(body, limit, fs.createWriteStream(dest))
  } finally {
    clearTimeout(t)
  }
}

let ffmpegOk
const hasFfmpeg = () => ffmpegOk ??= new Promise((res) => {
  try {
    const c = spawn('ffmpeg', ['-version'], { stdio: 'ignore' })
    c.on('error', () => res(false))
    c.on('close', (code) => res(code === 0))
  } catch {
    res(false)
  }
})

function probe(file) {
  return new Promise((resolve) => {
    let out = ''
    let child
    try {
      child = spawn('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,pix_fmt', '-of', 'json', file], { timeout: 15000, killSignal: 'SIGKILL' })
    } catch {
      return resolve(null)
    }
    child.stdout.on('data', (d) => { out += d })
    child.on('error', () => resolve(null))
    child.on('close', (code) => {
      if (code !== 0) return resolve(null)
      try {
        const streams = JSON.parse(out).streams || []
        const v = streams.find((s) => s.codec_type === 'video')
        const a = streams.find((s) => s.codec_type === 'audio')
        resolve({ v: v?.codec_name, pix: v?.pix_fmt, a: a?.codec_name })
      } catch {
        resolve(null)
      }
    })
  })
}

function runFfmpeg(args, output, timeout) {
  return new Promise((resolve) => {
    let err = ''
    let child
    try {
      child = spawn('ffmpeg', ['-y', '-v', 'error', ...args, output], { stdio: ['ignore', 'ignore', 'pipe'], timeout, killSignal: 'SIGKILL' })
    } catch {
      return resolve(false)
    }
    try { os.setPriority(child.pid, 19) } catch {}
    child.stderr.on('data', (d) => { if (err.length < 2000) err += d })
    child.on('error', () => resolve(false))
    child.on('close', (code) => {
      const ok = code === 0 && fs.existsSync(output) && fs.statSync(output).size > 0
      if (!ok) console.error(`[ffmpeg] falló (code ${code}): ${err.trim().slice(-300)}`)
      resolve(ok)
    })
  })
}

export async function prepareVideo(input, output) {
  if (!(await hasFfmpeg())) return false
  const info = await probe(input)
  const vOk = info?.v === 'h264' && info?.pix === 'yuv420p'
  const aOk = !!info && (!info.a || info.a === 'aac')

  const args = ['-i', input, '-map', '0:v:0', '-map', '0:a:0?']
  if (vOk) args.push('-c:v', 'copy')
  else args.push('-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p')
  if (aOk) args.push('-c:a', 'copy')
  else args.push('-c:a', 'aac', '-b:a', '128k')
  args.push('-movflags', '+faststart')

  return runFfmpeg(args, output, vOk && aOk ? 2 * 60 * 1000 : 6 * 60 * 1000)
}

export async function prepareAudio(input, output) {
  if (!(await hasFfmpeg())) return false
  const info = await probe(input)
  const args = ['-i', input, '-vn', '-map', '0:a:0']
  if (info?.a === 'mp3') args.push('-c:a', 'copy')
  else args.push('-c:a', 'libmp3lame', '-b:a', '128k')
  return runFfmpeg(args, output, 4 * 60 * 1000)
}