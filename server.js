const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.static('.')); // Раздаем статические файлы

// Хранилище данных
const users = new Map(); // ID пользователя -> данные
const activeChats = new Map(); // ID чата -> данные
const messages = new Map(); // ID чата -> массив сообщений
const userSockets = new Map(); // ID пользователя -> socket.id

// Генерация ID пользователя
function generateUserId() {
  return 'user_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

// Генерация секретного ID (для поиска)
function generateSecretId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const length = Math.random() > 0.5 ? 8 : 9;
  let result = '';

  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  return result;
}

// Обработка подключений
io.on('connection', (socket) => {
  console.log('Новое подключение:', socket.id);

  // Регистрация пользователя
  socket.on('register', (callback) => {
    const userId = generateUserId();
    const secretId = generateSecretId();

    users.set(userId, {
      id: userId,
      secretId: secretId,
      socketId: socket.id,
      username: `Аноним_${secretId.substring(0, 4)}`,
      online: true,
      createdAt: Date.now()
    });

    userSockets.set(userId, socket.id);

    callback({
      success: true,
      userId: userId,
      secretId: secretId
    });

    console.log(`Пользователь зарегистрирован: ${secretId}`);
  });

  // Поиск пользователя по ID
  socket.on('search_user', (data, callback) => {
    const { secretId } = data;
    let foundUser = null;

    // Поиск пользователя по secretId
    for (const [userId, userData] of users) {
      if (userData.secretId === secretId && userData.online) {
        foundUser = {
          userId: userId,
          secretId: userData.secretId,
          username: userData.username,
          online: userData.online
        };
        break;
      }
    }

    callback({
      success: !!foundUser,
      user: foundUser
    });
  });

  // Создание чата
  socket.on('create_chat', (data, callback) => {
    const { targetUserId, currentUserId } = data;

    // Проверяем, существует ли уже чат
    const chatId = [currentUserId, targetUserId].sort().join('_');

    if (!activeChats.has(chatId)) {
      activeChats.set(chatId, {
        id: chatId,
        participants: [currentUserId, targetUserId],
        createdAt: Date.now(),
        lastActivity: Date.now()
      });

      messages.set(chatId, []);

      // Уведомляем второго пользователя о новом чате
      const targetSocketId = userSockets.get(targetUserId);
      if (targetSocketId) {
        io.to(targetSocketId).emit('new_chat', {
          chatId: chatId,
          withUser: users.get(currentUserId)
        });
      }
    }

    callback({
      success: true,
      chatId: chatId
    });
  });

  // Отправка сообщения
  socket.on('send_message', (data, callback) => {
    const { chatId, message, userId } = data;

    if (!activeChats.has(chatId)) {
      callback({ success: false, error: 'Чат не найден' });
      return;
    }

    const chat = activeChats.get(chatId);
    const user = users.get(userId);

    if (!user) {
      callback({ success: false, error: 'Пользователь не найден' });
      return;
    }

    // Создаем сообщение
    const newMessage = {
      id: uuidv4(),
      text: message,
      senderId: userId,
      senderSecretId: user.secretId,
      timestamp: Date.now(),
      expiresAt: Date.now() + 60000, // 60 секунд
      timeString: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    // Сохраняем сообщение
    const chatMessages = messages.get(chatId) || [];
    chatMessages.push(newMessage);
    messages.set(chatId, chatMessages);

    // Обновляем активность чата
    chat.lastActivity = Date.now();
    activeChats.set(chatId, chat);

    // Отправляем сообщение всем участникам чата
    chat.participants.forEach(participantId => {
      const participantSocketId = userSockets.get(participantId);
      if (participantSocketId) {
        io.to(participantSocketId).emit('new_message', {
          chatId: chatId,
          message: newMessage
        });
      }
    });

    callback({ success: true, messageId: newMessage.id });

    // Автоматическое удаление через 60 секунд
    setTimeout(() => {
      const currentMessages = messages.get(chatId) || [];
      const updatedMessages = currentMessages.filter(m => m.id !== newMessage.id);
      messages.set(chatId, updatedMessages);

      // Уведомляем участников об удалении
      chat.participants.forEach(participantId => {
        const participantSocketId = userSockets.get(participantId);
        if (participantSocketId) {
          io.to(participantSocketId).emit('message_deleted', {
            chatId: chatId,
            messageId: newMessage.id
          });
        }
      });
    }, 60000);
  });

  // Получение истории сообщений
  socket.on('get_chat_history', (data, callback) => {
    const { chatId } = data;
    const chatMessages = messages.get(chatId) || [];

    // Фильтруем неистекшие сообщения
    const validMessages = chatMessages.filter(msg => msg.expiresAt > Date.now());

    callback({
      success: true,
      messages: validMessages
    });
  });

  // Получение списка чатов пользователя
  socket.on('get_user_chats', (data, callback) => {
    const { userId } = data;
    const userChats = [];

    for (const [chatId, chatData] of activeChats) {
      if (chatData.participants.includes(userId)) {
        // Находим собеседника
        const otherParticipantId = chatData.participants.find(id => id !== userId);
        const otherUser = users.get(otherParticipantId);

        // Получаем последнее сообщение
        const chatMessages = messages.get(chatId) || [];
        const lastMessage = chatMessages.length > 0 ? chatMessages[chatMessages.length - 1] : null;

        userChats.push({
          chatId: chatId,
          otherUser: otherUser ? {
            secretId: otherUser.secretId,
            username: otherUser.username,
            online: otherUser.online
          } : null,
          lastMessage: lastMessage ? {
            text: lastMessage.text,
            time: lastMessage.timeString
          } : null,
          lastActivity: chatData.lastActivity,
          unreadCount: 0
        });
      }
    }

    // Сортируем по последней активности
    userChats.sort((a, b) => b.lastActivity - a.lastActivity);

    callback({
      success: true,
      chats: userChats
    });
  });

  // Пользователь печатает
  socket.on('typing', (data) => {
    const { chatId, userId, isTyping } = data;
    const chat = activeChats.get(chatId);

    if (chat) {
      const user = users.get(userId);
      chat.participants.forEach(participantId => {
        if (participantId !== userId) {
          const participantSocketId = userSockets.get(participantId);
          if (participantSocketId) {
            io.to(participantSocketId).emit('user_typing', {
              chatId: chatId,
              userId: userId,
              username: user.username,
              isTyping: isTyping
            });
          }
        }
      });
    }
  });

  // Отключение пользователя
  socket.on('disconnect', () => {
    // Находим пользователя по socket.id
    let disconnectedUserId = null;

    for (const [userId, socketId] of userSockets) {
      if (socketId === socket.id) {
        disconnectedUserId = userId;
        break;
      }
    }

    if (disconnectedUserId) {
      // Обновляем статус пользователя
      const user = users.get(disconnectedUserId);
      if (user) {
        user.online = false;
        users.set(disconnectedUserId, user);
        userSockets.delete(disconnectedUserId);
      }

      console.log(`Пользователь отключился: ${disconnectedUserId}`);

      // Уведомляем всех в его чатах
      for (const [chatId, chatData] of activeChats) {
        if (chatData.participants.includes(disconnectedUserId)) {
          chatData.participants.forEach(participantId => {
            if (participantId !== disconnectedUserId) {
              const participantSocketId = userSockets.get(participantId);
              if (participantSocketId) {
                io.to(participantSocketId).emit('user_status_changed', {
                  userId: disconnectedUserId,
                  online: false
                });
              }
            }
          });
        }
      }
    }
  });
});

// Маршрут для проверки работы сервера
app.get('/status', (req, res) => {
  res.json({
    status: 'online',
    users: users.size,
    chats: activeChats.size,
    uptime: process.uptime()
  });
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
  console.log(`WebSocket сервер готов к подключениям`);
});
