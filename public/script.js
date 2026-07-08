marked.setOptions({ breaks: true, gfm: true });

const state = {
  conversations: JSON.parse(localStorage.getItem('geminiChats')) || [],
  currentId: localStorage.getItem('geminiCurrentId') || null,
  isStreaming: false,
};

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

const el = {
  messages: $('#messages'),
  welcome: $('#welcome'),
  chatContainer: $('#chatContainer'),
  input: $('#userInput'),
  sendBtn: $('#sendBtn'),
  historyList: $('#historyList'),
  sidebar: $('#sidebar'),
  menuToggle: $('#menuToggle'),
  newChatBtn: $('#newChatBtn'),
  deleteAllBtn: $('#deleteAllBtn'),
};

function getCurrentChat() {
  return state.conversations.find((c) => c.id === state.currentId);
}

function saveState() {
  localStorage.setItem('geminiChats', JSON.stringify(state.conversations));
  localStorage.setItem('geminiCurrentId', state.currentId);
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function formatTimestamp() {
  const d = new Date();
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

el.input.addEventListener('input', () => {
  el.input.style.height = 'auto';
  el.input.style.height = Math.min(el.input.scrollHeight, 200) + 'px';
  el.sendBtn.disabled = !el.input.value.trim();
});

el.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

el.menuToggle.addEventListener('click', () => {
  if (window.innerWidth <= 768) {
    el.sidebar.classList.toggle('open');
    if (el.sidebar.classList.contains('open')) {
      const overlay = document.createElement('div');
      overlay.className = 'sidebar-overlay';
      overlay.addEventListener('click', () => {
        el.sidebar.classList.remove('open');
        overlay.remove();
      });
      document.body.appendChild(overlay);
    } else {
      document.querySelector('.sidebar-overlay')?.remove();
    }
  }
});

document.querySelectorAll('.suggestion-chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    el.input.value = chip.dataset.prompt;
    el.input.dispatchEvent(new Event('input'));
    sendMessage();
  });
});

function scrollToBottom(smooth = true) {
  requestAnimationFrame(() => {
    el.chatContainer.scrollTo({
      top: el.chatContainer.scrollHeight,
      behavior: smooth ? 'smooth' : 'auto',
    });
  });
}

function renderMarkdown(text) {
  const html = marked.parse(text);
  const temp = document.createElement('div');
  temp.innerHTML = html;

  temp.querySelectorAll('pre code').forEach((block) => {
    hljs.highlightElement(block);
    const pre = block.parentElement;
    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.textContent = 'Copy';
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(block.textContent);
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = 'Copy';
          btn.classList.remove('copied');
        }, 2000);
      } catch {
        btn.textContent = 'Failed';
        setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
      }
    });
    pre.style.position = 'relative';
    pre.appendChild(btn);
  });

  return temp.innerHTML;
}

// Stores a reference to the current streaming model element for direct updates
let streamingElement = null;

function addMessage(role, text, isStreaming = false) {
  el.welcome.style.display = 'none';

  if (isStreaming && streamingElement) {
    const content = streamingElement.querySelector('.message-content');
    content.innerHTML = renderMarkdown(text) || '&nbsp;';
    scrollToBottom(true);
    return streamingElement;
  }

  const div = document.createElement('div');
  div.className = `message ${role}`;

  const avatar = document.createElement('div');
  avatar.className = 'message-avatar';
  avatar.textContent = role === 'user' ? 'U' : 'G';

  const content = document.createElement('div');
  content.className = 'message-content';
  content.innerHTML = renderMarkdown(text) || '&nbsp;';

  if (role === 'user') {
    div.appendChild(content);
    div.appendChild(avatar);
  } else {
    div.appendChild(avatar);
    div.appendChild(content);
  }

  el.messages.appendChild(div);

  if (isStreaming) {
    streamingElement = div;
  }

  scrollToBottom(true);
  return div;
}

function addTypingIndicator() {
  const div = document.createElement('div');
  div.className = 'typing-indicator';
  div.id = 'typingIndicator';

  const avatar = document.createElement('div');
  avatar.className = 'message-avatar';
  avatar.textContent = 'G';

  const dots = document.createElement('div');
  dots.className = 'typing-dots';
  dots.innerHTML = '<span></span><span></span><span></span>';

  div.appendChild(avatar);
  div.appendChild(dots);
  el.messages.appendChild(div);
  scrollToBottom(true);
}

