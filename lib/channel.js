const DEFAULT_CHANNEL = 'https://whatsapp.com/channel/0029Vagdmfv1SWt5nfdR4z3w'

export function channelContent(content, jid = '', force = false) {
  const field = typeof content.caption === 'string' ? 'caption' : 'text'
  const text = content[field]
  if (typeof text !== 'string') return content
  const channel = global.links?.channel || DEFAULT_CHANNEL
  const lines = text.split('\n')
  const filtered = lines.filter(line => !(
    line.includes(channel) && /(?:📢 Canal:|Canal de novedades:)/.test(line)
  ))
  if (!force && filtered.length === lines.length) return content
  if (jid.endsWith('@newsletter')) return content
  if (content.audio || content.sticker || content.nativeFlow || content.buttons) return content
  return {
    ...content,
    [field]: filtered.join('\n').replace(/^\n+/, ''),
    nativeFlow: [{ text: 'Ver canal', url: channel }]
  }
}

export function sendChannelMessage(sock, jid, content, options) {
  return sock.sendMessage(jid, channelContent(content, jid), options)
}
