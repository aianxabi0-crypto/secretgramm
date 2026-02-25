const socket = io();
let currentChannel = 'general';
let nickname = localStorage.getItem('nickname') || 'Аноним';
let filesToSend = [];
let audioRecorder = null;
let audioChunks = [];

// Установить ник
function setNickname() {
    const nickInput = document.getElementById('nickname');
    if (nickInput.value.trim()) {
        nickname = nickInput.value.trim();
        localStorage.setItem('nickname', nickname);
        alert('Ник сохранён: ' + nickname);
        joinChannel(currentChannel);
    }
}

// Присоединиться к каналу
function joinChannel(channelName) {
    socket.emit('join-channel', {
        channel: channelName,
        nickname: nickname
    });
    currentChannel = channelName;

    // Подсветка активного канала
    document.querySelectorAll('#channel-list li').forEach(li => {
        li.classList.remove('active');
    });
    event.target.classList.add('active');

    // Очистка сообщений
    document.getElementById('messages').innerHTML = '';
    document.getElementById('messages').innerHTML = `<div class="info">Вы в канале: <strong>${channelName}</strong></div>`;
}

// Отправить сообщение
function sendMessage() {
    const messageInput = document.getElementById('message');
    const text = messageInput.value.trim();

    if (text) {
        socket.emit('send-message', {
            text: text,
            channel: currentChannel,
            type: 'text'
        });
        messageInput.value = '';
    }
}

// Создать канал
document.getElementById('create-channel-btn').addEventListener('click', async () => {
    const channelNameInput = document.getElementById('new-channel-name');
    const channelName = channelNameInput.value.trim();

    if (!channelName) {
        alert('Введите название канала');
        return;
    }

    try {
        const response = await fetch('/create-channel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ channelName })
        });

        const result = await response.json();
        if (result.error) {
            alert(result.error);
        } else {
            channelNameInput.value = '';
        }
    } catch (error) {
        console.error('Ошибка:', error);
        alert('Не удалось создать канал');
    }
});

// Загрузка файла
document.getElementById('file-upload').addEventListener('change', async (e) => {
    filesToSend = Array.from(e.target.files);
    if (filesToSend.length > 0) {
        showPreview(filesToSend[0]);
    }
});

// Показать превью файла
function showPreview(file) {
    const modal = document.getElementById('preview-modal');
    const previewArea = document.getElementById('preview-area');
    previewArea.innerHTML = '';

    if (file.type.startsWith('image/')) {
        const img = document.createElement('img');
        img.src = URL.createObjectURL(file);
        img.style.maxWidth = '100%';
        previewArea.appendChild(img);
    } else if (file.type.startsWith('video/')) {
        const video = document.createElement('video');
        video.src = URL.createObjectURL(file);
        video.controls = true;
        video.style.maxWidth = '100%';
        previewArea.appendChild(video);
    } else if (file.type.startsWith('audio/')) {
        const audio = document.createElement('audio');
        audio.src = URL.createObjectURL(file);
        audio.controls = true;
        previewArea.appendChild(audio);
    } else {
        previewArea.innerHTML = `<p>📄 Файл: ${file.name} (${(file.size/1024/1024).toFixed(2)} MB)</p>`;
    }

    previewArea.innerHTML += `<p>Отправляем: ${file.name}</p>`;
    modal.style.display = 'block';
}

// Отправить файл
async function sendFileMessage() {
    if (filesToSend.length === 0) return;

    const file = filesToSend[0];
    const formData = new FormData();
    formData.append('file', file);

    try {
        const response = await fetch('/upload-file', {
            method: 'POST',
            body: formData
        });

        const result = await response.json();
        if (result.success) {
            socket.emit('send-message', {
                text: `📎 ${file.name}`,
                file: result,
                channel: currentChannel,
                type: 'file'
            });
            closeModal();
            filesToSend = [];
            document.getElementById('file-upload').value = '';
        }
    } catch (error) {
        console.error('Ошибка загрузки:', error);
        alert('Не удалось загрузить файл');
    }
}

// Сделать фото
function takePhoto() {
    alert('Используйте кнопку "Файл" для загрузки фото');
}