function removeTypingIndicator() {
  document.getElementById('typingIndicator')?.remove();
}

function showError(message) {
  const div = document.createElement('div');
  div.className = 'error-banner';
  div.textContent = message;
  el.messages.appendChild(div);
  scrollToBottom(true);
}

function addWarning(text) {
  const lastMsg = el.messages.querySelector('.message.model:last-child .message-content');
  if (lastMsg) {
    const badge = document.createElement('div');
    badge.className = 'warning-badge';
    badge.textContent = text;
    lastMsg.appendChild(badge);
  }
}

// Detect if message contains file references the model can't handle
function hasUnsupportedContent(text) {
  const imageExtensions = /\.(png|jpg|jpeg|gif|bmp|webp|svg|ico|tiff?|avif)\b/i;
  const filePatterns = [
    /(^|\s)([\w\-./\\]+\.(png|jpg|jpeg|gif|bmp|webp|svg|ico|tiff?|avif))/i,
    /\b(attach(ment)?|upload|image|photo|picture|screenshot)\b/i,
  ];
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (imageExtensions.test(trimmed) || filePatterns[0].test(trimmed)) {
      return trimmed;
    }
  }
  return null;
}

async function sendMessage() {
  const text = el.input.value.trim();
  if (!text || state.isStreaming) return;

  el.input.value = '';
  el.input.style.height = 'auto';
  el.sendBtn.disabled = true;

  // Check for unsupported content before calling API
  const unsupportedFile = hasUnsupportedContent(text);
  if (unsupportedFile) {
    showError(`"${unsupportedFile}" looks like a file reference. This model only supports text input. Please remove file attachments and paste the text content directly.`);
    state.isStreaming = false;
    el.sendBtn.disabled = false;
    return;
  }

  if (!state.currentId) {
    state.currentId = generateId();
    state.conversations.unshift({
      id: state.currentId,
      title: text.slice(0, 50) + (text.length > 50 ? '...' : ''),
      timestamp: formatTimestamp(),
      messages: [],
    });
    saveState();
    renderHistory();
  }

  const chat = getCurrentChat();
  if (!chat) return;

  // Add user message to both UI and history
  chat.messages.push({ role: 'user', text });
  // Update title from the first user message
  if (chat.messages.filter((m) => m.role === 'user').length === 1) {
    chat.title = text.slice(0, 50) + (text.length > 50 ? '...' : '');
  }
  addMessage('user', text);
  saveState();
  renderHistory();

  addTypingIndicator();
  state.isStreaming = true;
  streamingElement = null;

  const contents = [];
  for (const msg of chat.messages) {
    if (msg.role === 'system') continue;
    contents.push({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.text }],
    });
  }

  let fullText = '';

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: 'Unknown error' }));
      removeTypingIndicator();
      state.isStreaming = false;

      // Roll back the user message so conversation history stays valid
      chat.messages.pop();
      if (chat.messages.length === 0) {
        state.conversations = state.conversations.filter((c) => c.id !== state.currentId);
        state.currentId = null;
      }
      saveState();
      renderHistory();

      if (!state.currentId) {
        state.currentId = generateId();
        state.conversations.unshift({
          id: state.currentId,
          title: 'New chat',
          timestamp: formatTimestamp(),
          messages: [],
        });
        saveState();
        renderHistory();
      }

      // Load the UI for the current conversation
      loadChat(state.currentId);

      showError(err.error || `Error: ${response.status} ${response.statusText}`);
      el.sendBtn.disabled = !el.input.value.trim();
      return;
    }

    removeTypingIndicator();

    addMessage('model', '', true);
    state.isStreaming = true;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    let streamingDone = false;

    while (!streamingDone) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;

        const payload = trimmed.slice(6);
        if (payload === '[DONE]') continue;

        try {
          const data = JSON.parse(payload);

          if (data.error) {
            showError(data.error);
            continue;
          }

          if (data.text) {
            fullText += data.text;
            addMessage('model', fullText, true);
          }

          if (data.warning) {
            addWarning(data.warning);
          }

          if (data.done) {
            streamingDone = true;
            break;
          }
        } catch {
          // skip malformed data
        }
      }
    }

    // Save assistant message to history (UI already has it from streaming)
    streamingElement = null;

    if (fullText) {
      chat.messages.push({ role: 'assistant', text: fullText });
      saveState();
      renderHistory();
    }
  } catch (err) {
    removeTypingIndicator();
    streamingElement = null;
    state.isStreaming = false;

    // Roll back user message only if no response was received at all
    const chatCtx = getCurrentChat();
    if (!fullText && chatCtx && chatCtx.messages.length > 0 && chatCtx.messages[chatCtx.messages.length - 1].role === 'user') {
      chatCtx.messages.pop();
      if (chatCtx.messages.length === 0) {
        state.conversations = state.conversations.filter((c) => c.id !== state.currentId);
        state.currentId = null;
      }
      saveState();
      renderHistory();
    }

    if (!state.currentId) {
      state.currentId = generateId();
      state.conversations.unshift({
        id: state.currentId,
        title: 'New chat',
        timestamp: formatTimestamp(),
        messages: [],
      });
      saveState();
      renderHistory();
    }

    loadChat(state.currentId);
    showError('Network error. Please check your connection and try again.');
  } finally {
    state.isStreaming = false;
    el.sendBtn.disabled = !el.input.value.trim();
  }
}

