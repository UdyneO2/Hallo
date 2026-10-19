import {
  addContact,
  join,
  loadDmHistory,
  postDm,
  postMessage,
  postTyping,
  register,
  setNick,
  setStatus,
  unregister,
} from '@/lib/chat';

export const runtime = 'edge';

export async function GET(request: Request) {
  const upgradeHeader = request.headers.get('upgrade');
  if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
    return new Response('Expected WebSocket upgrade', { status: 426 });
  }

  // Cloudflare WebSocket Pair
  const pair = new WebSocketPair();
  const [clientSocket, serverSocket] = Object.values(pair);

  // Accept koneksi WebSocket di sisi server
  serverSocket.accept();

  // Register socket ke chat hub
  register(serverSocket);

  serverSocket.addEventListener('message', (event) => {
    let data: any;
    try {
      data = JSON.parse(event.data.toString());
    } catch {
      return;
    }

    switch (data.type) {
      case 'join':
        void join(serverSocket, data.clientId, data.name);
        break;
      case 'message':
        void postMessage(serverSocket, data.text);
        break;
      case 'typing':
        void postTyping(serverSocket);
        break;
      case 'setNick':
        void setNick(serverSocket, data.nick, data.secret);
        break;
      case 'addContact':
        void addContact(serverSocket, data.nick);
        break;
      case 'dm':
        void postDm(serverSocket, data.to, data.text);
        break;
      case 'dmHistory':
        void loadDmHistory(serverSocket, data.with);
        break;
      case 'setStatus':
        void setStatus(serverSocket, data.status, data.avatarUrl);
        break;
    }
  });

  const closeHandler = () => void unregister(serverSocket);
  serverSocket.addEventListener('close', closeHandler);
  serverSocket.addEventListener('error', closeHandler);

  return new Response(null, {
    status: 101,
    webSocket: clientSocket,
  });
}
