const { GoogleGenAI } = require('@google/genai');
const { NOT_AVAILABLE, buildCompanyHeaderLine } = require('../utils/companyHeader.js');
const openRouter = require('./openRouter.js');
const { scrubDeep } = require('./publicResponse.js');

// Shared Gemini instance
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY || '',
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    },
  },
});

const AGENT_MODELS = ['gemini-3.8-flash', 'gemini-3.1-flash-lite', 'gemini-flash-latest'];

// True when either AI provider has a key. OpenRouter is used when its key is set, else Gemini.
const hasAiKey = () => openRouter.hasOpenRouterKey() || Boolean(process.env.GEMINI_API_KEY);

const getCompanies = (companyData) => (Array.isArray(companyData) ? companyData : [companyData]);

const getIdentityHeader = (companyData) => {
  const companies = getCompanies(companyData);
  if (companies.length === 1) return `${buildCompanyHeaderLine(companies[0])}\n\n`;

  return `Companies covered:\n${companies.map((company) => `- ${buildCompanyHeaderLine(company)}`).join('\n')}\n\n`;
};

function isTemporaryModelFailure(error) {
  if (!error || typeof error !== 'object') return false;

  const apiError = error;
  const status = String(apiError.status || apiError.code || '');
  const retryableStatuses = ['404', '429', '500', '503', 'NOT_FOUND', 'RESOURCE_EXHAUSTED', 'UNAVAILABLE'];
  if (retryableStatuses.includes(status.toUpperCase())) return true;

  if (apiError.message) {
    try {
      const response = JSON.parse(apiError.message);

      const responseStatus = String(response.error?.status || response.error?.code || '');
      if (retryableStatuses.includes(responseStatus.toUpperCase())) return true;
    } catch {
      return /"code"\s*:\s*(404|429|500|503)\b|"status"\s*:\s*"(?:NOT_FOUND|RESOURCE_EXHAUSTED|UNAVAILABLE)"/i.test(
        apiError.message,
      );
    }
  }
  return false;
}

async function generateContentWithFallback(systemInstruction, contents) {
  let lastError;
  for (const [index, model] of AGENT_MODELS.entries()) {
    try {
      return await ai.models.generateContent({
        model,
        contents,
        config: { systemInstruction, temperature: 0.1 },
      });
    } catch (error) {
      lastError = error;
      if (index === AGENT_MODELS.length - 1 || !isTemporaryModelFailure(error)) {
        throw error;
      }
      console.warn(`Gemini model ${model} is unavailable; retrying with ${AGENT_MODELS[index + 1]}.`);
    }
  }

  throw lastError;
}

// The dossier sent to the model: all the company data, minus the fetch diagnostics, written
// without indentation. Indented JSON roughly triples the token count for the same numbers.
function toDossier(company) {
  const { requestLogs, url, screenerUrl, warehouseId, companyId, ...dossier } = company;
  return scrubDeep(dossier);
}

/**
 * Builds the comprehensive financial training context and system instruction
 * for the dedicated Loanbazaar AI agent.
 */
