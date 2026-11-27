import { OWNER_SESSION_ID } from '#subs';

// Tipos de llave que se conservan (borrarlos fuerza una resincronización de estado)
const KEEP_TYPE = 'app-state-sync-key';
const MAX_DETAILS = 30;

export default {
 command: ['clear'],
 category: 'owner',
 description: 'Limpia la basura de Baileys.',
 isOwner: true,
 run: async ({ sock, msg }) => {
  if (sock !== global.sock || !sock.isOwner)
  return await sock.sendMessage(msg.chat, { text: global.mess.mainBot }, { quoted: msg })
  try {
   const subDb = global.SUBS_SQL?.subDb;
   if (!subDb) throw new Error('Base de sesiones SQL no disponible');

   let rows = [];
   let total = 0;

   subDb.exec('BEGIN');
   try {
    rows = subDb
     .prepare('SELECT session_id, COUNT(*) AS n FROM sub_keys WHERE type <> ? GROUP BY session_id ORDER BY n DESC')
     .all(KEEP_TYPE);
    total = Number(subDb.prepare('DELETE FROM sub_keys WHERE type <> ?').run(KEEP_TYPE).changes) || 0;
    subDb.exec('COMMIT');
   } catch (e) {
    try { subDb.exec('ROLLBACK'); } catch {}
    throw e;
   }

   const details = rows.map(({ session_id: id, n }) =>
    id === OWNER_SESSION_ID
     ? `[Owner] *principal*: ${n} registros`
     : `[Subbot] *${id}*: ${n} registros`
   );

   let text = `《✧》 *LIMPIEZA GENERAL COMPLETADA*\n\n`
   text += `*Total sesiones limpiadas:* ${rows.length}\n`
   text += `*Total registros eliminados:* ${total}\n`

   if (details.length > 0) {
    const shown = details.slice(0, MAX_DETAILS)
    text += `\n*Detalles por sesión:*\n${shown.join('\n')}`
    if (details.length > MAX_DETAILS) text += `\n_...y ${details.length - MAX_DETAILS} más_`
   } else {
    text += `\n_No se encontraron registros para limpiar._`
   }

   await sock.sendMessage(msg.chat, { text }, { quoted: msg })

  } catch (err) {
   console.error(err)
   await sock.sendMessage(msg.chat, { text: '✧ Error crítico durante la limpieza' }, { quoted: msg })
  }
 }
};
