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
app.use(express.json());
app.use(express.static('.'));

// Хранилище данных
const users = new Map();
const activeChats = new Map();
const messages = new Map();
const userSockets = new Map();

// Генерация ID пользователя
function generateUserId() {
  return 'user_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

// Генерация секретного ID
function generateSecretId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const length = Math.random() > 0.5 ? 8 : 9;
  let result = '';

  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  return result;
}

// WebSocket события
io.on('connection', (socket) => {
  console.log('Новое подключение:', socket.id);

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
  });

  socket.on('search_user', (data, callback) => {
    const { secretId } = data;
    let foundUser = null;

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

  socket.on('create_chat', (data, callback) => {
    const { targetUserId, currentUserId } = data;
    const chatId = [currentUserId, targetUserId].sort().join('_');

    if (!activeChats.has(chatId)) {
      activeChats.set(chatId, {
        id: chatId,
        participants: [currentUserId, targetUserId],
        createdAt: Date.now(),
        lastActivity: Date.now()
      });

      messages.set(chatId, []);

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

    const newMessage = {
      id: uuidv4(),
      text: message,
      senderId: userId,
      senderSecretId: user.secretId,
      timestamp: Date.now(),
      expiresAt: Date.now() + 60000,
      timeString: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    const chatMessages = messages.get(chatId) || [];
    chatMessages.push(newMessage);
    messages.set(chatId, chatMessages);

    chat.lastActivity = Date.now();
    activeChats.set(chatId, chat);

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

    setTimeout(() => {
      const currentMessages = messages.get(chatId) || [];
      const updatedMessages = currentMessages.filter(m => m.id !== newMessage.id);
      messages.set(chatId, updatedMessages);

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

  socket.on('get_chat_history', (data, callback) => {
    const { chatId } = data;
    const chatMessages = messages.get(chatId) || [];
    const validMessages = chatMessages.filter(msg => msg.expiresAt > Date.now());

    callback({
      success: true,
      messages: validMessages
    });
  });

  socket.on('get_user_chats', (data, callback) => {
    const { userId } = data;
    const userChats = [];

    for (const [chatId, chatData] of activeChats) {
      if (chatData.participants.includes(userId)) {
        const otherParticipantId = chatData.participants.find(id => id !== userId);
        const otherUser = users.get(otherParticipantId);

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

    userChats.sort((a, b) => b.lastActivity - a.lastActivity);

    callback({
      success: true,
      chats: userChats
    });
  });

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

  socket.on('disconnect', () => {
    let disconnectedUserId = null;

    for (const [userId, socketId] of userSockets) {
      if (socketId === socket.id) {
        disconnectedUserId = userId;
        break;
      }
    }

    if (disconnectedUserId) {
      const user = users.get(disconnectedUserId);
      if (user) {
        user.online = false;
        users.set(disconnectedUserId, user);
        userSockets.delete(disconnectedUserId);
      }

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

// Статус сервера
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
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
  console.log(`📡 WebSocket сервер готов к подключениям`);
  // ==================== РАСШИРЕННЫЕ ФУНКЦИИ ====================

  const fileStorage = new Map(); // fileId -> file data
  const anonymousChats = new Map(); // chatId -> anonymous chat data

  // Генерация ID из 12 символов (буквы + цифры)
  function generateStrongId() {
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
      let result = '';
      for (let i = 0; i < 12; i++) {
          result += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      return result;
  }

  // Создание анонимного чата с именем
  socket.on('create_anonymous_chat', (data, callback) => {
      try {
          const { chatName, creatorId, isPublic } = data;

          if (!creatorId || !users.has(creatorId)) {
              callback({ success: false, error: 'Пользователь не найден' });
              return;
          }

          const chatId = generateStrongId();
          const user = users.get(creatorId);

          const anonymousChat = {
              id: chatId,
              name: chatName || `Анонимный чат ${chatId.substring(0, 6)}`,
              creatorId: creatorId,
              creatorSecretId: user.secretId,
              isPublic: isPublic || false,
              createdAt: Date.now(),
              expiresAt: Date.now() + (7 * 24 * 60 * 60 * 1000), // 7 дней
              userCount: 1,
              onlineCount: 1,
              password: data.password || null,
              customId: data.customId || null
          };

          anonymousChats.set(chatId, anonymousChat);

          // Создаем отдельный чат для участников
          const participants = new Set([creatorId]);
          const chatMessages = [];

          // Сохраняем в общую систему
          const systemChatId = 'anon_' + chatId;
          activeChats.set(systemChatId, {
              id: systemChatId,
              participants: [creatorId, 'system_' + chatId],
              createdAt: Date.now(),
              lastActivity: Date.now(),
              isAnonymous: true,
              anonymousChatId: chatId
          });

          messages.set(systemChatId, chatMessages);

          // Добавляем пользователю
          if (!user.anonymousChats) user.anonymousChats = new Set();
          user.anonymousChats.add(chatId);
          users.set(creatorId, user);

          console.log(`Создан анонимный чат: ${chatId}`);

          callback({
              success: true,
              chatId: chatId,
              chat: anonymousChat,
              inviteLink: `${chatId}`
          });

      } catch (error) {
          console.error('Ошибка создания анонимного чата:', error);
          callback({
              success: false,
              error: 'Ошибка создания чата'
          });
      }
  });

  // Поиск анонимных чатов
  socket.on('search_anonymous_chats', (data, callback) => {
      try {
          const { query } = data;
          const foundChats = [];

          for (const [chatId, chat] of anonymousChats) {
              if (chat.isPublic && chat.isActive !== false) {
                  // Поиск по имени или ID
                  if (chat.name.toLowerCase().includes(query.toLowerCase()) || 
                      chatId.toLowerCase().includes(query.toLowerCase()) ||
                      (chat.customId && chat.customId.toLowerCase().includes(query.toLowerCase()))) {

                      const usersSet = anonymousChatParticipants.get(chatId) || new Set();
                      foundChats.push({
                          ...chat,
                          userCount: usersSet.size,
                          isMember: usersSet.has(data.userId)
                      });
                  }
              }
          }

          callback({
              success: true,
              chats: foundChats.slice(0, 20) // Ограничиваем результат
          });

      } catch (error) {
          console.error('Ошибка поиска чатов:', error);
          callback({
              success: false,
              error: 'Ошибка поиска'
          });
      }
  });

  // Присоединение к анонимному чату
  socket.on('join_anonymous_chat', (data, callback) => {
      try {
          const { chatId, userId, password } = data;

          const chat = anonymousChats.get(chatId);
          if (!chat || (chat.expiresAt && Date.now() > chat.expiresAt)) {
              callback({ success: false, error: 'Чат не найден или истек' });
              return;
          }

          // Проверка пароля
          if (chat.password && chat.password !== password) {
              callback({ success: false, error: 'Неверный пароль' });
              return;
          }

          // Добавляем пользователя
          let participants = anonymousChatParticipants.get(chatId);
          if (!participants) {
              participants = new Set();
              anonymousChatParticipants.set(chatId, participants);
          }

          if (!participants.has(userId)) {
              participants.add(userId);
              chat.userCount = participants.size;

              const user = users.get(userId);
              if (user) {
                  if (!user.anonymousChats) user.anonymousChats = new Set();
                  user.anonymousChats.add(chatId);
                  users.set(userId, user);
              }

              // Уведомляем других участников
              participants.forEach(participantId => {
                  if (participantId !== userId) {
                      const participantSocketId = userSockets.get(participantId);
                      if (participantSocketId) {
                          io.to(participantSocketId).emit('user_joined_anonymous_chat', {
                              chatId: chatId,
                              userId: userId
                          });
                      }
                  }
              });
          }

          // Получаем сообщения
          const systemChatId = 'anon_' + chatId;
          const chatMessages = messages.get(systemChatId) || [];

          callback({
              success: true,
              chat: chat,
              messages: chatMessages.slice(-100),
              userCount: participants.size
          });

      } catch (error) {
          console.error('Ошибка присоединения к чату:', error);
          callback({
              success: false,
              error: 'Ошибка присоединения'
          });
      }
  });

  // Отправка файла
  socket.on('upload_file', (data, callback) => {
      try {
          const { fileName, fileType, fileSize, fileData, chatId, userId, isChannel, channelId } = data;

          // Проверка размера (макс 10MB)
          if (fileSize > 10 * 1024 * 1024) {
              callback({ success: false, error: 'Файл слишком большой (макс 10MB)' });
              return;
          }

          // Проверка типа файла
          const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'video/mp4', 'audio/mpeg', 
                               'application/pdf', 'text/plain', 'application/zip'];

          if (!allowedTypes.some(type => fileType.startsWith(type.split('/')[0] + '/'))) {
              callback({ success: false, error: 'Тип файла не поддерживается' });
              return;
          }

          const fileId = 'file_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

          const fileInfo = {
              id: fileId,
              name: fileName,
              type: fileType,
              size: fileSize,
              data: fileData, // В реальности нужно сохранять в файловую систему
              uploaderId: userId,
              uploaderSecretId: users.get(userId)?.secretId || 'unknown',
              uploadedAt: Date.now(),
              expiresAt: Date.now() + (24 * 60 * 60 * 1000) // 24 часа
          };

          fileStorage.set(fileId, fileInfo);

          // Отправляем сообщение с файлом
          let targetUsers;
          let chatType = 'chat';

          if (isChannel && channelId) {
              targetUsers = channelUsers.get(channelId);
              chatType = 'channel';
          } else if (chatId) {
              const chat = activeChats.get(chatId);
              targetUsers = chat ? new Set(chat.participants) : new Set();
          } else {
              callback({ success: false, error: 'Не указан чат' });
              return;
          }

          if (!targetUsers || targetUsers.size === 0) {
              callback({ success: false, error: 'Чат не найден' });
              return;
          }

          // Создаем сообщение о файле
          const fileMessage = {
              id: 'file_msg_' + Date.now(),
              fileId: fileId,
              fileName: fileName,
              fileType: fileType,
              fileSize: fileSize,
              senderId: userId,
              senderSecretId: users.get(userId)?.secretId || 'unknown',
              timestamp: Date.now(),
              timeString: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
              expiresAt: Date.now() + (24 * 60 * 60 * 1000) // 24 часа
          };

          // Сохраняем в историю
          if (isChannel && channelId) {
              let channelMessages = channelMessages.get(channelId);
              if (!channelMessages) {
                  channelMessages = [];
                  channelMessages.set(channelId, channelMessages);
              }
              channelMessages.push(fileMessage);
          } else if (chatId) {
              let chatMessages = messages.get(chatId);
              if (!chatMessages) {
                  chatMessages = [];
                  messages.set(chatId, chatMessages);
              }
              chatMessages.push(fileMessage);
          }

          // Отправляем всем участникам
          targetUsers.forEach(participantId => {
              const participantSocketId = userSockets.get(participantId);
              if (participantSocketId) {
                  io.to(participantSocketId).emit('new_file_message', {
                      chatId: isChannel ? channelId : chatId,
                      isChannel: isChannel,
                      message: fileMessage,
                      fileInfo: {
                          id: fileId,
                          name: fileName,
                          type: fileType,
                          size: fileSize,
                          url: `/file/${fileId}` // В реальности будет ссылка на файл
                      }
                  });
              }
          });

          callback({
              success: true,
              fileId: fileId,
              messageId: fileMessage.id
          });

          // Автоудаление через 24 часа
          setTimeout(() => {
              fileStorage.delete(fileId);
          }, 24 * 60 * 60 * 1000);

      } catch (error) {
          console.error('Ошибка загрузки файла:', error);
          callback({
              success: false,
              error: 'Ошибка загрузки файла'
          });
      }
  });

  // Получение файла
  socket.on('get_file', (data, callback) => {
      try {
          const { fileId } = data;
          const fileInfo = fileStorage.get(fileId);

          if (!fileInfo) {
              callback({ success: false, error: 'Файл не найден' });
              return;
          }

          if (Date.now() > fileInfo.expiresAt) {
              fileStorage.delete(fileId);
              callback({ success: false, error: 'Файл удален (истек срок)' });
              return;
          }

          callback({
              success: true,
              fileInfo: fileInfo
          });

      } catch (error) {
          console.error('Ошибка получения файла:', error);
          callback({
              success: false,
              error: 'Ошибка получения файла'
          });
      }
  });

  // Создание канала с настройками
  socket.on('create_custom_channel', (data, callback) => {
      try {
          const { name, description, type, settings, creatorId } = data;

          if (!creatorId || !users.has(creatorId)) {
              callback({ success: false, error: 'Пользователь не найден' });
              return;
          }

          const channelId = generateStrongId();
          const user = users.get(creatorId);

          const channel = {
              id: channelId,
              customId: data.customId || null,
              name: name || `Канал ${channelId.substring(0, 6)}`,
              description: description || '',
              type: type || 'public',
              creatorId: creatorId,
              creatorSecretId: user.secretId,
              createdAt: Date.now(),
              expiresAt: data.lifetime ? Date.now() + parseInt(data.lifetime) : null,
              settings: {
                  allowFiles: settings?.allowFiles !== false,
                  allowVoice: settings?.allowVoice !== false,
                  maxUsers: settings?.maxUsers || 100,
                  requirePassword: settings?.requirePassword || false,
                  password: settings?.password || null,
                  autoDeleteMessages: settings?.autoDeleteMessages || 60000,
                  ...settings
              },
              isActive: true
          };

          channels.set(channelId, channel);
          channelUsers.set(channelId, new Set([creatorId]));
          channelMessages.set(channelId, []);

          if (!user.channels) user.channels = new Set();
          user.channels.add(channelId);
          users.set(creatorId, user);

          console.log(`Создан кастомный канал: ${channelId}`);

          callback({
              success: true,
              channel: channel,
              channelId: channelId,
              inviteLink: `https://${channelId}.yourdomain.com` // Пример
          });

      } catch (error) {
          console.error('Ошибка создания кастомного канала:', error);
          callback({
              success: false,
              error: 'Ошибка создания канала'
          });
      }
  });

  // Получение настроек чата/канала
  socket.on('get_chat_settings', (data, callback) => {
      try {
          const { chatId, isChannel } = data;

          if (isChannel) {
              const channel = channels.get(chatId);
              if (!channel) {
                  callback({ success: false, error: 'Канал не найден' });
                  return;
              }

              callback({
                  success: true,
                  settings: channel.settings,
                  info: {
                      name: channel.name,
                      description: channel.description,
                      type: channel.type,
                      userCount: channelUsers.get(chatId)?.size || 0,
                      createdAt: channel.createdAt
                  }
              });
          } else {
              // Для обычных чатов
              const chat = activeChats.get(chatId);
              if (!chat) {
                  callback({ success: false, error: 'Чат не найден' });
                  return;
              }

              callback({
                  success: true,
                  settings: {
                      allowFiles: true,
                      allowVoice: true,
                      autoDeleteMessages: 60000
                  },
                  info: {
                      participants: chat.participants.length,
                      createdAt: chat.createdAt
                  }
              });
          }

      } catch (error) {
          console.error('Ошибка получения настроек:', error);
          callback({
              success: false,
              error: 'Ошибка получения настроек'
          });
      }
  });

  // Обновление настроек
  socket.on('update_chat_settings', (data, callback) => {
      try {
          const { chatId, isChannel, settings, userId } = data;

          if (isChannel) {
              const channel = channels.get(chatId);
              if (!channel || channel.creatorId !== userId) {
                  callback({ success: false, error: 'Нет прав для изменения' });
                  return;
              }

              channel.settings = { ...channel.settings, ...settings };
              channels.set(chatId, channel);

              // Уведомляем участников
              const usersSet = channelUsers.get(chatId);
              if (usersSet) {
                  usersSet.forEach(participantId => {
                      const participantSocketId = userSockets.get(participantId);
                      if (participantSocketId) {
                          io.to(participantSocketId).emit('chat_settings_updated', {
                              chatId: chatId,
                              isChannel: true,
                              settings: channel.settings
                          });
                      }
                  });
              }
          }

          callback({ success: true });

      } catch (error) {
          console.error('Ошибка обновления настроек:', error);
          callback({
              success: false,
              error: 'Ошибка обновления настроек'
          });
      }
  });

  // Запись голосового сообщения
  socket.on('upload_voice_message', (data, callback) => {
      try {
          const { audioData, duration, chatId, userId, isChannel, channelId } = data;

          // Проверка размера (макс 5MB для голосовых)
          if (audioData.length > 5 * 1024 * 1024) {
              callback({ success: false, error: 'Сообщение слишком большое' });
              return;
          }

          const voiceId = 'voice_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

          const voiceMessage = {
              id: voiceId,
              audioData: audioData,
              duration: duration,
              senderId: userId,
              senderSecretId: users.get(userId)?.secretId || 'unknown',
              timestamp: Date.now(),
              timeString: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
              expiresAt: Date.now() + (24 * 60 * 60 * 1000) // 24 часа
          };

          // Сохраняем во временное хранилище
          fileStorage.set(voiceId, {
              ...voiceMessage,
              type: 'audio/ogg',
              name: 'voice_message.ogg',
              size: audioData.length
          });

          // Отправляем участникам
          let targetUsers;

          if (isChannel && channelId) {
              targetUsers = channelUsers.get(channelId);
          } else if (chatId) {
              const chat = activeChats.get(chatId);
              targetUsers = chat ? new Set(chat.participants) : new Set();
          }

          if (targetUsers) {
              targetUsers.forEach(participantId => {
                  const participantSocketId = userSockets.get(participantId);
                  if (participantSocketId) {
                      io.to(participantSocketId).emit('new_voice_message', {
                          chatId: isChannel ? channelId : chatId,
                          isChannel: isChannel,
                          message: voiceMessage
                      });
                  }
              });
          }

          callback({
              success: true,
              voiceId: voiceId
          });

      } catch (error) {
          console.error('Ошибка отправки голосового:', error);
          callback({
              success: false,
              error: 'Ошибка отправки'
          });
      }
  });

  // Инициализация хранилищ
  const anonymousChatParticipants = new Map();

  // Очистка старых файлов каждые 5 минут
  setInterval(() => {
      const now = Date.now();
      let deleted = 0;

      for (const [fileId, fileInfo] of fileStorage) {
          if (now > fileInfo.expiresAt) {
              fileStorage.delete(fileId);
              deleted++;
          }
      }

      if (deleted > 0) {
          console.log(`Очищено ${deleted} старых файлов`);
      }
  }, 5 * 60 * 1000);

  // Очистка истекших чатов
  setInterval(() => {
      const now = Date.now();
      let deleted = 0;

      for (const [chatId, chat] of anonymousChats) {
          if (chat.expiresAt && now > chat.expiresAt) {
              anonymousChats.delete(chatId);
              anonymousChatParticipants.delete(chatId);
              deleted++;
          }
      }

      if (deleted > 0) {
          console.log(`Очищено ${deleted} истекших чатов`);
      }
  }, 10 * 60 * 1000);

  console.log('✅ Расширенные функции загружены');
});