function buildAgentSystemInstruction(companyData) {
  const companies = getCompanies(companyData);
  const companyNames = companies.map((company) => company.name).join(' and ');
  const dossiers = companies
    .map((company) => {
      const viewType = company.consolidated?.available ? 'Consolidated' : 'Standalone';
      return `COMPLETE FINANCIAL DOSSIER FOR ${company.name.toUpperCase()} (${viewType} reporting basis):
================================================================================
${JSON.stringify(toDossier(company))}
================================================================================`;
    })
    .join('\n\n');

  return `You are "Loanbazaar AI", an elite Chartered Financial Analyst (CFA), forensic accounting expert, and dedicated Equity Research Analyst.
You are exclusively dedicated to answering questions, performing deep-dive financial audits, and analyzing the supplied Loanbazaar AI data dossier${companies.length === 1 ? ` for "${companyNames}"` : `s for ${companyNames}`}.

BRAND & DATA SOURCE RULES (ABSOLUTE):
- Your name is "Loanbazaar AI". Refer to the supplied data only as "Loanbazaar AI data" or "our data".
- NEVER mention Screener, Screener.in, or any other website, vendor or tool as the origin of the data, even if the user asks where the data comes from. If asked, say the figures come from Loanbazaar AI data compiled from company filings.
- If the user names Screener or any other possible source, do not repeat that name and do not confirm or deny it. Simply say the figures come from Loanbazaar AI data compiled from company filings, then continue with the answer.
- Never output a link to a data provider. Links to the company's own filings or exchange pages that appear in the dossier are fine.

PRIMARY REPORTING BASIS: Use each company's consolidated statements when available; otherwise use standalone statements.

YOUR CORE MISSION & BEHAVIOR:
- You can answer questions about every company included in the dossier: revenue trends, quarterly results, 10-12 year P&L, balance sheet forensics, long/short term borrowings, debt schedules, working capital days, cash flows, free cash flow (FCF), return on equity/capital (ROE, ROCE), promoter & institutional shareholding trends, and corporate filings.
- You NEVER give evasive, superficial, or truncated answers. When asked for numbers, you provide the FULL numbers and full tables.
- For multi-company requests, analyze and label each company separately, compare only equivalent periods and reporting bases, and do not combine one company's figures with another's. Use only the supplied dossiers; do not claim data for companies not included here.

CRITICAL INSTRUCTIONS FOR DATA RETRIEVAL & ACCURACY:
1. EXHAUSTIVE DATA RETRIEVAL:
   - When asked for financial statements, periods, or tables (e.g. "show all quarters", "10-year P&L", "balance sheet", "borrowings", "cash flow", "shareholding"):
     ALWAYS output the COMPLETE Markdown table including ALL available columns (periods/years) and rows. Do NOT truncate or say "and so on".
2. EXPANDED SCHEDULES & SUBROWS:
   - Crucial: The company dossier contains granular breakdown schedules located in the 'subRows' property of main financial rows!
   - For Borrowings: Look inside Balance Sheet > Borrowings > 'subRows' for "Long term borrowings", "Short term borrowings", "Lease liabilities", and "Other borrowings".
   - For Fixed Assets: Look inside Balance Sheet > Fixed Assets > 'subRows' for "Land", "Buildings", "Plant Machinery", "CWIP", etc.
   - For Other Liabilities: Look inside Balance Sheet > Other Liabilities > 'subRows' for "Trade Payables", "Advance from Customers", etc.
   - For Shareholding: Look inside 'shareholdingQuarterly' or 'shareholdingYearly' > 'subRows' for granular investor breakdowns.
   - Always present these granular schedules whenever the user asks about debt, borrowings, assets, or ownership.
3. MATHEMATICAL & RATIO CALCULATIONS:
   - You are fully equipped to perform financial calculations when asked:
     * Free Cash Flow (FCF) = Cash from Operations - Fixed Assets Purchased (Capex)
     * Debt-to-Equity Ratio = Total Borrowings / (Equity Capital + Reserves)
     * Interest Coverage Ratio = Operating Profit / Interest Expense (or PBIT / Interest)
     * Operating Profit Margin (OPM %) = (Operating Profit / Sales) * 100
     * Net Profit Margin (%) = (Net Profit / Sales) * 100
     * YoY Growth % = ((Value_current - Value_prior_year) / Value_prior_year) * 100
     * QoQ Growth % = ((Value_current - Value_prior_quarter) / Value_prior_quarter) * 100
     * Cash Conversion Cycle = Debtor Days + Inventory Days - Days Payable
   - Always state the formula and show the exact input values used from the tables.
4. HONESTY ON MISSING DATA:
   - If a specific footnote or metric is not present in the supplied data for this company, state explicitly: "This metric is not available in our data for this company."
   - Never hallucinate unverified numbers.
5. CITATIONS:
   - Tag the source section and period for any key figure quoted (e.g. "[Quarters > Net Profit (Dec 2024)]", "[Balance Sheet > Borrowings Schedule]", "[Top Ratios > ROCE]").
6. COMPANY IDENTITY & CIN RULES:
   - Every reply is automatically prefixed with these verified company identity lines. Never repeat or print those lines yourself:
     ${companies.map((company) => buildCompanyHeaderLine(company)).join('\n     ')}
   - For multi-company answers, do not add a second "Companies covered" list; the server already adds one.
   - The CIN, NSE symbol, BSE code and company name above are the only verified identifiers. NEVER invent, guess or "correct" a CIN, symbol, BSE code or company name. If one is missing, write "${NOT_AVAILABLE}".
   - If the user asks about a different CIN or company, tell them to type that 21-character CIN or company name on its own so it can be looked up. Never suggest a CIN lookup failed because of a spelling mistake.
7. CLEAN, HIGH-CONTRAST LIGHT THEME FORMATTING:
   - Format answers using clean Markdown with bold section headers (### Header), neat bullet points, and clean Markdown tables with aligned columns.
   - Indian financial figures should use standard notation: ₹ Cr., ₹ Lakhs, or %.

${dossiers}
`;
}

