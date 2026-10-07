// Loaded first so the API keys from a local .env file are set before the services read it
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleGenAI } = require('@google/genai');
const { getCompanyData } = require('./services/screenerService.js');
const { CompanyLookupError } = require('./services/cinResolver.js');
const { streamAgentChat, getAgentChatResponse, hasAiKey } = require('./services/agentService.js');
const openRouter = require('./services/openRouter.js');
const { toPublicCompany, toPublicFailure, scrubModelText, createStreamScrubber } = require('./services/publicResponse.js');

const app = express();
const port = process.env.PORT || 3000;

// Only the deployed frontend may call this API from a browser.
// FRONTEND_URL may list several origins separated by commas (e.g. with and without www).
const allowedOrigins = (process.env.FRONTEND_URL || '')
  .split(',')
  .map((origin) => origin.trim().replace(/\/+$/, ''))
  .filter(Boolean);
if (allowedOrigins.length === 0) {
  console.warn('FRONTEND_URL is not set: browsers on other origins will be blocked by CORS.');
}
app.use(cors({ origin: allowedOrigins }));

// One line per request, so the host's log shows what the frontend asked for and what it got
app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    console.log(
      `${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - startedAt}ms) origin=${req.headers.origin || '-'}`,
    );
  });
  next();
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Shared server-side Gemini client
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY || '',
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    },
  },
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    hasKey: hasAiKey(),
    model: openRouter.hasOpenRouterKey() ? openRouter.getOpenRouterModel() : 'gemini-3.8-flash',
  });
});

// 1. Resolve & Fetch Company Data
app.get('/api/company', async (req, res) => {
  const query = req.query.q || '';
  if (!query.trim()) {
    return res.status(400).json({ error: 'Query parameter "q" is required.' });
  }

  try {
    const data = await getCompanyData(query, req.query.cin || undefined);
    return res.json(toPublicCompany(data));
  } catch (error) {
    // The browser gets a generic reason; the real one stays in this log
    if (error instanceof CompanyLookupError) {
      console.warn(`Company lookup failed for "${query}": [${error.code}] ${error.message}`);
      const failure = toPublicFailure(error);
      return res.status(failure.status).json(failure.body);
    }
    console.error(`Error fetching company "${query}":`, error);
    const failure = toPublicFailure(error);
    return res.status(failure.status).json(failure.body);
  }
});

async function generateWithFallback(contents) {
  if (openRouter.hasOpenRouterKey()) {
    return openRouter.generateText('', [{ role: 'user', parts: [{ text: contents }] }]);
  }
  try {
    const res = await ai.models.generateContent({
      model: 'gemini-3.1-flash-lite',
      contents,
    });
    return res.text || '';
  } catch (err) {
    console.warn('gemini-3.1-flash-lite call failed, trying gemini-flash-latest:', err.message);
    const fallbackRes = await ai.models.generateContent({
      model: 'gemini-flash-latest',
      contents,
    });
    return fallbackRes.text || '';
  }
}

// 2. Dedicated AI Agent Streaming Chat (SSE)
app.post('/api/agent/stream', async (req, res) => {
  const { messages, companyData } = req.body;
  const companies = Array.isArray(companyData) ? companyData : [companyData];

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Messages array is required.' });
  }
  if (companies.length === 0 || companies.length > 4 || companies.some((company) => !company?.name)) {
    return res.status(400).json({ error: 'One to four company data dossiers are required.' });
  }
  if (!hasAiKey()) {
    return res.status(500).json({ error: 'No AI key is configured. Set OPENROUTER_API_KEY or GEMINI_API_KEY.' });
  }

  // Set SSE Headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  try {
    const scrubber = createStreamScrubber((chunk) => {
      res.write(`data: ${JSON.stringify({ chunk })}\n\n`);
    });
    await streamAgentChat(companyData, messages, (chunk) => scrubber.push(chunk));
    scrubber.flush();

    res.write(`data: [DONE]\n\n`);
    res.end();
  } catch (error) {
    console.error('Agent streaming error:', error);
    res.write(`data: ${JSON.stringify({ error: scrubModelText(error.message) || 'Streaming failed' })}\n\n`);
    res.end();
  }
});