el.deleteAllBtn.addEventListener('click', () => {
  if (state.isStreaming) return;
  deleteAllChats();
});

// ===== New chat =====
function newChat() {
  if (state.isStreaming) return;

  state.currentId = generateId();
  state.conversations.unshift({
    id: state.currentId,
    title: 'New chat',
    timestamp: formatTimestamp(),
    messages: [],
  });
  saveState();
  renderHistory();
  loadChat(state.currentId);
}

el.newChatBtn.addEventListener('click', newChat);

// ===== Delete chat =====
function deleteChat(id) {
  if (state.isStreaming) return;

  const idx = state.conversations.findIndex((c) => c.id === id);
  if (idx === -1) return;

  state.conversations.splice(idx, 1);

  if (id === state.currentId) {
    state.currentId = state.conversations.length > 0
      ? state.conversations[Math.min(idx, state.conversations.length - 1)].id
      : null;
  }

  saveState();
  renderHistory();

  if (!state.currentId) {
    state.currentId = generateId();
    state.conversations.unshift({
      id: state.currentId,
      title: 'New chat',
      timestamp: formatTimestamp(),
      messages: [],
    });
    saveState();
    renderHistory();
  }

  loadChat(state.currentId);
}

// ===== Delete all chats =====
function deleteAllChats() {
  if (state.isStreaming) return;

  state.conversations = [];
  state.currentId = null;
  saveState();

  state.currentId = generateId();
  state.conversations.unshift({
    id: state.currentId,
    title: 'New chat',
    timestamp: formatTimestamp(),
    messages: [],
  });
  saveState();
  renderHistory();
  loadChat(state.currentId);
}

// ===== History =====
function renderHistory() {
  el.historyList.innerHTML = '';
  const current = state.currentId;

  for (const chat of state.conversations) {
    const item = document.createElement('div');
    item.className = 'history-item' + (chat.id === current ? ' active' : '');
    item.dataset.id = chat.id;

    const label = document.createElement('span');
    label.className = 'history-label';
    label.textContent = chat.title || 'New chat';
    label.title = chat.title;

    const delBtn = document.createElement('button');
    delBtn.className = 'history-delete';
    delBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="3 6 5 6 21 6"></polyline>
        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
      </svg>`;
    delBtn.title = 'Delete chat';

    item.appendChild(label);
    item.appendChild(delBtn);

    label.addEventListener('click', () => {
      if (state.isStreaming) return;
      streamingElement = null;
      loadChat(chat.id);
    });

    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteChat(chat.id);
    });

    el.historyList.appendChild(item);
  }
}

function loadChat(id) {
  if (state.isStreaming) return;

  state.currentId = id;
  saveState();
  renderHistory();

  const chat = getCurrentChat();
  el.messages.innerHTML = '';
  el.welcome.style.display = 'flex';

  if (chat && chat.messages.length > 0) {
    el.welcome.style.display = 'none';
    for (const msg of chat.messages) {
      addMessage(msg.role === 'assistant' ? 'model' : 'user', msg.text);
    }
    scrollToBottom(false);
  }
}

// ===== Init =====
function init() {
  if (state.currentId) {
    const exists = state.conversations.some((c) => c.id === state.currentId);
    if (!exists) state.currentId = null;
  }

  if (!state.currentId) {
    newChat();
  } else {
    loadChat(state.currentId);
  }

  renderHistory();
}

el.sendBtn.addEventListener('click', sendMessage);

init();
