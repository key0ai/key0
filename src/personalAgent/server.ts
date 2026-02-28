import express from "express";
import crypto from "crypto";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import { ClientFactory } from "@a2a-js/sdk/client";
import { Message, AgentCard, AGENT_CARD_PATH } from "@a2a-js/sdk";
import { GoogleGenerativeAI, Content } from "@google/generative-ai";
import { CHAIN, payNative } from "../shared/baseConfig.js";

const PERSONAL_AGENT_ID = "personal-agent-1";

// Directory of known agents (In reality, this would be a decentralized registry or search)
const KNOWN_AGENTS = [
  { 
    name: "Photo Service", 
    description: "Provides paid access to photo albums. Use this for retrieving photos, images, or albums.", 
    url: "http://localhost:4001" 
  },
  // Placeholder for future agents
  // { name: "Weather Service", description: "Provides weather forecasts", url: "http://localhost:4002" }
];

// Initialize Google Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

const app = express();
app.use(express.json());

// Helper to extract JSON from markdown or text
function extractJson(text: string): any | null {
  try {
    return JSON.parse(text);
  } catch (e) {
    const match = text.match(/```json\s*([\s\S]*?)\s*```/) || text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[1] || match[0]);
      } catch (e2) {
        return null;
      }
    }
    return null;
  }
}

