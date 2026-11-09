import syntaxerror from 'syntax-error'
import { format } from 'util'
import { fileURLToPath } from 'url'
import { dirname } from 'path'
import { createRequire } from 'module'

const __dirname = dirname(fileURLToPath(import.meta.url))
const require = createRequire(__dirname)

class CustomArray extends Array {
  constructor(...args) {
    if (typeof args[0] === 'number') {
      return super(Math.min(args[0], 10000))
    }

    return super(...args)
  }
}

export default {
  command: ['<'],
  category: 'owner',

  owner: true,

  run: async ({ sock, msg, args, text, usedPrefix, command }) => {
    let resultado
    let errorSintaxis = ''
    const codigo = (String(text || args?.join(' ') || '').startsWith('=')
      ? 'return '
      : '') + String(text || args?.join(' ') || '')

    const old = msg.exp * 1

    try {
      let limite = 15
      const modulo = { exports: {} }

      const ejecutar = new (async () => {}).constructor(
        'print',
        'm',
        'handler',
        'require',
        'conn',
        'Array',
        'process',
        'args',
        'groupMetadata',
        'module',
        'exports',
        'argument',
        codigo
      )

      resultado = await ejecutar.call(
        sock,
        (...valores) => {
          if (--limite < 1) return
          console.log(...valores)

          return sock.sendMessage(
            msg.key.remoteJid,
            { text: format(...valores) },
            { quoted: msg }
          )
        },
        msg,
        this,
        require,
        sock,
        CustomArray,
        process,
        args || [],
        msg.groupMetadata,
        modulo,
        modulo.exports,
        [sock, { msg, args, text, usedPrefix, command }]
      )
    } catch (error) {
      const err = syntaxerror(codigo, 'Execution Function', {
        allowReturnOutsideFunction: true,
        allowAwaitOutsideFunction: true,
        sourceType: 'module'
      })

      if (err) errorSintaxis = '```' + err + '```\n\n'
      resultado = error
    } finally {
      await sock.sendMessage(
        msg.key.remoteJid,
        { text: errorSintaxis + format(resultado) },
        { quoted: msg }
      ).catch(() => {})

      msg.exp = old
    }
  }
}