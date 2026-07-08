const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

app.post('/api/chat', async (req, res) => {
  const { contents, systemInstruction } = req.body;

  if (!API_KEY) {
    return res.status(500).json({ error: 'Gemini API key is not configured. Add GEMINI_API_KEY to your .env file.' });
  }

  if (!contents || !Array.isArray(contents) || contents.length === 0) {
    return res.status(400).json({ error: 'Invalid request: contents array is required' });
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:streamGenerateContent?alt=sse&key=${API_KEY}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        systemInstruction: systemInstruction
          ? { parts: [{ text: systemInstruction }] }
          : undefined,
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
        ],
        generationConfig: {
          temperature: 0.9,
          topP: 0.95,
          topK: 40,
          maxOutputTokens: 8192,
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      const status = response.status;

      // Try to extract the actual Gemini error message
      let message;
      try {
        const errJson = JSON.parse(errorText);
        message = errJson.error?.message || errJson.message;
      } catch {
        message = null;
      }

      if (!message) {
        if (status === 400) message = 'Bad request - please check your input and try again.';
        else if (status === 401 || status === 403) message = 'Invalid API key. Please check your GEMINI_API_KEY in .env.';
        else if (status === 429) message = 'Rate limit exceeded. Please wait a moment and try again.';
        else if (status >= 500) message = 'Gemini API server error. Please try again later.';
        else message = `API error (${status}): ${response.statusText}`;
      }

      return res.status(status).json({ error: message, detail: errorText });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

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
          const candidate = parsed.candidates?.[0];
          const text = candidate?.content?.parts?.[0]?.text;
          const promptFeedback = parsed.promptFeedback;

          if (text) {
            sendEvent({ text });
          }

          if (candidate?.finishReason && candidate.finishReason !== 'STOP') {
            sendEvent({ warning: `Response ${candidate.finishReason.toLowerCase()}. It may be incomplete.` });
          }

          if (promptFeedback?.blockReason) {
            sendEvent({ error: `Prompt blocked: ${promptFeedback.blockReason}. Try rephrasing your message.` });
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
          // Flush any remaining data in the buffer
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
      return res.status(502).json({ error: 'Network error - cannot reach Gemini API. Check your internet connection.' });
    }
    res.write(`data: ${JSON.stringify({ error: 'Network error - response may be incomplete.' })}\n\n`);
    res.end();
  }
});

app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Gemini Chatbot running at http://localhost:${PORT}`);
  if (!API_KEY) {
    console.warn('WARNING: GEMINI_API_KEY not set. Copy .env.example to .env and add your key.');
  }
});