// 3. Dedicated AI Agent Unary Chat
app.post('/api/agent/chat', async (req, res) => {
  const { messages, companyData } = req.body;
  const companies = Array.isArray(companyData) ? companyData : [companyData];

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Messages array is required.' });
  }
  if (companies.length === 0 || companies.length > 4 || companies.some((company) => !company?.name)) {
    return res.status(400).json({ error: 'One to four company data dossiers are required.' });
  }
  if (!hasAiKey()) {
    return res.status(500).json({ error: 'No AI key is configured. Set OPENROUTER_API_KEY or GEMINI_API_KEY.' });
  }

  try {
    const answer = await getAgentChatResponse(companyData, messages);
    return res.json({ answer: scrubModelText(answer) });
  } catch (error) {
    console.error('Agent chat error:', error);
    return res.status(500).json({ error: scrubModelText(error.message) || 'Failed to generate answer from agent.' });
  }
});

// 4. Backward compatible Grounded Q&A Box
app.post('/api/ask', async (req, res) => {
  const { question, companyData } = req.body;
  if (!question || !question.trim()) {
    return res.status(400).json({ error: 'Question is required.' });
  }
  if (!companyData || !companyData.name) {
    return res.status(400).json({ error: 'Company data is required.' });
  }

  if (!hasAiKey()) {
    return res.status(500).json({ error: 'No AI key is configured. Set OPENROUTER_API_KEY or GEMINI_API_KEY.' });
  }

  try {
    const answer = await getAgentChatResponse(companyData, [{ role: 'user', content: question.trim() }]);
    return res.json({ answer: scrubModelText(answer) || 'Not available in the fetched data.' });
  } catch (error) {
    console.error('Gemini Q&A error:', error);
    return res.status(500).json({ error: scrubModelText(error.message) || 'Failed to generate answer.' });
  }
});

// 3. Short Financial Summary
app.post('/api/summary', async (req, res) => {
  const { companyData } = req.body;
  if (!companyData || !companyData.name) {
    return res.status(400).json({ error: 'Company data is required.' });
  }

  if (!hasAiKey()) {
    return res.json({ summary: '' });
  }

  try {
    const prompt = `You are "Loanbazaar AI", a concise equity research analyst.
Review this company data for "${companyData.name}" (${companyData.symbol || ''}).
Provide a crisp 3-bullet summary focusing strictly on:
- Valuation & Size (Market Cap, P/E, ROCE/ROE)
- Recent Performance (Sales & Profit trends from latest Quarters/P&L)
- Key Strength / Concern (from Pros/Cons or Debt/Cash)

STRICT RULES:
- Use ONLY the numbers from the JSON.
- Refer to the data only as "Loanbazaar AI data" or "our data". Never mention Screener, Screener.in or any other data provider or website.
- Never invent or estimate numbers.
- If data is missing for a point, state "Not available in the data".
- Return 3 short bullet points, each starting with a bullet marker (•).

DATA:
${JSON.stringify({
  name: companyData.name,
  symbol: companyData.symbol,
  topRatios: companyData.topRatios,
  pros: companyData.pros,
  cons: companyData.cons,
  quarters: companyData.consolidated?.quarters || companyData.standalone?.quarters,
  profitAndLoss: companyData.consolidated?.profitAndLoss || companyData.standalone?.profitAndLoss,
}).slice(0, 30000)}
`;

    const summary = await generateWithFallback(prompt);
    return res.json({ summary: scrubModelText(summary) });
  } catch (error) {
    console.error('Gemini summary error:', error);
    return res.json({ summary: '' });
  }
});

// Simple liveness check for the hosting platform
app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
