import db from '#db';

const MAX_CLAIM_LENGTH = 500;

export default {
  command: ['setclaim', 'setclaimmsg'],
  category: 'gacha',
  description: 'Modificar el mensaje al reclamar un personaje.',
  run: async ({ msg, args, usedPrefix, command }) => {
    try {
      if (typeof db.read === 'function') await db.read();
      const chatId = msg.chat;
      const userId = msg.sender;

      if (!db.data) db.data = {};
      if (!db.data.chats) db.data.chats = {};
      if (!db.data.chats[chatId]) db.data.chats[chatId] = {};
      if (!db.data.users) db.data.users = {};

      const chat = db.getChat ? db.getChat(chatId) : db.data.chats[chatId];
      if (chat?.adminonly || !chat?.gacha) {
        return msg.reply(`ꕥ Los comandos de *Gacha* están desactivados en este grupo.\n\nUn *administrador* puede activarlos con el comando:\n» *${usedPrefix}gacha on*`);
      }

      if (!args.length) {
        return msg.reply(`❀ Debes especificar un mensaje para reclamar un personaje.\n> Ejemplos:\n> ${usedPrefix + command} €user ha reclamado el personaje €character!\n> ${usedPrefix + command} €character ha sido reclamado por €user`);
      }

      const customMsg = args.join(' ')
        .replace(/€user/gi, '€user')
        .replace(/€character/gi, '€character')
        .trim();

      if (!customMsg.includes('€user') || !customMsg.includes('€character')) {
        return msg.reply(`ꕥ Tu mensaje debe incluir *€user* y *€character* para que funcione correctamente.`);
      }

      if (customMsg.length > MAX_CLAIM_LENGTH) {
        return msg.reply(`ꕥ Tu mensaje es muy largo. El máximo es de *${MAX_CLAIM_LENGTH}* caracteres (tiene *${customMsg.length}*).`);
      }

      if (!db.data.users[userId]) db.data.users[userId] = {};
      const userGlobal = (db.getUser ? db.getUser(userId) : db.data.users[userId]) || {};

      userGlobal.claimMessage = customMsg;
      if (db.updateUser) db.updateUser(userId, 'claimMessage', customMsg);
      if (typeof db.write === 'function') await db.write();

      const userName = userGlobal.name?.trim() || userId.split('@')[0];
      const preview = customMsg.replace(/€user/g, userName).replace(/€character/g, 'Anby Demara');

      return msg.reply(`❀ Mensaje de reclamación modificado.\n\n> Vista previa » ${preview}`);
    } catch (e) {
      await msg.reply(`> Ocurrió un error al ejecutar el comando *${usedPrefix + command}*.\n> [Error: *${e.message}*]`);
    }
  },
};
