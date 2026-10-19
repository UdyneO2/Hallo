import { experimental_upgradeWebSocket, type WebSocketData } from '@vercel/functions';
import {
  addContact,
  join,
  loadDmHistory,
  postDm,
  postMessage,
  postTyping,
  register,
  setNick,
  setStatus, // [BARU] Import fungsi setStatus
  unregister,
} from '@/lib/chat';

// Wire-format the client sends over the socket.
type ClientEvent =
  | { type: 'join'; clientId: string; name: string } // name di sini akan diisi oleh nick dari frontend
  | { type: 'message'; text: string }
  | { type: 'typing' }
  | { type: 'setNick'; nick: string; secret: string }
  | { type: 'addContact'; nick: string }
  | { type: 'dm'; to: string; text: string }
  | { type: 'dmHistory'; with: string }
  | { type: 'setStatus'; status: string }; // [BARU] Tambahkan tipe setStatus

export function GET() {
  return experimental_upgradeWebSocket((ws) => {
    register(ws);

    ws.on('message', (data: WebSocketData) => {
      let event: ClientEvent;
      try {
        event = JSON.parse(data.toString());
      } catch {
        return; 
      }

      switch (event.type) {
        case 'join':
          void join(ws, event.clientId, event.name);
          break;
        case 'message':
          void postMessage(ws, event.text);
          break;
        case 'typing':
          void postTyping(ws);
          break;
        case 'setNick':
          void setNick(ws, event.nick, event.secret);
          break;
        case 'addContact':
          void addContact(ws, event.nick);
          break;
        case 'dm':
          void postDm(ws, event.to, event.text);
          break;
        case 'dmHistory':
          void loadDmHistory(ws, event.with);
          break;
        case 'setStatus': // [BARU] Handler untuk menangani update status profil
          void setStatus(ws, event.status);
          break;
      }
    });

    const close = () => void unregister(ws);
    ws.on('close', close);
    ws.on('error', close);
  });
}

      }
    });

    const close = () => void unregister(ws);
    ws.on('close', close);
    // An error is always followed by a close, but clean up defensively.
    ws.on('error', close);
  });
}