app.post("/execute-task", async (req, res) => {
  console.log(`[PersonalAgent] Received task:`, req.body);
  const { goal } = req.body; 

  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: "Missing GEMINI_API_KEY env var" });
  }

  try {
    // 1. SELECT AGENT (Planning Phase)
    console.log(`[PersonalAgent] Planning: Selecting best agent for goal: "${goal}"`);
    
    const selectionPrompt = `
      USER GOAL: "${goal}"
      
      AVAILABLE AGENTS DIRECTORY:
      ${JSON.stringify(KNOWN_AGENTS)}
      
      INSTRUCTIONS:
      Identify which agent from the directory is best suited to satisfy the user's goal.
      Return ONLY the "url" of the selected agent.
      If no agent is suitable, return "NONE".
      Do not add markdown formatting or explanations. Just the URL string.
    `;
    
    const selectionResp = await model.generateContent(selectionPrompt);
    let targetUrl = selectionResp.response.text().trim();
    
    // Cleanup if LLM adds quotes or markdown
    targetUrl = targetUrl.replace(/`/g, "").replace(/"/g, "").trim();

    if (targetUrl === "NONE" || !targetUrl.startsWith("http")) {
      console.warn(`[PersonalAgent] No suitable agent found. LLM returned: ${targetUrl}`);
      return res.status(400).json({ error: "No suitable agent found for this task." });
    }

    console.log(`[PersonalAgent] Selected Agent: ${targetUrl}`);

    // 2. CONNECT & DISCOVER
    const factory = new ClientFactory();
    const client = await factory.createFromUrl(targetUrl);
    
    let agentCard: AgentCard;
    try {
        // Try standard location using SDK constant
        // AGENT_CARD_PATH is ".well-known/agent-card.json"
        const cardUrl = `${targetUrl}/${AGENT_CARD_PATH}`;
        const cardResp = await axios.get<AgentCard>(cardUrl);
        agentCard = cardResp.data;
        console.log(`[PersonalAgent] Connected to ${agentCard.name} and loaded capabilities.`);
    } catch (e) {
        console.warn(`Could not fetch full agent card from ${targetUrl}/${AGENT_CARD_PATH}, proceeding with minimal info...`);
        agentCard = { name: "Unknown Agent", skills: [] } as any; 
    }

    // 3. DEFINE TOOLS (Dynamic per session)
    const tools = {
      send_a2a_message: async (args: { jsonPayload: any }) => {
        console.log(`[Tool] Sending A2A Message to ${targetUrl}: ${JSON.stringify(args.jsonPayload)}`);
        const response = await client.sendMessage({
          message: {
            messageId: uuidv4(),
            role: 'user',
            parts: [{ kind: 'text', text: JSON.stringify(args.jsonPayload) }],
            kind: 'message',
          }
        }) as Message;
        const text = response.parts.find(p => p.kind === 'text')?.text || "{}";
        console.log(`[Tool] Received Response: ${text.substring(0, 100)}...`);
        return text;
      },
      pay_on_chain: async (args: { destination: string, amountEth: string }) => {
        console.log(`[Tool] Paying ${args.amountEth} ETH to ${args.destination}...`);
        const tx = await payNative(args.destination as `0x${string}`, args.amountEth);
        return JSON.stringify({ 
          status: "success", 
          txHash: tx.hash, 
          chainId: CHAIN.id,
          fromAgentId: PERSONAL_AGENT_ID 
        });
      },
      fetch_resource: async (args: { url: string, apiKey: string }) => {
        // Fix for localhost URLs if running inside containers/different envs, though for local dev it's fine.
        console.log(`[Tool] Fetching resource from ${args.url}...`);
        const resp = await axios.get(args.url, {
          headers: { Authorization: `Bearer ${args.apiKey}` }
        });
        return JSON.stringify(resp.data);
      },
      finish: async (args: any) => {
        return "FINISHED";
      }
    };

    // 4. EXECUTION LOOP
    const prompt = `
      You are an autonomous agent (ID: ${PERSONAL_AGENT_ID}).
      USER GOAL: "${goal}"
      
      CURRENT SITUATION:
      - You have connected to a remote agent at ${targetUrl}.
      - Remote Agent Card: ${JSON.stringify(agentCard)}
      - Your Chain ID: ${CHAIN.id}
      
      INSTRUCTIONS:
      1. Review the Agent Card's "skills" to understand the API.
      2. Interact with the agent using 'send_a2a_message'. The payload MUST be valid JSON matching the agent's expected schema (e.g. RequestPhotoAccess, PaymentProof).
      3. If asked to pay (X402Challenge), use 'pay_on_chain'.
      4. If you get an API key, use 'fetch_resource' to get the actual data.
      5. Once you have the final result (e.g. photos, data), use the 'finish' tool to return it to the user.
      
      AVAILABLE TOOLS (Respond with JSON):
      { "tool": "send_a2a_message", "args": { "jsonPayload": { ... } } }
      { "tool": "pay_on_chain", "args": { "destination": "0x...", "amountEth": "..." } }
      { "tool": "fetch_resource", "args": { "url": "...", "apiKey": "..." } }
      { "tool": "finish", "args": { "result": ... } }
    `;

    let history: Content[] = [
      { role: "user", parts: [{ text: prompt }] }
    ];

    let steps = 0;
    while (steps < 15) {
      steps++;
      console.log(`[Agent Loop] Step ${steps}...`);
      
      const result = await model.generateContent({ contents: history });
      const text = result.response.text();
      console.log(`[Agent Thought] ${text}`);

      const action = extractJson(text);
      
      if (!action || !action.tool) {
        console.log("[Agent Loop] Invalid JSON, asking for retry...");
        history.push({ role: "model", parts: [{ text }] });
        history.push({ role: "user", parts: [{ text: "Invalid JSON. Please respond with ONLY a JSON tool call." }] });
        continue;
      }

      if (action.tool === "finish") {
        return res.json({ status: "success", result: action.args });
      }

      let toolOutput = "";
      try {
        if (action.tool === "send_a2a_message") toolOutput = await tools.send_a2a_message(action.args);
        else if (action.tool === "pay_on_chain") toolOutput = await tools.pay_on_chain(action.args);
        else if (action.tool === "fetch_resource") toolOutput = await tools.fetch_resource(action.args);
        else toolOutput = "Error: Unknown tool name";
      } catch (err: any) {
        console.error("Tool Execution Error:", err);
        toolOutput = `Error executing tool: ${err.message}`;
      }

      history.push({ role: "model", parts: [{ text: JSON.stringify(action) }] });
      history.push({ role: "user", parts: [{ text: `TOOL OUTPUT: ${toolOutput}` }] });
    }

    return res.status(500).json({ error: "Agent loop limit reached" });

  } catch (err: any) {
    console.error(`[PersonalAgent] Error:`, err);
    return res.status(500).json({ error: err.message || "Unknown error" });
  }
});

app.post("/a2a/receive", (_req, res) => {
  return res.json({ ok: true });
});

app.listen(4000, () => {
  console.log("PersonalAgent listening on :4000");
});
