import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { channelContent, sendChannelMessage } from '../lib/channel.js'
const url = 'https://whatsapp.com/channel/0029Vagdmfv1SWt5nfdR4z3w'
global.links = { channel: url }
const prefix = `📢 Canal: ${url}\n\n`
for (const field of ['text', 'caption']) {
  const original = { [field]: prefix + 'Title\nSource: https://example.com', image: { url: 'banner' }, contextInfo: { mentionedJid: ['person'] } }
  const result = channelContent(original, 'group@g.us')
  assert.equal(result[field], 'Title\nSource: https://example.com')
  assert.equal(result.image, original.image)
  assert.equal(result.contextInfo, original.contextInfo)
  assert.deepEqual(result.nativeFlow, [{ text: 'Ver canal', url }])
  assert.equal(original[field], prefix + 'Title\nSource: https://example.com')
  assert.equal(channelContent(original, '123@newsletter'), original)
}
assert.equal(channelContent({ caption: 'Test' }, '', true).nativeFlow[0].url, url)
for (const content of [{ react: {} }, { audio: {}, caption: prefix }, { sticker: {} }, { text: 'error' }]) assert.equal(channelContent(content), content)
assert.equal(channelContent({ text: `Title\n> *Canal de novedades:* ${url}\n> Enlace: https://example.com` }, '', true).text, 'Title\n> Enlace: https://example.com')
const calls = []
const sock = { sendMessage: async (...args) => { calls.push(args); return 'sent' }, sendAlbumMessage: async (...args) => { calls.push(args); return 'album' } }
assert.equal(await sendChannelMessage(sock, 'g@g.us', { document: {}, caption: prefix + 'file' }, { quoted: 1 }), 'sent')
assert.equal(calls[0][1].caption, 'file')
assert.equal(calls[0][2].quoted, 1)
for (const name of ['instagram', 'pinterest']) {
  const source = fs.readFileSync(new URL(`../cmds/dl/${name}.js`, import.meta.url), 'utf8')
  assert(source.includes('sock.sendAlbumMessage('))
  assert(!source.includes('sendChannelAlbum'))
}
assert(!fs.readFileSync(new URL('../lib/channel.js', import.meta.url), 'utf8').includes('sendAlbumMessage'))
for (const arch of ['baileys', 'baileys-arm', 'baileys-arm64']) {
  const source = fs.readFileSync(new URL(`../vendor/${arch}/lib/Utils/messages.js`, import.meta.url), 'utf8')
  const start = source.indexOf('const prepareNativeFlowButtons =')
  const end = source.indexOf('\nconst ', start + 1)
  const fn = vm.runInNewContext(source.slice(start, end) + '\nprepareNativeFlowButtons', { hasOptionalProperty: (obj, key) => obj?.[key] != null })
  const generated = fn({ nativeFlow: [{ text: 'Ver canal', url }] })
  assert.equal(generated.buttons[0].name, 'cta_url')
  assert.equal(JSON.parse(generated.buttons[0].buttonParamsJson).url, url)
  assert(source.includes('message.imageMessage || message.videoMessage || message.documentMessage'))
}
console.log('PASS: content/media/options preservation, channel exclusions, albums, real vendored CTA encoders on all 3 architectures')
