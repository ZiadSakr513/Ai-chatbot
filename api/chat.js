const MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { messages, systemInstruction } = req.body;

  if (!process.env.GROQ_API_KEY) {
    return res.status(500).json({ error: 'Groq API key is not configured. Add GROQ_API_KEY to your Vercel environment variables.' });
  }

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Invalid request: messages array is required' });
  }

  const groqMessages = [];
  if (systemInstruction) {
    groqMessages.push({ role: 'system', content: systemInstruction });
  }
  for (const msg of messages) {
    groqMessages.push({ role: msg.role, content: msg.content });
  }

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: groqMessages,
        stream: true,
        temperature: 0.7,
        max_tokens: 8192,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      const status = response.status;

      let message;
      try {
        const errJson = JSON.parse(errorText);
        message = errJson.error?.message || errJson.message;
      } catch {
        message = null;
      }

      if (!message) {
        if (status === 400) message = 'Bad request - please check your input.';
        else if (status === 401 || status === 403) message = 'Invalid API key. Check GROQ_API_KEY in Vercel env vars.';
        else if (status === 429) message = 'Rate limit exceeded. Please wait and try again.';
        else if (status >= 500) message = 'Groq API server error. Please try again later.';
        else message = `API error (${status}): ${response.statusText}`;
      }

      return res.status(status).json({ error: message, detail: errorText });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const sendEvent = (data) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const processBuffer = () => {
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;

        const payload = trimmed.slice(6);
        if (payload === '[DONE]') continue;

        try {
          const parsed = JSON.parse(payload);
          const choice = parsed.choices?.[0];
          const text = choice?.delta?.content || '';

          if (text) {
            sendEvent({ text });
          }

          if (choice?.finish_reason && choice.finish_reason !== 'null' && choice.finish_reason !== null && choice.finish_reason !== 'stop') {
            sendEvent({ warning: `Response ${choice.finish_reason.toLowerCase()}. It may be incomplete.` });
          }
        } catch {
          // skip malformed SSE data
        }
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          if (buffer.trim()) processBuffer();
          sendEvent({ done: true });
          res.end();
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        processBuffer();
      }
    } catch (streamError) {
      sendEvent({ error: 'Connection lost. Please try again.' });
      res.end();
    }
  } catch (error) {
    if (!res.headersSent) {
      return res.status(502).json({ error: 'Network error - cannot reach Groq API. Check your internet connection.' });
    }
    res.write(`data: ${JSON.stringify({ error: 'Network error - response may be incomplete.' })}\n\n`);
    res.end();
  }
};