// Запись аудио
async function recordAudio() {
    if (!audioRecorder) {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            audioRecorder = new MediaRecorder(stream);
            audioChunks = [];

            audioRecorder.ondataavailable = (e) => {
                audioChunks.push(e.data);
            };

            audioRecorder.onstop = async () => {
                const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
                const audioFile = new File([audioBlob], 'audio_message.webm', { type: 'audio/webm' });
                filesToSend = [audioFile];
                showPreview(audioFile);
            };

            audioRecorder.start();
            alert('Запись началась... Нажмите ОК чтобы остановить');
        } catch (err) {
            console.error('Ошибка записи:', err);
            alert('Не удалось получить доступ к микрофону');
        }
    } else {
        audioRecorder.stop();
        audioRecorder.stream.getTracks().forEach(track => track.stop());
        audioRecorder = null;
    }
}

// Закрыть модалку
function closeModal() {
    document.getElementById('preview-modal').style.display = 'none';
}

// ========== SOCKET.IO EVENTS ==========

// Получение списка каналов
socket.on('channels-list', (channels) => {
    const channelList = document.getElementById('channel-list');
    channelList.innerHTML = '';

    channels.forEach(channel => {
        const li = document.createElement('li');
        li.innerHTML = `<i class="fas fa-hashtag"></i> ${channel}`;
        li.onclick = () => joinChannel(channel);
        if (channel === 'general') li.classList.add('active');
        channelList.appendChild(li);
    });
});

// Новый канал создан
socket.on('channel-created', (channelName) => {
    const channelList = document.getElementById('channel-list');
    const li = document.createElement('li');
    li.innerHTML = `<i class="fas fa-hashtag"></i> ${channelName}`;
    li.onclick = () => joinChannel(channelName);
    channelList.appendChild(li);
});

// История сообщений
socket.on('message-history', (messages) => {
    const messagesDiv = document.getElementById('messages');
    messages.forEach(msg => {
        messagesDiv.appendChild(createMessageElement(msg));
    });
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
});

// Новое сообщение
socket.on('new-message', (message) => {
    if (message.channel === currentChannel) {
        const messagesDiv = document.getElementById('messages');
        messagesDiv.appendChild(createMessageElement(message));
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }
});

// Создать элемент сообщения
function createMessageElement(message) {
    const msgDiv = document.createElement('div');
    msgDiv.className = 'message';

    let content = '';
    if (message.type === 'file' && message.file) {
        const file = message.file;
        if (file.type.startsWith('image/')) {
            content = `<div class="file-message"><img src="${file.url}" style="max-width:300px;border-radius:10px;"></div>`;
        } else if (file.type.startsWith('video/')) {
            content = `<div class="file-message"><video src="${file.url}" controls style="max-width:300px;"></video></div>`;
        } else if (file.type.startsWith('audio/')) {
            content = `<div class="file-message"><audio src="${file.url}" controls></audio></div>`;
        } else {
            content = `<div class="file-message"><a href="${file.url}" download><i class="fas fa-file"></i> ${file.name}</a> (${(file.size/1024).toFixed(1)} KB)</div>`;
        }
    } else {
        content = `<div class="text">${message.text}</div>`;
    }

    msgDiv.innerHTML = `
        <strong>${message.nickname}</strong>
        <span class="time">${message.time}</span>
        ${content}
    `;

    return msgDiv;
}

// Пользователь присоединился
socket.on('user-joined', (userNickname) => {
    const messagesDiv = document.getElementById('messages');
    const infoDiv = document.createElement('div');
    infoDiv.className = 'info';
    infoDiv.innerHTML = `<i class="fas fa-user-plus"></i> ${userNickname} присоединился`;
    messagesDiv.appendChild(infoDiv);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
});

// Загрузка ника при старте
window.onload = () => {
    document.getElementById('nickname').value = nickname;
    joinChannel('general');
};

// Закрытие модалки по клику вне
window.onclick = function(event) {
    const modal = document.getElementById('preview-modal');
    if (event.target == modal) {
        closeModal();
    }
};
