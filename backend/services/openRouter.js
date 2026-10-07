// OpenRouter (https://openrouter.ai) client, used instead of the Gemini API when
// OPENROUTER_API_KEY is set. OpenRouter speaks the OpenAI chat-completions format.

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'google/gemini-3.8-flash';

const hasOpenRouterKey = () => Boolean(process.env.OPENROUTER_API_KEY);
// OPENROUTER_MODEL may list up to three models separated by commas: OpenRouter tries them in
// order and moves to the next when one is unavailable or rate limited
const getOpenRouterModels = () =>
  (process.env.OPENROUTER_MODEL || DEFAULT_MODEL)
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean)
    .slice(0, 3);
const getOpenRouterModel = () => getOpenRouterModels()[0];
// Longest answer to ask for. OpenRouter checks that the account can pay for this many tokens
// before it starts, so leaving it unset fails on accounts with few credits.
const getMaxTokens = () => parseInt(process.env.OPENROUTER_MAX_TOKENS, 10) || 8000;

// Gemini-style contents ({ role: 'model' | 'user', parts: [{ text }] }) -> OpenAI-style messages
function toChatMessages(systemInstruction, contents) {
  const messages = systemInstruction ? [{ role: 'system', content: systemInstruction }] : [];
  for (const item of contents) {
    messages.push({
      role: item.role === 'model' ? 'assistant' : 'user',
      content: item.parts.map((part) => part.text).join(''),
    });
  }
  return messages;
}

// Shortest answer still worth asking for when credits are nearly gone
const MIN_AFFORDABLE_TOKENS = 500;

async function requestCompletion(systemInstruction, contents, stream, maxTokens = getMaxTokens()) {
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'X-Title': 'Loanbazaar AI Financial Data Extractor',
    },
    body: JSON.stringify({
      models: getOpenRouterModels(),
      messages: toChatMessages(systemInstruction, contents),
      temperature: 0.1,
      max_tokens: maxTokens,
      stream,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    let detail = body.slice(0, 300);
    try {
      detail = JSON.parse(body).error?.message || detail;
    } catch {
      // not JSON: keep the raw text
    }

    // Low credits: OpenRouter says how long an answer the balance still covers, so ask for that
    const affordable = parseInt((detail.match(/can only afford (\d+)/) || [])[1], 10);
    if (res.status === 402 && affordable >= MIN_AFFORDABLE_TOKENS && affordable < maxTokens) {
      console.warn(`OpenRouter credits are low; retrying with max_tokens=${affordable}.`);
      return requestCompletion(systemInstruction, contents, stream, affordable);
    }
    if (res.status === 402) {
      throw new Error(
        'Your OpenRouter account is out of credits. Add credits at https://openrouter.ai/settings/credits ' +
          `or choose a cheaper model with OPENROUTER_MODEL. (OpenRouter said: ${detail})`,
      );
    }
    throw new Error(`OpenRouter request failed (HTTP ${res.status}): ${detail}`);
  }
  return res;
}

// One complete answer
async function generateText(systemInstruction, contents) {
  const res = await requestCompletion(systemInstruction, contents, false);
  const data = await res.json();
  if (data.error) throw new Error(`OpenRouter error: ${data.error.message || 'unknown error'}`);
  return data.choices?.[0]?.message?.content || '';
}

// Streamed answer: onText is called with each piece of text as it arrives
async function streamText(systemInstruction, contents, onText) {
  const res = await requestCompletion(systemInstruction, contents, true);
  const decoder = new TextDecoder();
  let buffer = '';

  const handleLine = (line) => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    const event = JSON.parse(payload);
    if (event.error) throw new Error(`OpenRouter error: ${event.error.message || 'unknown error'}`);
    const text = event.choices?.[0]?.delta?.content;
    if (text) onText(text);
  };

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) handleLine(line.trim());
  }
  if (buffer.trim()) handleLine(buffer.trim());
}

module.exports = {
  hasOpenRouterKey,
  getOpenRouterModel,
  generateText,
  streamText,
};
