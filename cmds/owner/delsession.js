import fs from 'fs'
import path from 'path'
import { sessionExists, deleteSession, stopSubBot } from '#subs'

export default {
  command: ['delsession'],
  category: 'owner',
  isOwner: true,
  description: 'Elimina el socket del usuario mencionado',

  run: async ({ msg }) => {
    const numero = (msg.text || '').split(/\s+/)[1]?.replace(/\D/g, '') || ''
    if (!numero) return msg.reply('✎ Uso correcto:\n\n*#delsession 5730XXXXXXXX*')

    let borrado = false

    // 1. Sub-bot en SQL: primero detener el socket, luego borrar
    if (sessionExists(numero)) {
      stopSubBot(numero)
      deleteSession(numero)
      global.SUBS_STOPPED?.delete(numero)
      borrado = true
    }

    // 2. Carpetas antiguas (respaldo Subs y Prems)
    for (const dir of ['Subs', 'Prems']) {
      const ruta = path.join(process.cwd(), 'Sessions', dir, numero)
      if (fs.existsSync(ruta)) {
        fs.rmSync(ruta, { recursive: true, force: true })
        borrado = true
      }
    }

    return msg.reply(borrado
      ? `✅ Sesión eliminada.\n📱 Número: ${numero}`
      : `❌ No se encontró ninguna sesión con el número:\n${numero}`)
  }
}