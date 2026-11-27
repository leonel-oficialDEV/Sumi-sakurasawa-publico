import { OWNER_SESSION_ID, deleteSession, flushAllCreds } from '#sessions';

const MAI_NUM = '573015200599';

global._delOwnerPending = global._delOwnerPending || new Map();

const cleanNum = (jid) => String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');

export default {
  command: ['delsessionowner', 'delowner', 'killowner', 'logoutowner'],
  category: 'owner',
  description: 'Desde cualquier sub, elimina solo la sesion owner',
  isOwner: true,

  run: async ({ msg, sock, isOwner, args }) => {
    const senderNum = cleanNum(msg.sender || msg.key?.participant || msg.key?.remoteJid);
    const senderAlt = cleanNum(msg.key?.participantAlt);
    const sosMai = senderNum === MAI_NUM || senderAlt === MAI_NUM;

    if (!isOwner || !sosMai) {
      return sock.sendMessage(msg.chat, { text: `《✧》 *Solo el owner Mai puede eliminar la sesion owner.*` }, { quoted: msg });
    }

    const ownerSock = global.sock;
    const ownerNum = cleanNum(ownerSock?.user?.id || '');
    const ejecutadoDesde = cleanNum(sock?.user?.id || '');
    const esSub = ownerSock && sock !== ownerSock;
    const confirm = String(args?.[0] || '').toLowerCase().trim();
    const esConfirmacion = ['si', 'sí', 'confirmar', 'confirm', 'yes', 'eliminar'].includes(confirm);
    const pending = global._delOwnerPending.get(msg.chat);

    if (!esConfirmacion) {
      global._delOwnerPending.set(msg.chat, { num: senderNum, at: Date.now() });
      setTimeout(() => {
        const p = global._delOwnerPending.get(msg.chat);
        if (p && Date.now() - p.at >= 60000) global._delOwnerPending.delete(msg.chat);
      }, 60000);

      return sock.sendMessage(msg.chat, {
        text: `《✧》 *¿Estas seguro, Mai?*\n\n> *Vas a eliminar:* Sesion owner (${ownerNum || 'desconocido'})\n> *Session ID:* ${OWNER_SESSION_ID}\n> *Desde:* ${esSub ? `Sub ${ejecutadoDesde}` : `Owner ${ownerNum}`}\n\n*Para confirmar escribi:*\n\`delsessionowner si\`\n\nTenes 60 segundos. Si no confirmas, se cancela solo.`
      }, { quoted: msg });
    }

    if (!pending || pending.num !== senderNum || Date.now() - pending.at > 60000) {
      global._delOwnerPending.delete(msg.chat);
      return sock.sendMessage(msg.chat, { text: `《✧》 *Confirmacion expirada o invalida.*\n\nEscribi de nuevo \`delsessionowner\` para pedir confirmacion.` }, { quoted: msg });
    }

    global._delOwnerPending.delete(msg.chat);

    await sock.sendMessage(msg.chat, {
      text: `《✧》 *Confirmado por Mai. Eliminando SOLO la sesion owner...*\n\n> *Owner:* ${ownerNum || 'desconocido'}\n> *Session ID:* ${OWNER_SESSION_ID}\n> *Ejecutado desde:* ${esSub ? `Sub ${ejecutadoDesde}` : `Owner ${ownerNum}`}\n\nBorrando en 2 segundos.`
    }, { quoted: msg });

    await new Promise(r => setTimeout(r, 2000));

    try {
      deleteSession(OWNER_SESSION_ID);
    } catch (e) {
      console.log('[ DEL OWNER ] deleteSession error:', e.message);
    }

    try { flushAllCreds(); } catch {}

    try {
      if (ownerSock) {
        await ownerSock.logout();
      }
    } catch (e) {
      console.log('[ DEL OWNER ] logout owner error:', e.message);
    }

    return sock.sendMessage(msg.chat, {
      text: `《✧》 *Sesion owner eliminada.*\n\n> *Owner:* ${ownerNum}\n> *Eliminado por:* Mai`
    }, { quoted: msg });
  }
};