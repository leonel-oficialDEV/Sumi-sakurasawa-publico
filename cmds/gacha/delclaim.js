import db from '#db';

export default {
  command: ['delclaimmsg', 'resetclaimmsg', 'delclaim'],
  category: 'gacha',
  description: 'Restablecer el mensaje al reclamar un personaje.',
  run: async ({ msg, usedPrefix, command }) => {
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

      if (!db.data.users[userId]) db.data.users[userId] = {};
      const userGlobal = (db.getUser ? db.getUser(userId) : db.data.users[userId]) || {};

      if (!userGlobal.claimMessage) {
        return msg.reply(`ꕥ No tienes un mensaje de reclamación personalizado.\n> Puedes crear uno con *${usedPrefix}setclaim*`);
      }

      userGlobal.claimMessage = '';
      if (db.updateUser) db.updateUser(userId, 'claimMessage', '');
      if (typeof db.write === 'function') await db.write();

      return msg.reply('❀ Mensaje de reclamación restablecido.');
    } catch (e) {
      await msg.reply(`> Ocurrió un error al ejecutar el comando *${usedPrefix + command}*.\n> [Error: *${e.message}*]`);
    }
  },
};