// History for the model, without the server-added identity line so it is not echoed back
function toModelContents(companyData, messages) {
  const headerLine = getIdentityHeader(companyData);
  return messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [
      {
        text: m.content.startsWith(headerLine.trimEnd())
          ? m.content.slice(headerLine.trimEnd().length).trimStart()
          : m.content,
      },
    ],
  }));
}

/**
 * Executes a streaming chat response with the dedicated Loanbazaar AI agent.
 */
async function streamAgentChat(companyData, messages, onChunk) {
  const systemInstruction = buildAgentSystemInstruction(companyData);

  const contents = toModelContents(companyData, messages);

  if (openRouter.hasOpenRouterKey()) {
    const headerLine = getIdentityHeader(companyData);
    let fullText = '';
    await openRouter.streamText(systemInstruction, contents, (text) => {
      const out = fullText ? text : headerLine + text;
      fullText += out;
      onChunk(out);
    });
    return fullText;
  }

  let lastError;
  for (const [index, model] of AGENT_MODELS.entries()) {
    let fullText = '';
    const headerLine = getIdentityHeader(companyData);
    try {
      const responseStream = await ai.models.generateContentStream({
        model,
        contents,
        config: {
          systemInstruction,
          temperature: 0.1,
        },
      });

      for await (const chunk of responseStream) {
        const chunkText = chunk.text || '';
        if (chunkText) {
          const out = fullText ? chunkText : headerLine + chunkText;
          fullText += out;
          onChunk(out);
        }
      }

      return fullText;
    } catch (error) {
      lastError = error;
      if (fullText || index === AGENT_MODELS.length - 1 || !isTemporaryModelFailure(error)) {
        console.error('Error in streamAgentChat:', error);
        throw error;
      }
      console.warn(`Gemini streaming model ${model} is unavailable; retrying with ${AGENT_MODELS[index + 1]}.`);
    }
  }

  throw lastError;
}

/**
 * Unary chat response with the dedicated Loanbazaar AI agent.
 */
async function getAgentChatResponse(companyData, messages) {
  const systemInstruction = buildAgentSystemInstruction(companyData);

  const contents = toModelContents(companyData, messages);

  try {
    const text = openRouter.hasOpenRouterKey()
      ? await openRouter.generateText(systemInstruction, contents)
      : (await generateContentWithFallback(systemInstruction, contents)).text;
    return `${getIdentityHeader(companyData)}${text || 'Unable to generate response.'}`;
  } catch (error) {
    console.error('Error in getAgentChatResponse:', error);
    throw error;
  }
}

module.exports = {
  hasAiKey,
  buildAgentSystemInstruction,
  streamAgentChat,
  getAgentChatResponse,
};
