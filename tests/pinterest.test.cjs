const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const source = fs.readFileSync(path.join(__dirname, '../cmds/dl/pinterest.js'), 'utf8')
function load(fetch) {
  const create = value => value
  const IM = Object.assign(create, Object.fromEntries(['Header', 'Body', 'Footer', 'NativeFlowMessage', 'CarouselMessage'].map(k => [k, { create }])))
  IM.create = create
  const context = { URL, URLSearchParams, AbortController, Buffer, setTimeout, clearTimeout, console, process, global: {}, fetch,
    db: { getSettings: async () => ({}) }, proto: { Message: { InteractiveMessage: IM } },
    prepareWAMessageMedia: async () => ({ imageMessage: {} }),
    generateWAMessageFromContent: (chat, message) => ({ key: { id: 'carousel' }, message }) }
  vm.createContext(context)
  vm.runInContext(source.replace(/^import .*\n/gm, '').replace('export default {', 'global.plugin = {') + '\nglobal.helpers = { pinUrl, pinMediaUrl, pinDownloadMedia, resolvePin, downloadPin };', context)
  return context.global
}
function response(data, status = 200, location) {
  return { ok: status === 200, status, headers: { get: key => key === 'location' ? location : 'image/jpeg' },
    body: { cancel: async () => {} }, json: async () => data, arrayBuffer: async () => Buffer.from('image') }
}
function socket() {
  const calls = []
  return { calls, user: { id: '123:1@s.whatsapp.net' }, sendMessage: async (chat, data) => calls.push(data),
    reply: async (chat, text) => calls.push({ text }), sendAlbumMessage: async (chat, media) => calls.push({ album: media }),
    relayMessage: async () => calls.push({ carousel: true }) }
}
const msg = { chat: 'test@g.us', sender: 'test', key: {} }
test('rejects foreign, credentialed, insecure, non-pin and malicious redirects', async () => {
  const { helpers } = load(async () => response({}, 302, 'https://127.0.0.1/private'))
  for (const url of ['https://pinterest.com.evil.test/pin/1/', 'http://pinterest.com/pin/1/', 'https://x@pinterest.com/pin/1/', 'https://pinterest.com:444/pin/1/']) assert.throws(() => helpers.pinUrl(url))
  await assert.rejects(helpers.resolvePin('https://pin.it/test'))
  const normal = load(async () => response({})).helpers
  await assert.rejects(normal.resolvePin('https://www.pinterest.com/someuser/'))
})
test('resolves short relative redirects and returns full canonical numeric pin', async () => {
  let count = 0
  const { helpers } = load(async () => ++count === 1 ? response({}, 302, 'https://www.pinterest.com/pin/test--123456789012345678/') : response({}))
  assert.equal(await helpers.resolvePin('https://pin.it/test'), 'https://www.pinterest.com/pin/123456789012345678/')
})
test('handles verified Delirius single photo response and validates media hosts', () => {
  const { helpers } = load()
  const data = { status: true, data: { download: { type: 'image', url: 'https://i.pinimg.com/originals/a7/66/56/a76656e966b1958f568d63c3f1c05aec.jpg' } } }
  assert.equal(helpers.pinDownloadMedia(data)[0].type, 'image')
  assert.equal(helpers.pinDownloadMedia(data).length, 1)
  for (const url of ['https://evil.test/a.jpg', 'https://pinimg.com.evil.test/a.jpg', 'https://v.pinimg.com/a.m3u8']) assert.equal(helpers.pinMediaUrl(url), '')
})
test('sends video once and preserves all returned album media in order', async () => {
  for (const downloads of [[{ type: 'video', url: 'https://v.pinimg.com/a.mp4' }], [{ type: 'image', url: 'https://i.pinimg.com/a.jpg' }, { type: 'image', url: 'https://i.pinimg.com/b.jpg' }]]) {
    const { plugin } = load(async url => String(url).includes('/download/') ? response({ status: true, data: { title: 'Pin', download: downloads.length === 1 ? downloads[0] : downloads } }) : response({}))
    const sock = socket()
    await plugin.run({ sock, msg, args: ['https://www.pinterest.com/pin/123456789012345678/'], usedPrefix: '#', command: 'pin' })
    const sent = sock.calls.filter(x => !x.react)
    assert.equal(sent.length, 1)
    if (downloads.length === 1) assert.ok(sent[0].video)
    else { assert.equal(sent[0].album.length, 2); assert.ok(sent[0].album[0].caption); assert.equal(sent[0].album[1].data.url, downloads[1].url) }
  }
})
test('search uses carousel and never sends loose images after ambiguous relay failure', async () => {
  const { plugin } = load(async url => String(url).includes('/search/pinterestv2') ? response({ status: true, data: [{ image: 'https://i.pinimg.com/a.jpg', title: 'Cat' }] }) : response({}))
  const sock = socket()
  sock.relayMessage = async () => { sock.calls.push({ relay: true }); throw new Error('timeout') }
  await plugin.run({ sock, msg, args: ['cat'], usedPrefix: '#', command: 'pin' })
  assert.equal(sock.calls.filter(x => x.relay).length, 1)
  assert.equal(sock.calls.filter(x => x.image).length, 0)
  assert.match(sock.calls.find(x => x.text)?.text, /duplicados/)
})
test('actual loader registers all five aliases without permission changes', () => {
  const loader = fs.readFileSync(path.join(__dirname, '../lib/system/cmdsloader.js'), 'utf8')
  const code = loader.slice(loader.indexOf('function getModuleKey'), loader.indexOf('async function importModule'))
  const global = { comandos: new Map(), plugins: {}, cmdsExecute: [] }
  const context = { global, path, commandsFolders: ['/bot/cmds'], module: {} }
  vm.createContext(context)
  vm.runInContext(code + '\nmodule.register = registerModule', context)
  const { plugin } = load()
  context.module.register('/bot/cmds/dl/pinterest.js', { default: plugin })
  for (const alias of ['pin', 'pinterest', 'pint', 'pinterestimg', 'pinimg']) {
    assert.ok(global.comandos.has(alias)); assert.equal(global.comandos.get(alias).isOwner, false)
  }
})
